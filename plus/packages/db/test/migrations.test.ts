import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, migrate } from "../src/index.js";
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
           'execution_session', 'execution_projection', 'audit_entry'
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
});
