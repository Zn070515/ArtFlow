import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      // A confirmed result must remember the aggregate, release and mode it was
      // built from, and it must be able to become stale when that source moves.
      await db.schema
        .alterTable("stage_result")
        .addColumn("source", "jsonb")
        .addColumn("stale_at", "timestamptz")
        .addColumn("stale_reason", "text", (column) => column.notNull().defaultTo(""))
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema
        .alterTable("stage_result")
        .dropColumn("stale_reason")
        .dropColumn("stale_at")
        .dropColumn("source")
        .execute();
    },
  }
