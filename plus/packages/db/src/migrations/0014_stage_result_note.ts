import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
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
  }
