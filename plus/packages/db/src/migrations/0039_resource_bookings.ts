import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable("resource_booking")
      .addColumn("id", "varchar(100)", (column) => column.primaryKey())
      .addColumn("activity_id", "varchar(100)", (column) =>
        column.notNull().references("activity.id").onDelete("cascade"),
      )
      .addColumn("resource_key", "varchar(80)", (column) => column.notNull())
      .addColumn("resource_name", "varchar(120)", (column) => column.notNull())
      .addColumn("title", "varchar(200)", (column) => column.notNull())
      .addColumn("note", "text", (column) => column.notNull().defaultTo(""))
      .addColumn("starts_at", "timestamptz", (column) => column.notNull())
      .addColumn("ends_at", "timestamptz", (column) => column.notNull())
      .addColumn("status", "varchar(20)", (column) => column.notNull().defaultTo("draft"))
      .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("created_by", "varchar(100)", (column) => column.notNull())
      .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn("cancelled_at", "timestamptz")
      .addColumn("cancel_reason", "text")
      .addCheckConstraint("resource_booking_time_check", sql`ends_at > starts_at`)
      .addCheckConstraint(
        "resource_booking_status_check",
        sql`status in ('draft', 'confirmed', 'cancelled')`,
      )
      .execute();
    await sql`
      create index resource_booking_activity_idx
      on resource_booking(activity_id, resource_key, starts_at)
    `.execute(db);
  },
  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.dropTable("resource_booking").ifExists().execute();
  },
};
