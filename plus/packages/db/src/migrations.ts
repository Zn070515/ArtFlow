import { sql, type Kysely } from "kysely";
import {
  Migrator,
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
} from "kysely/migration";

import type { Database } from "./types.js";

const migrations: Record<string, Migration> = {
  "0001_activity_receipt_outbox": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("activity")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("title", "varchar(200)", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("enabled_capabilities", "jsonb", (column) =>
          column.notNull().defaultTo(sql`'[]'::jsonb`),
        )
        .addColumn("active_definition_version", "integer", (column) =>
          column.notNull().defaultTo(0),
        )
        .execute();

      await db.schema
        .createTable("command_receipt")
        .addColumn("command_id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull())
        .addColumn("result", "jsonb", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .execute();

      await db.schema
        .createTable("outbox")
        .addColumn("id", "bigserial", (column) => column.primaryKey())
        .addColumn("event_type", "varchar(100)", (column) => column.notNull())
        .addColumn("payload", "jsonb", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addColumn("published_at", "timestamptz")
        .execute();

      await db.schema
        .createIndex("outbox_unpublished_idx")
        .on("outbox")
        .columns(["published_at", "id"])
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("outbox").ifExists().execute();
      await db.schema.dropTable("command_receipt").ifExists().execute();
      await db.schema.dropTable("activity").ifExists().execute();
    },
  },
  "0002_execution_runtime": {
    async up(db: Kysely<Database>): Promise<void> {
      // --- command receipts become replayable command claims -----------------
      await sql`alter table command_receipt add column capability varchar(100)`.execute(db);
      await sql`alter table command_receipt add column command_type varchar(100)`.execute(db);
      await sql`alter table command_receipt add column payload_hash varchar(64)`.execute(db);
      await sql`alter table command_receipt add column scope varchar(100)`.execute(db);
      await sql`alter table command_receipt add column http_status integer`.execute(db);
      await sql`alter table command_receipt alter column result drop not null`.execute(db);
      await sql`
        update command_receipt
           set capability = coalesce(capability, 'engine'),
               command_type = coalesce(command_type, 'legacy'),
               payload_hash = coalesce(payload_hash, 'legacy'),
               http_status = coalesce(http_status, 200)
         where capability is null
            or command_type is null
            or payload_hash is null
            or http_status is null
      `.execute(db);
      await sql`alter table command_receipt alter column capability set not null`.execute(db);
      await sql`alter table command_receipt alter column command_type set not null`.execute(db);
      await sql`alter table command_receipt alter column payload_hash set not null`.execute(db);

      // --- outbox becomes the immutable, replayable event log ----------------
      await sql`alter table outbox add column event_id varchar(100)`.execute(db);
      await sql`alter table outbox add column activity_id varchar(100)`.execute(db);
      await sql`alter table outbox add column aggregate_type varchar(100)`.execute(db);
      await sql`alter table outbox add column aggregate_id varchar(100)`.execute(db);
      await sql`alter table outbox add column capability varchar(100)`.execute(db);
      await sql`alter table outbox add column revision integer`.execute(db);
      await sql`alter table outbox add column mode varchar(20)`.execute(db);
      await sql`alter table outbox add column scope varchar(100)`.execute(db);
      await sql`alter table outbox add column occurred_at timestamptz`.execute(db);
      await sql`alter table outbox add column attempts integer not null default 0`.execute(db);
      await sql`alter table outbox add column last_error text`.execute(db);
      await sql`alter table outbox add column dead_lettered_at timestamptz`.execute(db);
      await sql`
        update outbox
           set event_id = 'legacy-' || id,
               activity_id = coalesce(activity_id, payload->>'activityId'),
               aggregate_type = coalesce(aggregate_type, 'activity'),
               capability = coalesce(capability, 'engine'),
               revision = coalesce(revision, 0),
               occurred_at = coalesce(occurred_at, created_at)
         where event_id is null
      `.execute(db);
      await sql`alter table outbox alter column event_id set not null`.execute(db);
      await sql`alter table outbox alter column occurred_at set not null`.execute(db);
      await sql`
        alter table outbox
          add constraint outbox_mode_check
          check (mode is null or mode in ('test', 'rehearsal', 'formal'))
      `.execute(db);
      await sql`create unique index outbox_event_id_key on outbox(event_id)`.execute(db);
      await sql`create index outbox_activity_id_idx on outbox(activity_id, id)`.execute(db);
      await sql`
        create index outbox_pending_idx on outbox(id)
         where published_at is null and dead_lettered_at is null
      `.execute(db);

      // --- definition drafts, compiled plans and releases -------------------
      await db.schema
        .createTable("definition_draft")
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.primaryKey().references("activity.id").onDelete("cascade"),
        )
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("package", "jsonb", (column) => column.notNull())
        .addColumn("updated_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .execute();

      await db.schema
        .createTable("definition_compiled")
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("draft_revision", "integer", (column) => column.notNull())
        .addColumn("content_hash", "varchar(64)", (column) => column.notNull())
        .addColumn("capabilities", "jsonb", (column) => column.notNull())
        .addColumn("compiled_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addPrimaryKeyConstraint("definition_compiled_pkey", [
          "activity_id",
          "draft_revision",
        ])
        .execute();

      await db.schema
        .createTable("definition_release")
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("version", "integer", (column) => column.notNull())
        .addColumn("content_hash", "varchar(64)", (column) => column.notNull())
        .addColumn("capabilities", "jsonb", (column) => column.notNull())
        .addColumn("released_at", "timestamptz", (column) => column.notNull())
        .addColumn("source_draft_revision", "integer", (column) => column.notNull())
        .addPrimaryKeyConstraint("definition_release_pkey", ["activity_id", "version"])
        .execute();

      // --- execution sessions ------------------------------------------------
      await db.schema
        .createTable("execution_session")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("definition_version", "integer", (column) => column.notNull())
        .addColumn("content_hash", "varchar(64)", (column) => column.notNull())
        .addColumn("scope", "varchar(100)", (column) => column.notNull())
        .addColumn("mode", "varchar(20)", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("opened_at", "timestamptz", (column) => column.notNull())
        .addColumn("closed_at", "timestamptz")
        .addForeignKeyConstraint(
          "execution_session_release_fk",
          ["activity_id", "definition_version"],
          "definition_release",
          ["activity_id", "version"],
        )
        .addCheckConstraint(
          "execution_session_mode_check",
          sql`mode in ('test', 'rehearsal', 'formal')`,
        )
        .addCheckConstraint(
          "execution_session_status_check",
          sql`status in ('running', 'closed')`,
        )
        .execute();
      await sql`
        create unique index execution_session_one_running_scope
          on execution_session(activity_id, scope)
         where status = 'running'
      `.execute(db);
      await sql`
        create index execution_session_activity_idx
          on execution_session(activity_id, opened_at)
      `.execute(db);

      // --- execution projection ---------------------------------------------
      await db.schema
        .createTable("execution_projection")
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("mode", "varchar(20)", (column) => column.notNull())
        .addColumn("last_sequence", "bigint", (column) => column.notNull().defaultTo(0))
        .addColumn("state", "jsonb", (column) => column.notNull())
        .addColumn("updated_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addPrimaryKeyConstraint("execution_projection_pkey", ["activity_id", "mode"])
        .addCheckConstraint(
          "execution_projection_mode_check",
          sql`mode in ('test', 'rehearsal', 'formal')`,
        )
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("execution_projection").ifExists().execute();
      await db.schema.dropTable("execution_session").ifExists().execute();
      await db.schema.dropTable("definition_release").ifExists().execute();
      await db.schema.dropTable("definition_compiled").ifExists().execute();
      await db.schema.dropTable("definition_draft").ifExists().execute();

      await sql`drop index if exists outbox_pending_idx`.execute(db);
      await sql`drop index if exists outbox_activity_id_idx`.execute(db);
      await sql`drop index if exists outbox_event_id_key`.execute(db);
      await sql`alter table outbox drop constraint if exists outbox_mode_check`.execute(db);
      await sql`
        alter table outbox
          drop column if exists event_id,
          drop column if exists activity_id,
          drop column if exists aggregate_type,
          drop column if exists aggregate_id,
          drop column if exists capability,
          drop column if exists revision,
          drop column if exists mode,
          drop column if exists scope,
          drop column if exists occurred_at,
          drop column if exists attempts,
          drop column if exists last_error,
          drop column if exists dead_lettered_at
      `.execute(db);

      await sql`update command_receipt set result = '{}'::jsonb where result is null`.execute(
        db,
      );
      await sql`alter table command_receipt alter column result set not null`.execute(db);
      await sql`
        alter table command_receipt
          drop column if exists capability,
          drop column if exists command_type,
          drop column if exists payload_hash,
          drop column if exists scope,
          drop column if exists http_status
      `.execute(db);
    },
  },
  "0003_runtime_hardening": {
    async up(db: Kysely<Database>): Promise<void> {
      // --- releases freeze execution semantics -----------------------------
      await sql`alter table definition_release add column execution_policy jsonb`.execute(db);
      await sql`alter table definition_release add column capability_versions jsonb`.execute(
        db,
      );
      await sql`alter table definition_release add column bindings jsonb`.execute(db);
      await sql`
        update definition_release
           set execution_policy = coalesce(
                 execution_policy,
                 '{"declaredScopes":[],"conflicts":{},"runtimeContractVersion":1}'::jsonb
               ),
               capability_versions = coalesce(capability_versions, '{}'::jsonb),
               bindings = coalesce(bindings, '[]'::jsonb)
         where execution_policy is null
            or capability_versions is null
            or bindings is null
      `.execute(db);
      await sql`
        alter table definition_release
          alter column execution_policy set not null,
          alter column capability_versions set not null,
          alter column bindings set not null
      `.execute(db);

      // --- projections can be explicitly blocked ---------------------------
      await sql`
        alter table execution_projection
          add column status varchar(20) not null default 'running',
          add column blocked_sequence bigint,
          add column blocked_reason text
      `.execute(db);
      await sql`
        alter table execution_projection
          add constraint execution_projection_status_check
          check (status in ('running', 'blocked'))
      `.execute(db);

      // --- actor on the command/event log ----------------------------------
      await sql`alter table command_receipt add column actor_id varchar(100)`.execute(db);
      await sql`alter table command_receipt add column actor_type varchar(20)`.execute(db);
      await sql`alter table outbox add column actor_id varchar(100)`.execute(db);
      await sql`alter table outbox add column actor_type varchar(20)`.execute(db);

      // --- audit is a standard by-product of an accepted command -----------
      await db.schema
        .createTable("audit_entry")
        .addColumn("id", "bigserial", (column) => column.primaryKey())
        .addColumn("command_id", "varchar(100)", (column) => column.notNull())
        .addColumn("activity_id", "varchar(100)")
        .addColumn("capability", "varchar(100)", (column) => column.notNull())
        .addColumn("command_type", "varchar(100)", (column) => column.notNull())
        .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("actor_type", "varchar(20)", (column) => column.notNull())
        .addColumn("detail", "jsonb", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .execute();
      await sql`
        create index audit_entry_activity_idx on audit_entry(activity_id, id)
      `.execute(db);
      await sql`
        create index audit_entry_command_idx on audit_entry(command_id)
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("audit_entry").ifExists().execute();
      await sql`
        alter table outbox
          drop column if exists actor_id,
          drop column if exists actor_type
      `.execute(db);
      await sql`
        alter table command_receipt
          drop column if exists actor_id,
          drop column if exists actor_type
      `.execute(db);
      await sql`
        alter table execution_projection
          drop constraint if exists execution_projection_status_check
      `.execute(db);
      await sql`
        alter table execution_projection
          drop column if exists status,
          drop column if exists blocked_sequence,
          drop column if exists blocked_reason
      `.execute(db);
      await sql`
        alter table definition_release
          drop column if exists execution_policy,
          drop column if exists capability_versions,
          drop column if exists bindings
      `.execute(db);
    },
  },
  "0004_local_sessions": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("local_account")
        .addColumn("username", "varchar(100)", (column) => column.primaryKey())
        .addColumn("password_digest", "varchar(256)", (column) => column.notNull())
        .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("actor_type", "varchar(20)", (column) => column.notNull().defaultTo("user"))
        .addColumn("roles", "jsonb", (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
        .addColumn("permissions", "jsonb", (column) =>
          column.notNull().defaultTo(sql`'[]'::jsonb`),
        )
        .addColumn("auth_context", "varchar(200)")
        .addColumn("active", "boolean", (column) => column.notNull().defaultTo(true))
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addCheckConstraint(
          "local_account_actor_type_check",
          sql`actor_type in ('user', 'service')`,
        )
        .execute();

      await db.schema
        .createTable("local_session")
        .addColumn("token", "varchar(200)", (column) => column.primaryKey())
        .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("actor_type", "varchar(20)", (column) => column.notNull())
        .addColumn("roles", "jsonb", (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
        .addColumn("permissions", "jsonb", (column) =>
          column.notNull().defaultTo(sql`'[]'::jsonb`),
        )
        .addColumn("auth_context", "varchar(200)")
        .addColumn("expires_at", "timestamptz", (column) => column.notNull())
        .addColumn("revoked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addCheckConstraint(
          "local_session_actor_type_check",
          sql`actor_type in ('user', 'service')`,
        )
        .execute();
      await sql`create index local_session_expiry_idx on local_session(expires_at)`.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("local_session").ifExists().execute();
      await db.schema.dropTable("local_account").ifExists().execute();
    },
  },
};

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

export async function migrate(db: Kysely<Database>): Promise<MigrationResultSet> {
  // Kysely otherwise discovers migration tables in *any* schema; with pooled
  // search_path-based test schemas that can pick up another schema's lock
  // table. Pin the migrator to the connection's current schema.
  const current = await sql<{ schema: string }>`select current_schema() as schema`.execute(db);
  const schema = current.rows[0]?.schema;
  const migrator = new Migrator({
    db,
    provider: new StaticMigrationProvider(),
    ...(schema === undefined ? {} : { migrationTableSchema: schema }),
  });
  const result = await migrator.migrateToLatest();
  if (result.error !== undefined) {
    throw result.error;
  }
  return result;
}
