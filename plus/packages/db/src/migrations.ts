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
  "0005_registration_materials": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("registration")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("participant_id", "varchar(100)", (column) => column.notNull())
        .addColumn("questionnaire_version", "varchar(100)", (column) => column.notNull())
        .addColumn("questionnaire_hash", "varchar(64)", (column) => column.notNull())
        .addColumn("status", "varchar(30)", (column) => column.notNull())
        .addColumn("answers", "jsonb", (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("review_note", "text", (column) => column.notNull().defaultTo(""))
        .addColumn("reviewed_by", "varchar(100)")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint(
          "registration_status_check",
          sql`status in ('draft', 'submitted', 'need_supplement', 'approved', 'rejected', 'withdrawn')`,
        )
        .execute();
      await sql`create unique index registration_activity_participant_key on registration(activity_id, participant_id)`.execute(db);
      await sql`create index registration_activity_status_idx on registration(activity_id, status)`.execute(db);

      await db.schema
        .createTable("roster")
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.primaryKey().references("activity.id").onDelete("cascade"),
        )
        .addColumn("status", "varchar(20)", (column) => column.notNull().defaultTo("unknown"))
        .addColumn("approved_count", "integer")
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("finalized_at", "timestamptz")
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("roster_status_check", sql`status in ('unknown', 'final')`)
        .addCheckConstraint(
          "roster_final_fields_check",
          sql`(status = 'unknown' and approved_count is null and finalized_at is null) or (status = 'final' and approved_count is not null and approved_count >= 0 and finalized_at is not null)`,
        )
        .execute();

      await db.schema
        .createTable("material")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("registration_id", "varchar(100)", (column) =>
          column.notNull().references("registration.id").onDelete("cascade"),
        )
        .addColumn("question_key", "varchar(100)", (column) => column.notNull())
        .addColumn("storage_key", "varchar(500)", (column) => column.notNull())
        .addColumn("original_name", "varchar(255)", (column) => column.notNull())
        .addColumn("content_type", "varchar(150)", (column) => column.notNull())
        .addColumn("byte_length", "integer", (column) => column.notNull())
        .addColumn("owner_actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("status", "varchar(30)", (column) => column.notNull().defaultTo("uploaded"))
        .addColumn("review_note", "text", (column) => column.notNull().defaultTo(""))
        .addColumn("reviewed_by", "varchar(100)")
        .addColumn("reviewed_at", "timestamptz")
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("current", "boolean", (column) => column.notNull().defaultTo(true))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("material_status_check", sql`status in ('uploaded', 'approved', 'needs_supplement')`)
        .addCheckConstraint("material_byte_length_check", sql`byte_length >= 0`)
        .execute();
      await sql`
        create unique index material_current_slot_key
          on material(registration_id, question_key)
         where current = true
      `.execute(db);
      await sql`create index material_activity_idx on material(activity_id, registration_id)`.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`drop index if exists material_activity_idx`.execute(db);
      await sql`drop index if exists material_current_slot_key`.execute(db);
      await db.schema.dropTable("material").ifExists().execute();
      await db.schema.dropTable("roster").ifExists().execute();
      await sql`drop index if exists registration_activity_status_idx`.execute(db);
      await sql`drop index if exists registration_activity_participant_key`.execute(db);
      await db.schema.dropTable("registration").ifExists().execute();
    },
  },
  "0006_competition_evaluation": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("competition_round")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_key", "varchar(100)", (column) => column.notNull())
        .addColumn("release_version", "integer", (column) => column.notNull())
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("score_version", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("minimum_judges", "integer", (column) => column.notNull())
        .addColumn("judge_count", "integer", (column) => column.notNull())
        .addColumn("completion_mode", "varchar(20)", (column) => column.notNull())
        .addColumn("advance_count", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("current_panel_id", "varchar(100)")
        .addColumn("locked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("competition_round_state_check", sql`state in ('prepared', 'scoring', 'locked')`)
        .addCheckConstraint("competition_round_judge_count_check", sql`judge_count >= 1 and minimum_judges >= 1 and minimum_judges <= judge_count`)
        .addCheckConstraint("competition_round_revision_check", sql`revision >= 0 and score_version >= 0 and advance_count >= 0`)
        .execute();
      await sql`create unique index competition_round_activity_key on competition_round(activity_id, round_key)`.execute(db);

      await db.schema
        .createTable("panel_snapshot")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_id", "varchar(100)", (column) => column.notNull().references("competition_round.id").onDelete("restrict"))
        .addColumn("version", "integer", (column) => column.notNull())
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("expected_judges", "integer", (column) => column.notNull())
        .addColumn("minimum_judges", "integer", (column) => column.notNull())
        .addColumn("roster_digest", "varchar(64)", (column) => column.notNull())
        .addColumn("context_version", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("current", "boolean", (column) => column.notNull().defaultTo(true))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("panel_snapshot_state_check", sql`state in ('active', 'hold', 'superseded')`)
        .addCheckConstraint("panel_snapshot_judge_count_check", sql`expected_judges >= 1 and minimum_judges >= 1 and minimum_judges <= expected_judges`)
        .execute();
      await sql`create unique index panel_snapshot_round_version on panel_snapshot(round_id, version)`.execute(db);
      await sql`create unique index panel_snapshot_one_current on panel_snapshot(round_id) where current = true`.execute(db);

      await db.schema
        .createTable("panel_member")
        .addColumn("panel_id", "varchar(100)", (column) => column.notNull().references("panel_snapshot.id").onDelete("restrict"))
        .addColumn("judge_id", "varchar(100)", (column) => column.notNull())
        .addColumn("seat_key", "varchar(100)", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint("panel_member_pkey", ["panel_id", "judge_id"])
        .execute();
      await sql`create unique index panel_member_seat_key on panel_member(panel_id, seat_key)`.execute(db);

      await db.schema
        .createTable("judge_seat")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("panel_id", "varchar(100)", (column) => column.notNull().references("panel_snapshot.id").onDelete("restrict"))
        .addColumn("judge_id", "varchar(100)", (column) => column.notNull())
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("judge_seat_state_check", sql`state in ('assigned', 'revoked', 'hold')`)
        .execute();
      await sql`create unique index judge_seat_panel_judge_key on judge_seat(panel_id, judge_id)`.execute(db);

      await db.schema
        .createTable("performance")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_id", "varchar(100)", (column) => column.notNull().references("competition_round.id").onDelete("restrict"))
        .addColumn("contestant_id", "varchar(100)", (column) => column.notNull())
        .addColumn("sequence", "integer", (column) => column.notNull())
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("context_version", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("performance_state_check", sql`state in ('not_opened', 'open', 'locked')`)
        .addCheckConstraint("performance_sequence_check", sql`sequence >= 1 and context_version >= 0`)
        .addUniqueConstraint("performance_round_contestant_key", ["round_id", "contestant_id"])
        .execute();

      await db.schema
        .createTable("performance_score_state")
        .addColumn("performance_id", "varchar(100)", (column) => column.primaryKey().references("performance.id").onDelete("restrict"))
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("context_version", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("opened_at", "timestamptz")
        .addColumn("locked_at", "timestamptz")
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("performance_score_state_check", sql`state in ('not_opened', 'open', 'locked') and context_version >= 0 and revision >= 0`)
        .execute();

      await db.schema
        .createTable("score_fact")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_id", "varchar(100)", (column) => column.notNull().references("competition_round.id").onDelete("restrict"))
        .addColumn("performance_id", "varchar(100)", (column) => column.notNull().references("performance.id").onDelete("restrict"))
        .addColumn("contestant_id", "varchar(100)", (column) => column.notNull())
        .addColumn("judge_id", "varchar(100)", (column) => column.notNull())
        .addColumn("panel_snapshot_id", "varchar(100)", (column) => column.notNull().references("panel_snapshot.id").onDelete("restrict"))
        .addColumn("seat_id", "varchar(100)", (column) => column.notNull().references("judge_seat.id").onDelete("restrict"))
        .addColumn("source", "varchar(20)", (column) => column.notNull())
        .addColumn("total", "numeric", (column) => column.notNull())
        .addColumn("criteria", "jsonb", (column) => column.notNull())
        .addColumn("notes", "text", (column) => column.notNull().defaultTo(""))
        .addColumn("version", "integer", (column) => column.notNull().defaultTo(1))
        .addColumn("context_version", "integer", (column) => column.notNull())
        .addColumn("current", "boolean", (column) => column.notNull().defaultTo(true))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("score_fact_source_check", sql`source in ('direct_judge', 'staff_rapid', 'staff_proxy', 'paper_dr')`)
        .addCheckConstraint("score_fact_version_check", sql`version >= 1 and context_version >= 0`)
        .execute();
      await sql`create unique index score_fact_current_key on score_fact(round_id, contestant_id, judge_id) where current = true`.execute(db);

      await db.schema
        .createTable("score_revision")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("score_fact_id", "varchar(100)", (column) => column.notNull().references("score_fact.id").onDelete("restrict"))
        .addColumn("version", "integer", (column) => column.notNull())
        .addColumn("source", "varchar(20)", (column) => column.notNull())
        .addColumn("total", "numeric", (column) => column.notNull())
        .addColumn("criteria", "jsonb", (column) => column.notNull())
        .addColumn("reason", "text", (column) => column.notNull())
        .addColumn("command_id", "varchar(100)", (column) => column.notNull())
        .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) => column.notNull())
        .addUniqueConstraint("score_revision_fact_version_key", ["score_fact_id", "version"])
        .execute();

      await db.schema
        .createTable("score_correction")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("score_fact_id", "varchar(100)", (column) => column.notNull().references("score_fact.id").onDelete("restrict"))
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("base_version", "integer", (column) => column.notNull())
        .addColumn("reason", "text", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("score_correction_state_check", sql`state in ('open', 'revised', 'closed', 'cancelled')`)
        .execute();
      await sql`create unique index score_correction_one_open on score_correction(score_fact_id) where state = 'open'`.execute(db);

      await db.schema
        .createTable("ranking_snapshot")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_id", "varchar(100)", (column) => column.notNull().references("competition_round.id").onDelete("restrict"))
        .addColumn("source_score_version", "integer", (column) => column.notNull())
        .addColumn("input_fingerprint", "varchar(64)", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("rows", "jsonb", (column) => column.notNull())
        .addColumn("tie_groups", "jsonb", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("ranking_snapshot_status_check", sql`status in ('ready', 'hold')`)
        .execute();
      await sql`create index ranking_snapshot_round_idx on ranking_snapshot(round_id, revision desc)`.execute(db);

      await db.schema
        .createTable("advancement_decision")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_id", "varchar(100)", (column) => column.notNull().references("competition_round.id").onDelete("restrict"))
        .addColumn("input_fingerprint", "varchar(64)", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("decisions", "jsonb", (column) => column.notNull())
        .addColumn("decided_by", "varchar(100)")
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("advancement_decision_status_check", sql`status in ('auto', 'needs_review', 'finalized')`)
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("advancement_decision").ifExists().execute();
      await sql`drop index if exists ranking_snapshot_round_idx`.execute(db);
      await db.schema.dropTable("ranking_snapshot").ifExists().execute();
      await sql`drop index if exists score_correction_one_open`.execute(db);
      await db.schema.dropTable("score_correction").ifExists().execute();
      await db.schema.dropTable("score_revision").ifExists().execute();
      await sql`drop index if exists score_fact_current_key`.execute(db);
      await db.schema.dropTable("score_fact").ifExists().execute();
      await db.schema.dropTable("performance_score_state").ifExists().execute();
      await db.schema.dropTable("performance").ifExists().execute();
      await sql`drop index if exists judge_seat_panel_judge_key`.execute(db);
      await db.schema.dropTable("judge_seat").ifExists().execute();
      await sql`drop index if exists panel_member_seat_key`.execute(db);
      await db.schema.dropTable("panel_member").ifExists().execute();
      await sql`drop index if exists panel_snapshot_one_current`.execute(db);
      await sql`drop index if exists panel_snapshot_round_version`.execute(db);
      await db.schema.dropTable("panel_snapshot").ifExists().execute();
      await sql`drop index if exists competition_round_activity_key`.execute(db);
      await db.schema.dropTable("competition_round").ifExists().execute();
    },
  },
  "0007_score_correction_fingerprint": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema.alterTable("score_correction")
        .addColumn("input_fingerprint", "varchar(64)", (column) => column.notNull().defaultTo(""))
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.alterTable("score_correction").dropColumn("input_fingerprint").execute();
    },
  },
  "0008_resolution_candidates": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema.alterTable("competition_round")
        .addColumn("scoring_method", "varchar(30)", (column) => column.notNull().defaultTo("average"))
        .execute();
      await db.schema
        .createTable("tie_decision")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_id", "varchar(100)", (column) => column.notNull().references("competition_round.id").onDelete("restrict"))
        .addColumn("ranking_snapshot_id", "varchar(100)", (column) => column.notNull().references("ranking_snapshot.id").onDelete("restrict"))
        .addColumn("input_fingerprint", "varchar(64)", (column) => column.notNull())
        .addColumn("contestants", "jsonb", (column) => column.notNull())
        .addColumn("ordering", "jsonb", (column) => column.notNull())
        .addColumn("reason", "text", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema
        .createTable("podium_candidate")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("input_fingerprint", "varchar(64)", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("placements", "jsonb", (column) => column.notNull())
        .addColumn("source_round_ids", "jsonb", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("podium_candidate_status_check", sql`status in ('candidate', 'hold')`)
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("podium_candidate").ifExists().execute();
      await db.schema.dropTable("tie_decision").ifExists().execute();
      await db.schema.alterTable("competition_round").dropColumn("scoring_method").execute();
    },
  },
  "0009_m5_context_and_podium_metadata": {
    async up(db: Kysely<Database>): Promise<void> {
      await sql`
        alter table score_correction
          drop constraint score_correction_state_check,
          add constraint score_correction_state_check
            check (state in ('open', 'revised', 'closed', 'recalculated', 'cancelled'))
      `.execute(db);
      await db.schema.alterTable("podium_candidate")
        .addColumn("source_score_versions", "jsonb", (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.alterTable("podium_candidate").dropColumn("source_score_versions").execute();
      await sql`update score_correction set state = 'closed' where state = 'recalculated'`.execute(db);
      await sql`
        alter table score_correction
          drop constraint score_correction_state_check,
          add constraint score_correction_state_check
            check (state in ('open', 'revised', 'closed', 'cancelled'))
      `.execute(db);
    },
  },
  "0010_m6_voting_ticketing": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema.alterTable("activity")
        .addColumn("public_code", "varchar(100)", (column) => column.notNull().defaultTo(""))
        .execute();
      await sql`update activity set public_code = id where public_code = ''`.execute(db);
      await sql`create unique index activity_public_code_key on activity(public_code) where public_code <> ''`.execute(db);
      await db.schema.alterTable("activity")
        .addColumn("judge_entry_open", "boolean", (column) => column.notNull().defaultTo(true))
        .addColumn("judge_entry_version", "integer", (column) => column.notNull().defaultTo(1))
        .execute();

      await db.schema
        .createTable("vote_session")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("definition_version", "integer", (column) => column.notNull())
        .addColumn("purpose", "varchar(30)", (column) => column.notNull())
        .addColumn("selection_type", "varchar(10)", (column) => column.notNull())
        .addColumn("max_selections", "integer", (column) => column.notNull())
        .addColumn("requires_ticket", "boolean", (column) => column.notNull())
        .addColumn("allow_browser_identity", "boolean", (column) => column.notNull())
        .addColumn("scoring_rule", "jsonb", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("opened_at", "timestamptz")
        .addColumn("closed_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("vote_session_status_check", sql`status in ('draft', 'open', 'closed')`)
        .addCheckConstraint("vote_session_purpose_check", sql`purpose in ('popularity', 'score_component')`)
        .addCheckConstraint("vote_session_selection_check", sql`selection_type in ('single', 'multi') and max_selections >= 1`)
        .addCheckConstraint("vote_session_identity_check", sql`not (requires_ticket and allow_browser_identity)`)
        .execute();
      await sql`create index vote_session_activity_idx on vote_session(activity_id, status)`.execute(db);

      await db.schema
        .createTable("vote_option")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("session_id", "varchar(100)", (column) => column.notNull().references("vote_session.id").onDelete("restrict"))
        .addColumn("candidate_id", "varchar(100)", (column) => column.notNull())
        .addColumn("ordinal", "integer", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addUniqueConstraint("vote_option_session_candidate_key", ["session_id", "candidate_id"])
        .execute();

      await db.schema
        .createTable("ticket")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("public_code", "varchar(32)", (column) => column.notNull().unique())
        .addColumn("credential_digest", "varchar(64)", (column) => column.notNull().unique())
        .addColumn("credential_version", "integer", (column) => column.notNull().defaultTo(1))
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("issued_at", "timestamptz", (column) => column.notNull())
        .addColumn("redeemed_at", "timestamptz")
        .addColumn("revoked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("ticket_state_check", sql`state in ('issued', 'redeemed', 'revoked', 'expired')`)
        .addCheckConstraint("ticket_version_check", sql`credential_version >= 1`)
        .execute();
      await sql`create index ticket_activity_state_idx on ticket(activity_id, state)`.execute(db);

      await db.schema
        .createTable("ballot")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("session_id", "varchar(100)", (column) => column.notNull().references("vote_session.id").onDelete("restrict"))
        .addColumn("identity_type", "varchar(20)", (column) => column.notNull())
        .addColumn("identity_digest", "varchar(64)")
        .addColumn("ticket_id", "varchar(100)", (column) => column.references("ticket.id").onDelete("restrict"))
        .addColumn("submitted_at", "timestamptz", (column) => column.notNull())
        .addCheckConstraint("ballot_identity_type_check", sql`identity_type in ('ticket', 'browser', 'anonymous')`)
        .addCheckConstraint("ballot_identity_shape_check", sql`(identity_type = 'ticket' and ticket_id is not null and identity_digest is null) or (identity_type = 'browser' and ticket_id is null and identity_digest is not null) or (identity_type = 'anonymous' and ticket_id is null and identity_digest is null)`)
        .execute();
      await sql`create unique index ballot_ticket_identity_key on ballot(session_id, ticket_id) where identity_type = 'ticket'`.execute(db);
      await sql`create unique index ballot_browser_identity_key on ballot(session_id, identity_digest) where identity_type = 'browser'`.execute(db);
      await sql`create index ballot_session_idx on ballot(session_id, submitted_at)`.execute(db);

      await db.schema
        .createTable("vote_record")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("session_id", "varchar(100)", (column) => column.notNull().references("vote_session.id").onDelete("restrict"))
        .addColumn("ballot_id", "varchar(100)", (column) => column.notNull().references("ballot.id").onDelete("restrict"))
        .addColumn("option_id", "varchar(100)", (column) => column.notNull().references("vote_option.id").onDelete("restrict"))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addUniqueConstraint("vote_record_ballot_option_key", ["ballot_id", "option_id"])
        .execute();

      await db.schema
        .createTable("ticket_access_session")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("ticket_id", "varchar(100)", (column) => column.notNull().references("ticket.id").onDelete("restrict"))
        .addColumn("token_digest", "varchar(64)", (column) => column.notNull().unique())
        .addColumn("expires_at", "timestamptz", (column) => column.notNull())
        .addColumn("last_seen_at", "timestamptz")
        .addColumn("revoked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .execute();

      await db.schema
        .createTable("judge_seat_grant")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("seat_key", "varchar(100)", (column) => column.notNull())
        .addColumn("judge_id", "varchar(100)")
        .addColumn("state", "varchar(20)", (column) => column.notNull().defaultTo("available"))
        .addColumn("session_id", "varchar(100)")
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("judge_seat_grant_state_check", sql`state in ('available', 'claimed', 'revoked')`)
        .addUniqueConstraint("judge_seat_grant_activity_key", ["activity_id", "seat_key"])
        .execute();

      await db.schema
        .createTable("judge_session")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("seat_id", "varchar(100)", (column) => column.notNull().references("judge_seat_grant.id").onDelete("restrict"))
        .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("token_digest", "varchar(64)", (column) => column.notNull().unique())
        .addColumn("expires_at", "timestamptz", (column) => column.notNull())
        .addColumn("revoked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .execute();

      await db.schema
        .createTable("live_state")
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("aggregate_type", "varchar(100)", (column) => column.notNull())
        .addColumn("aggregate_id", "varchar(100)", (column) => column.notNull())
        .addColumn("last_sequence", "bigint", (column) => column.notNull().defaultTo(0))
        .addColumn("state", "jsonb", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull().defaultTo("running"))
        .addColumn("blocked_sequence", "bigint")
        .addColumn("blocked_reason", "text")
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint("live_state_pkey", ["activity_id", "aggregate_type", "aggregate_id"])
        .addCheckConstraint("live_state_status_check", sql`status in ('running', 'blocked')`)
        .execute();

      // Keep the activity/session identity aligned even for direct SQL writers.
      // The runtime repeats these checks for capability-aware error semantics;
      // the composite foreign keys make the database boundary authoritative.
      await sql`
        alter table vote_session
          add constraint vote_session_activity_key unique (id, activity_id);
        alter table vote_option
          add constraint vote_option_activity_session_key unique (id, activity_id, session_id),
          add constraint vote_option_activity_session_fk
            foreign key (session_id, activity_id)
            references vote_session (id, activity_id)
            on delete restrict;
        alter table ticket
          add constraint ticket_activity_key unique (id, activity_id);
        alter table ballot
          add constraint ballot_activity_session_key unique (id, activity_id, session_id),
          add constraint ballot_activity_session_fk
            foreign key (session_id, activity_id)
            references vote_session (id, activity_id)
            on delete restrict;
        alter table vote_record
          add constraint vote_record_ballot_activity_session_fk
            foreign key (ballot_id, activity_id, session_id)
            references ballot (id, activity_id, session_id)
            on delete restrict,
          add constraint vote_record_option_activity_session_fk
            foreign key (option_id, activity_id, session_id)
            references vote_option (id, activity_id, session_id)
            on delete restrict;
        alter table ticket_access_session
          add constraint ticket_access_session_ticket_activity_fk
            foreign key (ticket_id, activity_id)
            references ticket (id, activity_id)
            on delete restrict;
        alter table judge_seat_grant
          add constraint judge_seat_grant_activity_key2 unique (id, activity_id);
        alter table judge_session
          add constraint judge_session_seat_activity_fk
            foreign key (seat_id, activity_id)
            references judge_seat_grant (id, activity_id)
            on delete restrict;
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("live_state").ifExists().execute();
      await db.schema.dropTable("judge_session").ifExists().execute();
      await db.schema.dropTable("judge_seat_grant").ifExists().execute();
      await db.schema.dropTable("ticket_access_session").ifExists().execute();
      await db.schema.dropTable("vote_record").ifExists().execute();
      await sql`drop index if exists ballot_browser_identity_key`.execute(db);
      await sql`drop index if exists ballot_ticket_identity_key`.execute(db);
      await sql`drop index if exists ballot_session_idx`.execute(db);
      await db.schema.dropTable("ballot").ifExists().execute();
      await sql`drop index if exists ticket_activity_state_idx`.execute(db);
      await db.schema.dropTable("ticket").ifExists().execute();
      await db.schema.dropTable("vote_option").ifExists().execute();
      await sql`drop index if exists vote_session_activity_idx`.execute(db);
      await db.schema.dropTable("vote_session").ifExists().execute();
      await db.schema.alterTable("activity").dropColumn("judge_entry_version").execute();
      await db.schema.alterTable("activity").dropColumn("judge_entry_open").execute();
      await sql`drop index if exists activity_public_code_key`.execute(db);
      await db.schema.alterTable("activity").dropColumn("public_code").execute();
    },
  },
  "0011_voting_identity_policy": {
    async up(db: Kysely<Database>): Promise<void> {
      await sql`
        alter table vote_session
          add column identity_policy varchar(20)
      `.execute(db);
      await sql`
        update vote_session
           set identity_policy = case
             when requires_ticket then 'ticket'
             when allow_browser_identity then 'browser'
             else 'anonymous'
           end
         where identity_policy is null
      `.execute(db);
      await sql`
        alter table vote_session
          alter column identity_policy set not null,
          add constraint vote_session_identity_policy_check
            check (identity_policy in ('ticket', 'browser', 'anonymous'))
      `.execute(db);
      await sql`
        alter table vote_session
          drop constraint if exists vote_session_identity_check,
          drop column requires_ticket,
          drop column allow_browser_identity
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`
        alter table vote_session
          add column requires_ticket boolean not null default false,
          add column allow_browser_identity boolean not null default false
      `.execute(db);
      await sql`
        update vote_session
           set requires_ticket = identity_policy = 'ticket',
               allow_browser_identity = identity_policy = 'browser'
      `.execute(db);
      await sql`
        alter table vote_session
          add constraint vote_session_identity_check
            check (not (requires_ticket and allow_browser_identity))
      `.execute(db);
      await sql`
        alter table vote_session
          drop constraint if exists vote_session_identity_policy_check,
          drop column identity_policy
      `.execute(db);
    },
  },
  "0012_m7_publishing": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("stage_result")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("stage_key", "varchar(100)", (column) => column.notNull())
        .addColumn("status", "varchar(30)", (column) => column.notNull())
        .addColumn("candidate_revision", "integer", (column) => column.notNull())
        .addColumn("source_candidate_revision", "integer", (column) => column.notNull())
        .addColumn("input_fingerprint", "varchar(128)", (column) => column.notNull())
        .addColumn("decisions", "jsonb", (column) => column.notNull())
        .addColumn("awards", "jsonb", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("confirmed_at", "timestamptz")
        .addColumn("unlocked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("stage_result_status_check", sql`status in ('confirmed', 'ready_to_confirm')`)
        .addCheckConstraint(
          "stage_result_revision_check",
          sql`candidate_revision >= 1 and source_candidate_revision >= 1`,
        )
        .addUniqueConstraint("stage_result_activity_stage_key", ["activity_id", "stage_key"])
        .addUniqueConstraint("stage_result_activity_id_key", ["activity_id", "id"])
        .execute();

      await db.schema
        .createTable("result_publication")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("stage_key", "varchar(100)", (column) => column.notNull())
        .addColumn("title", "varchar(300)", (column) => column.notNull())
        .addColumn("content", "text", (column) => column.notNull())
        .addColumn("version", "integer", (column) => column.notNull().defaultTo(1))
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("result_publication_version_check", sql`version >= 1`)
        .addUniqueConstraint("result_publication_activity_stage_key", ["activity_id", "stage_key"])
        .addUniqueConstraint("result_publication_activity_id_key", ["activity_id", "id"])
        .execute();

      await db.schema
        .createTable("result_release")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("publication_id", "varchar(100)", (column) => column.notNull())
        .addColumn("stage_result_id", "varchar(100)", (column) => column.notNull())
        .addColumn("stage_key", "varchar(100)", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("snapshot", "jsonb", (column) => column.notNull())
        .addColumn("snapshot_candidate_revision", "integer", (column) => column.notNull())
        .addColumn("result_version", "integer", (column) => column.notNull())
        .addColumn("post_version", "integer", (column) => column.notNull())
        .addColumn("input_fingerprint", "varchar(128)", (column) => column.notNull())
        .addColumn("note", "text", (column) => column.notNull())
        .addColumn("released_at", "timestamptz", (column) => column.notNull())
        .addColumn("revoked_at", "timestamptz")
        .addColumn("superseded_at", "timestamptz")
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint(
          "result_release_status_check",
          sql`status in ('active', 'revoked', 'superseded')`,
        )
        .execute();

      await sql`
        alter table result_release
          add constraint result_release_publication_activity_fk
            foreign key (activity_id, publication_id)
            references result_publication (activity_id, id)
            on delete restrict,
          add constraint result_release_stage_result_activity_fk
            foreign key (activity_id, stage_result_id)
            references stage_result (activity_id, id)
            on delete restrict
      `.execute(db);
      await sql`
        create unique index result_release_active_key
          on result_release (activity_id, stage_key)
          where status = 'active'
      `.execute(db);
      await sql`
        create index result_release_history_idx
          on result_release (activity_id, stage_key, released_at)
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`drop index if exists result_release_history_idx`.execute(db);
      await sql`drop index if exists result_release_active_key`.execute(db);
      await db.schema.dropTable("result_release").ifExists().execute();
      await db.schema.dropTable("result_publication").ifExists().execute();
      await db.schema.dropTable("stage_result").ifExists().execute();
    },
  },
  "0013_m7_archive": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("archive_package")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("version", "integer", (column) => column.notNull())
        .addColumn("key", "varchar(300)", (column) => column.notNull())
        .addColumn("size_bytes", "integer", (column) => column.notNull())
        .addColumn("sha256", "varchar(64)", (column) => column.notNull())
        .addColumn("manifest", "jsonb", (column) => column.notNull())
        .addColumn("summary", "jsonb", (column) => column.notNull())
        .addColumn("note", "text", (column) => column.notNull())
        .addColumn("sealed_at", "timestamptz", (column) => column.notNull())
        .addColumn("sealed_by", "varchar(100)", (column) => column.notNull())
        .addColumn("is_current", "boolean", (column) => column.notNull().defaultTo(false))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("archive_package_version_check", sql`version >= 1`)
        .addCheckConstraint("archive_package_size_check", sql`size_bytes >= 0`)
        .addUniqueConstraint("archive_package_activity_version_key", ["activity_id", "version"])
        .execute();
      await sql`
        create unique index archive_package_current_key
          on archive_package (activity_id)
          where is_current
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`drop index if exists archive_package_current_key`.execute(db);
      await db.schema.dropTable("archive_package").ifExists().execute();
    },
  },
  "0014_stage_result_note": {
    async up(db: Kysely<Database>): Promise<void> {
      // Confirmation notes are part of the audit trail, not just a payload hash.
      await db.schema
        .alterTable("stage_result")
        .addColumn("note", "text", (column) => column.notNull().defaultTo(""))
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.alterTable("stage_result").dropColumn("note").execute();
    },
  },
  "0015_mode_isolation": {
    async up(db: Kysely<Database>): Promise<void> {
      await sql`
        alter table score_fact
          add column mode varchar(20) not null default 'formal',
          add constraint score_fact_mode_check check (mode in ('test', 'rehearsal', 'formal'));
        drop index if exists score_fact_current_key;
        create unique index score_fact_current_key
          on score_fact(round_id, contestant_id, judge_id, mode)
          where current = true;

        alter table vote_session
          add column mode varchar(20) not null default 'formal',
          add constraint vote_session_mode_check check (mode in ('test', 'rehearsal', 'formal'));

        alter table ranking_snapshot
          add column mode varchar(20) not null default 'formal',
          add constraint ranking_snapshot_mode_check check (mode in ('test', 'rehearsal', 'formal'));
        create index ranking_snapshot_round_mode_idx
          on ranking_snapshot(round_id, mode, revision desc);
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`
        drop index if exists ranking_snapshot_round_mode_idx;
        alter table ranking_snapshot drop constraint if exists ranking_snapshot_mode_check;
        alter table ranking_snapshot drop column if exists mode;
        alter table vote_session drop constraint if exists vote_session_mode_check;
        alter table vote_session drop column if exists mode;
        drop index if exists score_fact_current_key;
        alter table score_fact drop constraint if exists score_fact_mode_check;
        alter table score_fact drop column if exists mode;
        create unique index score_fact_current_key
          on score_fact(round_id, contestant_id, judge_id)
          where current = true;
      `.execute(db);
    },
  },
  "0016_grouping": {
    async up(db: Kysely<Database>): Promise<void> {
      await sql`
        create table grouping_stage (
          id varchar(100) primary key,
          activity_id varchar(100) not null references activity(id) on delete cascade,
          stage_key varchar(100) not null,
          name varchar(200) not null,
          status varchar(20) not null default 'draft'
            check (status in ('draft', 'confirmed', 'frozen', 'cancelled')),
          roster_source varchar(20) not null default 'all_approved'
            check (roster_source in ('all_approved', 'round_advanced')),
          source_round_id varchar(100) references competition_round(id),
          source_fingerprint varchar(128) not null default '',
          material_window varchar(20) not null default 'closed'
            check (material_window in ('closed', 'open', 'supplement_only')),
          cancel_reason text not null default '',
          confirmed_at timestamptz,
          confirmed_by varchar(100),
          frozen_at timestamptz,
          frozen_by varchar(100),
          cancelled_at timestamptz,
          cancelled_by varchar(100),
          revision integer not null default 1,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique (activity_id, stage_key),
          check (
            (roster_source = 'round_advanced' and source_round_id is not null) or
            (roster_source = 'all_approved' and source_round_id is null)
          )
        );
        create index grouping_stage_activity_idx on grouping_stage(activity_id, revision);

        create table grouping_group (
          id varchar(100) primary key,
          stage_id varchar(100) not null references grouping_stage(id) on delete cascade,
          group_order integer not null check (group_order >= 1),
          name varchar(200) not null,
          is_active boolean not null default true,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
        create unique index grouping_group_active_order_key
          on grouping_group(stage_id, group_order) where is_active = true;

        create table grouping_membership (
          id varchar(100) primary key,
          stage_id varchar(100) not null references grouping_stage(id) on delete cascade,
          group_id varchar(100) not null references grouping_group(id) on delete cascade,
          participant_id varchar(100) not null,
          is_current boolean not null default true,
          joined_at timestamptz not null default now(),
          left_at timestamptz,
          removed_by varchar(100),
          reason text not null default ''
        );
        create unique index grouping_membership_current_key
          on grouping_membership(stage_id, participant_id) where is_current = true;
        create index grouping_membership_group_idx
          on grouping_membership(group_id) where is_current = true;
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`
        drop table if exists grouping_membership;
        drop table if exists grouping_group;
        drop table if exists grouping_stage;
      `.execute(db);
    },
  },
  "0017_result_provenance": {
    async up(db: Kysely<Database>): Promise<void> {
      // A confirmed result must remember the aggregate, release and mode it was
      // built from, and it must be able to become stale when that source moves.
      await db.schema
        .alterTable("stage_result")
        .addColumn("source", "jsonb")
        .addColumn("stale_at", "timestamptz")
        .addColumn("stale_reason", "text", (column) => column.notNull().defaultTo(""))
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema
        .alterTable("stage_result")
        .dropColumn("stale_reason")
        .dropColumn("stale_at")
        .dropColumn("source")
        .execute();
    },
  },
  "0018_material_cutover": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .alterTable("material")
        .addColumn("content_ready", "boolean", (column) => column.notNull().defaultTo(true))
        .execute();
      await db.schema
        .alterTable("registration")
        .addColumn("supplement_keys", "jsonb", (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
        .execute();
      await sql`
        create table material_check (
          id varchar(100) primary key,
          activity_id varchar(100) not null references activity(id) on delete cascade,
          registration_id varchar(100) not null references registration(id) on delete cascade,
          slot_key varchar(100) not null,
          item_name varchar(200) not null,
          purpose varchar(24) not null default '',
          accepted_purposes jsonb not null default '[]'::jsonb,
          status varchar(20) not null default 'missing'
            check (status in ('missing', 'uploaded', 'approved', 'needs_supplement')),
          required boolean not null default true,
          review_note text not null default '',
          revision integer not null default 0,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique (registration_id, slot_key)
        );
        create index material_check_activity_idx on material_check(activity_id, status);

        create table supplement_grant (
          id varchar(100) primary key,
          activity_id varchar(100) not null references activity(id) on delete cascade,
          registration_id varchar(100) not null references registration(id) on delete cascade,
          token_digest varchar(64) not null unique,
          allowed_keys jsonb not null default '[]'::jsonb,
          expires_at timestamptz not null,
          revoked_at timestamptz,
          created_by varchar(100) not null,
          created_at timestamptz not null default now()
        );
        create index supplement_grant_registration_idx on supplement_grant(registration_id);
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`
        drop table if exists supplement_grant;
        drop table if exists material_check;
      `.execute(db);
      await db.schema.alterTable("registration").dropColumn("supplement_keys").execute();
      await db.schema.alterTable("material").dropColumn("content_ready").execute();
    },
  },
  "0019_participant_account_claim": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("participant_claim")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("registration_id", "varchar(100)", (column) =>
          column.notNull().references("registration.id").onDelete("cascade"),
        )
        .addColumn("legacy_participant_id", "varchar(100)", (column) => column.notNull())
        .addColumn("token_digest", "varchar(64)", (column) => column.notNull())
        .addColumn("expires_at", "timestamptz", (column) => column.notNull())
        .addColumn("consumed_at", "timestamptz")
        .addColumn("consumed_by_actor_id", "varchar(100)")
        .addColumn("issued_by", "varchar(100)", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addUniqueConstraint("participant_claim_token_digest_key", ["token_digest"])
        .addCheckConstraint(
          "participant_claim_legacy_id_check",
          sql`legacy_participant_id like 'legacy-user:%'`,
        )
        .addCheckConstraint(
          "participant_claim_consumed_pair_check",
          sql`(consumed_at is null and consumed_by_actor_id is null) or (consumed_at is not null and consumed_by_actor_id is not null)`,
        )
        .execute();
      await db.schema
        .createIndex("participant_claim_registration_idx")
        .on("participant_claim")
        .columns(["activity_id", "registration_id"])
        .execute();
      await db.schema
        .createTable("participant_identity_link")
        .addColumn("legacy_participant_id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("linked_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addColumn("linked_by", "varchar(100)", (column) => column.notNull())
        .addColumn("claim_id", "varchar(100)", (column) =>
          column.notNull().references("participant_claim.id").onDelete("restrict"),
        )
        .addUniqueConstraint("participant_identity_link_actor_key", ["actor_id"])
        .addCheckConstraint(
          "participant_identity_link_legacy_id_check",
          sql`legacy_participant_id like 'legacy-user:%'`,
        )
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("participant_identity_link").ifExists().execute();
      await db.schema.dropTable("participant_claim").ifExists().execute();
    },
  },
  "0020_participant_claim_reissue": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .alterTable("participant_claim")
        .addColumn("revoked_at", "timestamptz")
        .execute();
      await sql`
        with ranked_claims as (
          select id,
                 row_number() over (
                   partition by registration_id
                   order by created_at desc, id desc
                 ) as claim_rank
            from participant_claim
           where consumed_at is null
             and revoked_at is null
        )
        update participant_claim as claim
           set revoked_at = now()
          from ranked_claims
         where claim.id = ranked_claims.id
           and ranked_claims.claim_rank > 1
      `.execute(db);
      await sql`
        create unique index participant_claim_active_registration_key
          on participant_claim(registration_id)
         where consumed_at is null and revoked_at is null
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`drop index if exists participant_claim_active_registration_key`.execute(db);
      await db.schema
        .alterTable("participant_claim")
        .dropColumn("revoked_at")
        .execute();
    },
  },
  "0021_rate_limit_buckets": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("rate_limit_bucket")
        .addColumn("key", "varchar(255)", (column) => column.notNull())
        .addColumn("window_started_at", "timestamptz", (column) => column.notNull())
        .addColumn("window_ms", "integer", (column) => column.notNull())
        .addColumn("count", "integer", (column) => column.notNull())
        .addColumn("expires_at", "timestamptz", (column) => column.notNull())
        .addPrimaryKeyConstraint("rate_limit_bucket_pkey", ["key", "window_started_at"])
        .addCheckConstraint("rate_limit_bucket_window_check", sql`window_ms > 0`)
        .addCheckConstraint("rate_limit_bucket_count_check", sql`count > 0`)
        .execute();
      await db.schema
        .createIndex("rate_limit_bucket_expiry_idx")
        .on("rate_limit_bucket")
        .column("expires_at")
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("rate_limit_bucket").ifExists().execute();
    },
  },
  "0022_tasks": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("task_item")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("definition_version", "integer", (column) => column.notNull())
        .addColumn("template_key", "varchar(100)", (column) => column.notNull())
        .addColumn("title", "varchar(200)", (column) => column.notNull())
        .addColumn("source_capability", "varchar(100)", (column) => column.notNull())
        .addColumn("source_key", "varchar(200)", (column) => column.notNull())
        .addColumn("required", "boolean", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull().defaultTo("pending"))
        .addColumn("assignee_actor_id", "varchar(100)")
        .addColumn("due_at", "timestamptz")
        .addColumn("blocked_reason", "text")
        .addColumn("completion_reason", "text")
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addColumn("updated_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addUniqueConstraint("task_item_activity_version_template_key", [
          "activity_id",
          "definition_version",
          "template_key",
        ])
        .addCheckConstraint(
          "task_item_definition_version_check",
          sql`definition_version > 0`,
        )
        .addCheckConstraint(
          "task_item_status_check",
          sql`status in ('pending', 'in_progress', 'blocked', 'done')`,
        )
        .addCheckConstraint(
          "task_item_fields_check",
          sql`length(btrim(template_key)) > 0 and length(btrim(title)) > 0 and length(btrim(source_capability)) > 0 and length(btrim(source_key)) > 0`,
        )
        .execute();
      await db.schema
        .createIndex("task_item_activity_version_status_idx")
        .on("task_item")
        .columns(["activity_id", "definition_version", "status"])
        .execute();
      await db.schema
        .createIndex("task_item_due_at_idx")
        .on("task_item")
        .columns(["activity_id", "definition_version", "due_at"])
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("task_item").ifExists().execute();
    },
  },
};

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

async function createMigrator(db: Kysely<Database>): Promise<Migrator> {
  // Kysely otherwise discovers migration tables in *any* schema; with pooled
  // search_path-based test schemas that can pick up another schema's lock
  // table. Pin the migrator to the connection's current schema.
  const current = await sql<{ schema: string }>`select current_schema() as schema`.execute(db);
  const schema = current.rows[0]?.schema;
  return new Migrator({
    db,
    provider: new StaticMigrationProvider(),
    ...(schema === undefined ? {} : { migrationTableSchema: schema }),
  });
}

export async function migrateTo(db: Kysely<Database>, migrationName: string): Promise<MigrationResultSet> {
  const migrator = await createMigrator(db);
  const result = await migrator.migrateTo(migrationName);
  if (result.error !== undefined) {
    throw result.error;
  }
  return result;
}

export async function migrate(db: Kysely<Database>): Promise<MigrationResultSet> {
  const migrator = await createMigrator(db);
  const result = await migrator.migrateToLatest();
  if (result.error !== undefined) {
    throw result.error;
  }
  return result;
}
