import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
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
  }
