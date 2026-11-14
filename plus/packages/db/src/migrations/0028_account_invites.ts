import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable("account_invite")
      .addColumn("id", "varchar(100)", (column) => column.primaryKey())
      .addColumn("username", "varchar(100)", (column) =>
        column.notNull().references("local_account.username").onDelete("cascade"),
      )
      .addColumn("token_digest", "varchar(64)", (column) => column.notNull().unique())
      .addColumn("expires_at", "timestamptz", (column) => column.notNull())
      .addColumn("claimed_at", "timestamptz")
      .addColumn("issued_by", "varchar(100)", (column) => column.notNull())
      .addColumn("created_at", "timestamptz", (column) =>
        column.notNull().defaultTo(sql`now()`),
      )
      .execute();
    // At most one open invitation per account; rotating replaces it.
    await sql`
      create unique index account_invite_open_username_uq
      on account_invite(username) where claimed_at is null
    `.execute(db);
    await sql`create index account_invite_username_idx on account_invite(username)`.execute(db);
  },
  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.dropTable("account_invite").ifExists().execute();
  },
};
