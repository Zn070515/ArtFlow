import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("archive_package")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("version", "integer", (column) => column.notNull())
        .addColumn("key", "varchar(300)", (column) => column.notNull())
        .addColumn("size_bytes", "integer", (column) => column.notNull())
        .addColumn("sha256", "varchar(64)", (column) => column.notNull())
        .addColumn("manifest", "jsonb", (column) => column.notNull())
        .addColumn("summary", "jsonb", (column) => column.notNull())
        .addColumn("note", "text", (column) => column.notNull())
        .addColumn("sealed_at", "timestamptz", (column) => column.notNull())
        .addColumn("sealed_by", "varchar(100)", (column) => column.notNull())
        .addColumn("is_current", "boolean", (column) => column.notNull().defaultTo(false))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("archive_package_version_check", sql`version >= 1`)
        .addCheckConstraint("archive_package_size_check", sql`size_bytes >= 0`)
        .addUniqueConstraint("archive_package_activity_version_key", ["activity_id", "version"])
        .execute();
      await sql`
        create unique index archive_package_current_key
          on archive_package (activity_id)
          where is_current
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`drop index if exists archive_package_current_key`.execute(db);
      await db.schema.dropTable("archive_package").ifExists().execute();
    },
  }
