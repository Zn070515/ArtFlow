import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable("schedule_state")
      .addColumn("activity_id", "varchar(100)", (column) =>
        column.notNull().references("activity.id").onDelete("cascade"),
      )
      .addColumn("mode", "varchar(20)", (column) => column.notNull())
      .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint("schedule_state_pk", ["activity_id", "mode"])
      .addCheckConstraint("schedule_state_mode_check", sql`mode in ('test', 'rehearsal', 'formal')`)
      .execute();

    await db.schema
      .createTable("schedule_entry")
      .addColumn("id", "varchar(100)", (column) => column.primaryKey())
      .addColumn("activity_id", "varchar(100)", (column) =>
        column.notNull().references("activity.id").onDelete("cascade"),
      )
      .addColumn("mode", "varchar(20)", (column) => column.notNull())
      .addColumn("position", "integer", (column) => column.notNull())
      .addColumn("slot_key", "varchar(64)", (column) => column.notNull())
      .addColumn("participant_id", "varchar(100)")
      .addColumn("title", "varchar(200)", (column) => column.notNull())
      .addColumn("note", "varchar(500)", (column) => column.notNull().defaultTo(""))
      .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addCheckConstraint("schedule_entry_mode_check", sql`mode in ('test', 'rehearsal', 'formal')`)
      .addCheckConstraint("schedule_entry_position_check", sql`position >= 0`)
      .execute();
    await db.schema
      .createIndex("schedule_entry_activity_mode_position_idx")
      .on("schedule_entry")
      .columns(["activity_id", "mode", "position"])
      .execute();

    await db.schema
      .createTable("schedule_release")
      .addColumn("id", "varchar(100)", (column) => column.primaryKey())
      .addColumn("activity_id", "varchar(100)", (column) =>
        column.notNull().references("activity.id").onDelete("cascade"),
      )
      .addColumn("mode", "varchar(20)", (column) => column.notNull())
      .addColumn("version", "integer", (column) => column.notNull())
      .addColumn("snapshot", "jsonb", (column) => column.notNull())
      .addColumn("note", "varchar(500)", (column) => column.notNull().defaultTo(""))
      .addColumn("released_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn("revoked_at", "timestamptz")
      .addCheckConstraint("schedule_release_mode_check", sql`mode in ('test', 'rehearsal', 'formal')`)
      .addUniqueConstraint("schedule_release_version_key", ["activity_id", "mode", "version"])
      .execute();
    await db.schema
      .createIndex("schedule_release_activity_mode_idx")
      .on("schedule_release")
      .columns(["activity_id", "mode", "released_at"])
      .execute();

    await db.schema
      .createTable("schedule_current")
      .addColumn("activity_id", "varchar(100)", (column) =>
        column.notNull().references("activity.id").onDelete("cascade"),
      )
      .addColumn("mode", "varchar(20)", (column) => column.notNull())
      .addColumn("entry_id", "varchar(100)", (column) =>
        column.references("schedule_entry.id").onDelete("set null"),
      )
      .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint("schedule_current_pk", ["activity_id", "mode"])
      .addCheckConstraint("schedule_current_mode_check", sql`mode in ('test', 'rehearsal', 'formal')`)
      .execute();
  },

  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.dropTable("schedule_current").ifExists().execute();
    await db.schema.dropTable("schedule_release").ifExists().execute();
    await db.schema.dropTable("schedule_entry").ifExists().execute();
    await db.schema.dropTable("schedule_state").ifExists().execute();
  },
};
