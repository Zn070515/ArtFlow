import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .alterTable("activity_public_profile")
      .addColumn("announcements", "jsonb", (column) =>
        column.notNull().defaultTo(sql`'[]'::jsonb`),
      )
      .addColumn("faq", "jsonb", (column) =>
        column.notNull().defaultTo(sql`'[]'::jsonb`),
      )
      .addColumn("links", "jsonb", (column) =>
        column.notNull().defaultTo(sql`'[]'::jsonb`),
      )
      .addColumn("participants_visible", "boolean", (column) =>
        column.notNull().defaultTo(false),
      )
      .execute();
  },

  async down(db: Kysely<Database>): Promise<void> {
    await db.schema
      .alterTable("activity_public_profile")
      .dropColumn("announcements")
      .dropColumn("faq")
      .dropColumn("links")
      .dropColumn("participants_visible")
      .execute();
  },
};
