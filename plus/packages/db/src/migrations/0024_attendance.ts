import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("attendance_point")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("key", "varchar(64)", (column) => column.notNull())
        .addColumn("name", "varchar(120)", (column) => column.notNull())
        .addColumn("subject_types", "jsonb", (column) => column.notNull())
        .addColumn("active", "boolean", (column) => column.notNull().defaultTo(true))
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_by", "varchar(100)", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addUniqueConstraint("attendance_point_activity_key", ["activity_id", "key"])
        .addCheckConstraint(
          "attendance_point_key_check",
          sql`key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`,
        )
        .addCheckConstraint(
          "attendance_point_subject_types_check",
          sql`jsonb_typeof(subject_types) = 'array' and jsonb_array_length(subject_types) > 0`,
        )
        .execute();

      await db.schema
        .createTable("attendance_staff")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("display_name", "varchar(120)", (column) => column.notNull())
        .addColumn("actor_id", "varchar(100)")
        .addColumn("active", "boolean", (column) => column.notNull().defaultTo(true))
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_by", "varchar(100)", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint(
          "attendance_staff_display_name_check",
          sql`length(btrim(display_name)) between 1 and 120`,
        )
        .execute();

      await db.schema
        .createTable("attendance_fact")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("mode", "varchar(20)", (column) => column.notNull())
        .addColumn("point_key", "varchar(64)", (column) => column.notNull())
        .addColumn("subject_type", "varchar(20)", (column) => column.notNull())
        .addColumn("subject_id", "varchar(100)", (column) => column.notNull())
        .addColumn("action", "varchar(20)", (column) => column.notNull())
        .addColumn("note", "varchar(500)")
        .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("command_id", "varchar(100)", (column) => column.notNull())
        .addColumn("occurred_at", "timestamptz", (column) => column.notNull())
        .addCheckConstraint("attendance_fact_mode_check", sql`mode in ('formal', 'test')`)
        .addCheckConstraint(
          "attendance_fact_subject_type_check",
          sql`subject_type in ('participant', 'ticket', 'staff')`,
        )
        .addCheckConstraint("attendance_fact_action_check", sql`action in ('checkin', 'undo')`)
        .execute();
      await db.schema
        .createIndex("attendance_fact_activity_mode_point_idx")
        .on("attendance_fact")
        .columns(["activity_id", "mode", "point_key", "occurred_at"])
        .execute();

      await db.schema
        .createTable("attendance_current")
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("mode", "varchar(20)", (column) => column.notNull())
        .addColumn("point_key", "varchar(64)", (column) => column.notNull())
        .addColumn("subject_type", "varchar(20)", (column) => column.notNull())
        .addColumn("subject_id", "varchar(100)", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("note", "varchar(500)")
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addUniqueConstraint("attendance_current_subject_key", [
          "activity_id",
          "mode",
          "point_key",
          "subject_type",
          "subject_id",
        ])
        .addCheckConstraint("attendance_current_mode_check", sql`mode in ('formal', 'test')`)
        .addCheckConstraint(
          "attendance_current_subject_type_check",
          sql`subject_type in ('participant', 'ticket', 'staff')`,
        )
        .addCheckConstraint("attendance_current_status_check", sql`status in ('present', 'undone')`)
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("attendance_current").ifExists().execute();
      await db.schema.dropTable("attendance_fact").ifExists().execute();
      await db.schema.dropTable("attendance_staff").ifExists().execute();
      await db.schema.dropTable("attendance_point").ifExists().execute();
    },
  }
