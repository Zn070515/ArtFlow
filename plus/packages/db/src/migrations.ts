import { sql, type Kysely } from "kysely";
import {
  Migrator,
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
} from "kysely/migration";

import type { Database } from "./types.js";

const migrations: Record<string, Migration> = {
  "0001_activity_receipt_outbox": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("activity")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("title", "varchar(200)", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("enabled_capabilities", "jsonb", (column) =>
          column.notNull().defaultTo(sql`'[]'::jsonb`),
        )
        .addColumn("active_definition_version", "integer", (column) =>
          column.notNull().defaultTo(0),
        )
        .execute();

      await db.schema
        .createTable("command_receipt")
        .addColumn("command_id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull())
        .addColumn("result", "jsonb", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .execute();

      await db.schema
        .createTable("outbox")
        .addColumn("id", "bigserial", (column) => column.primaryKey())
        .addColumn("event_type", "varchar(100)", (column) => column.notNull())
        .addColumn("payload", "jsonb", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addColumn("published_at", "timestamptz")
        .execute();

      await db.schema
        .createIndex("outbox_unpublished_idx")
        .on("outbox")
        .columns(["published_at", "id"])
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("outbox").ifExists().execute();
      await db.schema.dropTable("command_receipt").ifExists().execute();
      await db.schema.dropTable("activity").ifExists().execute();
    },
  },
};

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

export async function migrate(db: Kysely<Database>): Promise<MigrationResultSet> {
  const migrator = new Migrator({
    db,
    provider: new StaticMigrationProvider(),
  });
  const result = await migrator.migrateToLatest();
  if (result.error !== undefined) {
    throw result.error;
  }
  return result;
}
