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
