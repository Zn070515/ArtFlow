import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema.alterTable("score_correction")
        .addColumn("input_fingerprint", "varchar(64)", (column) => column.notNull().defaultTo(""))
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.alterTable("score_correction").dropColumn("input_fingerprint").execute();
    },
  }
