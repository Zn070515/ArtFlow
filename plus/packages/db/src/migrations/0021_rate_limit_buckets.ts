import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("rate_limit_bucket")
        .addColumn("key", "varchar(255)", (column) => column.notNull())
        .addColumn("window_started_at", "timestamptz", (column) => column.notNull())
        .addColumn("window_ms", "integer", (column) => column.notNull())
        .addColumn("count", "integer", (column) => column.notNull())
        .addColumn("expires_at", "timestamptz", (column) => column.notNull())
        .addPrimaryKeyConstraint("rate_limit_bucket_pkey", ["key", "window_started_at"])
        .addCheckConstraint("rate_limit_bucket_window_check", sql`window_ms > 0`)
        .addCheckConstraint("rate_limit_bucket_count_check", sql`count > 0`)
        .execute();
      await db.schema
        .createIndex("rate_limit_bucket_expiry_idx")
        .on("rate_limit_bucket")
        .column("expires_at")
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("rate_limit_bucket").ifExists().execute();
    },
  }
