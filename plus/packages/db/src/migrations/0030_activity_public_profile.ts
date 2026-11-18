import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable("activity_public_profile")
      .addColumn("activity_id", "varchar(100)", (column) =>
        column.primaryKey().references("activity.id").onDelete("cascade"),
      )
      .addColumn("tagline", "varchar(160)", (column) => column.notNull().defaultTo(""))
      .addColumn("description", "text", (column) => column.notNull().defaultTo(""))
      .addColumn("venue", "varchar(200)", (column) => column.notNull().defaultTo(""))
      .addColumn("starts_at", "timestamptz")
      .addColumn("ends_at", "timestamptz")
      .addColumn("organizer", "varchar(200)", (column) => column.notNull().defaultTo(""))
      .addColumn("contact", "varchar(200)", (column) => column.notNull().defaultTo(""))
      .addColumn("announcement", "text", (column) => column.notNull().defaultTo(""))
      .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("updated_by", "varchar(100)", (column) => column.notNull().defaultTo(""))
      .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .execute();
  },

  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.dropTable("activity_public_profile").ifExists().execute();
  },
};
