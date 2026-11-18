import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable("participant_notification_read")
      .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
      .addColumn("notification_key", "varchar(300)", (column) => column.notNull())
      .addColumn("read_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint("participant_notification_read_pk", ["actor_id", "notification_key"])
      .execute();
  },

  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.dropTable("participant_notification_read").ifExists().execute();
  },
};
