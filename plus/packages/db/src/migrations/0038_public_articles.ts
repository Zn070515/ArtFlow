import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable("public_article")
      .addColumn("id", "varchar(100)", (column) => column.primaryKey())
      .addColumn("slug", "varchar(160)", (column) => column.notNull().unique())
      .addColumn("title", "varchar(200)", (column) => column.notNull())
      .addColumn("summary", "text", (column) => column.notNull().defaultTo(""))
      .addColumn("body", "text", (column) => column.notNull().defaultTo(""))
      .addColumn("cover_url", "text")
      .addColumn("status", "varchar(20)", (column) => column.notNull().defaultTo("draft"))
      .addColumn("published_at", "timestamptz")
      .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("author_id", "varchar(100)", (column) => column.notNull())
      .execute();
    await sql`
      create index public_article_published_idx
      on public_article(status, published_at desc)
    `.execute(db);
  },
  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.dropTable("public_article").ifExists().execute();
  },
};
