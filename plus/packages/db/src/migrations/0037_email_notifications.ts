import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable("notification_delivery")
      .addColumn("id", "varchar(200)", (column) => column.primaryKey())
      .addColumn("event_id", "varchar(100)", (column) => column.notNull())
      .addColumn("channel", "varchar(20)", (column) => column.notNull())
      .addColumn("recipient", "varchar(320)", (column) => column.notNull())
      .addColumn("kind", "varchar(50)", (column) => column.notNull())
      .addColumn("subject", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .addColumn("link", "text", (column) => column.notNull())
      .addColumn("status", "varchar(20)", (column) => column.notNull().defaultTo("pending"))
      .addColumn("attempts", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("last_error", "text")
      .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn("sent_at", "timestamptz")
      .execute();
    await sql`
      create unique index notification_delivery_event_recipient_uq
      on notification_delivery(event_id, channel, recipient)
    `.execute(db);
    await sql`
      create index notification_delivery_pending_idx
      on notification_delivery(status, created_at)
    `.execute(db);

    await db.schema
      .createTable("notification_cursor")
      .addColumn("channel", "varchar(20)", (column) => column.primaryKey())
      .addColumn("last_outbox_id", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .execute();
  },
  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.dropTable("notification_cursor").ifExists().execute();
    await db.schema.dropTable("notification_delivery").ifExists().execute();
  },
};
