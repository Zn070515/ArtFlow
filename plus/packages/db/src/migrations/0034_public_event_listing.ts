import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .alterTable("activity_public_profile")
      .addColumn("listed_publicly", "boolean", (column) =>
        column.notNull().defaultTo(false),
      )
      .execute();
  },

  async down(db: Kysely<Database>): Promise<void> {
    await db.schema
      .alterTable("activity_public_profile")
      .dropColumn("listed_publicly")
      .execute();
  },
};
