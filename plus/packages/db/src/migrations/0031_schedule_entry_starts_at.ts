import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .alterTable("schedule_entry")
      .addColumn("starts_at", "timestamptz")
      .execute();
  },

  async down(db: Kysely<Database>): Promise<void> {
    await db.schema
      .alterTable("schedule_entry")
      .dropColumn("starts_at")
      .execute();
  },
};
