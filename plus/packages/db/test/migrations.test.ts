import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, migrate, migrateTo } from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_migrate_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

describe.skipIf(!connectionString)("migration 0002 on PostgreSQL", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("creates the execution runtime tables", async () => {
    const result = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
       where table_schema = current_schema()
         and table_name in (
           'definition_draft', 'definition_compiled', 'definition_release',
           'execution_session', 'execution_projection', 'audit_entry',
           'local_account', 'local_session', 'registration', 'roster', 'material'
         )
       order by table_name
    `.execute(db);
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "audit_entry",
      "definition_compiled",
      "definition_draft",
      "definition_release",
      "execution_projection",
      "execution_session",
      "local_account",
      "local_session",
      "material",
      "registration",
      "roster",
    ]);
  });

  it("adds the hardening columns", async () => {
    const result = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name
        from information_schema.columns
       where table_schema = current_schema()
         and (
           (table_name = 'definition_release'
            and column_name in ('execution_policy', 'capability_versions', 'bindings'))
           or (table_name = 'execution_projection'
               and column_name in ('status', 'blocked_sequence', 'blocked_reason'))
           or (table_name in ('outbox', 'command_receipt')
               and column_name in ('actor_id', 'actor_type'))
         )
       order by table_name, column_name
    `.execute(db);
    expect(result.rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
      "command_receipt.actor_id",
      "command_receipt.actor_type",
      "definition_release.bindings",
      "definition_release.capability_versions",
      "definition_release.execution_policy",
      "execution_projection.blocked_reason",
      "execution_projection.blocked_sequence",
      "execution_projection.status",
      "outbox.actor_id",
      "outbox.actor_type",
    ]);
  });

  it("creates local account and session authority columns", async () => {
    const result = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name
        from information_schema.columns
       where table_schema = current_schema()
         and (
           (table_name = 'local_account'
            and column_name in ('username', 'password_digest', 'actor_id', 'permissions', 'active'))
           or (table_name = 'local_session'
               and column_name in ('token', 'actor_id', 'expires_at', 'revoked_at'))
         )
       order by table_name, column_name
    `.execute(db);
    expect(result.rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
      "local_account.active",
      "local_account.actor_id",
      "local_account.password_digest",
      "local_account.permissions",
      "local_account.username",
      "local_session.actor_id",
      "local_session.expires_at",
      "local_session.revoked_at",
      "local_session.token",
    ]);
  });

  it("is idempotent", async () => {
    const result = await migrate(db);
    expect(result.error).toBeUndefined();
  });

  it("allows only one running session per activity and scope", async () => {
    const activityId = `act-${randomUUID()}`;
    await db
      .insertInto("activity")
      .values({
        id: activityId,
        title: "Migration test",
        status: "active",
        revision: 1,
        enabled_capabilities: JSON.stringify([]),
        active_definition_version: 1,
      })
      .execute();
    await db
      .insertInto("definition_release")
      .values({
        activity_id: activityId,
        version: 1,
        content_hash: "hash",
        capabilities: JSON.stringify({}),
        execution_policy: JSON.stringify({
          declaredScopes: [],
          conflicts: {},
          runtimeContractVersion: 1,
        }),
        capability_versions: JSON.stringify({}),
        bindings: JSON.stringify([]),
        released_at: new Date().toISOString(),
        source_draft_revision: 1,
      })
      .execute();

    const session = (id: string) => ({
      id,
      activity_id: activityId,
      definition_version: 1,
      content_hash: "hash",
      scope: "stage",
      mode: "formal",
      status: "running",
      revision: 0,
      opened_at: new Date().toISOString(),
      closed_at: null,
    });

    await db.insertInto("execution_session").values(session("session-a")).execute();
    await expect(
      db.insertInto("execution_session").values(session("session-b")).execute(),
    ).rejects.toThrow();
  });

  it("restores the legacy vote identity constraint when rolling back 0011", async () => {
    const activityId = `migration-identity-${randomUUID()}`;
    await db.insertInto("activity").values({
      id: activityId,
      title: "Migration identity test",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify([]),
      active_definition_version: 1,
    }).execute();
    await migrateTo(db, "0010_m6_voting_ticketing");
    const invalidInsert = (id: string) => sql`
      insert into vote_session (
        id, activity_id, definition_version, purpose, selection_type,
        max_selections, requires_ticket, allow_browser_identity,
        scoring_rule, status, revision, opened_at, closed_at
      ) values (
        ${id}, ${activityId}, 1, 'popularity', 'single',
        1, true, true, '{"kind":"ballot_share_percent","scale":100,"decimals":2}'::jsonb,
        'open', 0, now(), null
      )
    `.execute(db);

    await expect(invalidInsert("invalid-before-0011")).rejects.toThrow();
    await migrateTo(db, "0011_voting_identity_policy");
    await migrateTo(db, "0010_m6_voting_ticketing");
    await expect(invalidInsert("invalid-after-0011-rollback")).rejects.toThrow();
  });

  it("creates the publishing tables and the single-active-release index", async () => {
    await migrate(db);
    const tables = await sql<{ table_name: string }>`
      select table_name
        from information_schema.tables
       where table_schema = current_schema()
         and table_name in ('stage_result', 'result_publication', 'result_release')
       order by table_name
    `.execute(db);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "result_publication",
      "result_release",
      "stage_result",
    ]);
    const indexes = await sql<{ indexname: string }>`
      select indexname
        from pg_indexes
       where schemaname = current_schema()
         and indexname = 'result_release_active_key'
    `.execute(db);
    expect(indexes.rows).toHaveLength(1);
  });

  it("drops publishing tables when rolling back 0012", async () => {
    await migrate(db);
    await migrateTo(db, "0011_voting_identity_policy");
    const tables = await sql<{ table_name: string }>`
      select table_name
        from information_schema.tables
       where table_schema = current_schema()
         and table_name in ('stage_result', 'result_publication', 'result_release')
    `.execute(db);
    expect(tables.rows).toHaveLength(0);
    await migrate(db);
  });

  it("creates the archive package table and current-package index", async () => {
    await migrate(db);
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
       where table_schema = current_schema() and table_name = 'archive_package'
    `.execute(db);
    expect(tables.rows).toHaveLength(1);
    const indexes = await sql<{ indexname: string }>`
      select indexname from pg_indexes
       where schemaname = current_schema() and indexname = 'archive_package_current_key'
    `.execute(db);
    expect(indexes.rows).toHaveLength(1);
  });

  it("drops the archive package table when rolling back 0013", async () => {
    await migrate(db);
    await migrateTo(db, "0012_m7_publishing");
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
       where table_schema = current_schema() and table_name = 'archive_package'
    `.execute(db);
    expect(tables.rows).toHaveLength(0);
    await migrate(db);
  });
});
