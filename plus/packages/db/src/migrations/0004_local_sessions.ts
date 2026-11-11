import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("local_account")
        .addColumn("username", "varchar(100)", (column) => column.primaryKey())
        .addColumn("password_digest", "varchar(256)", (column) => column.notNull())
        .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("actor_type", "varchar(20)", (column) => column.notNull().defaultTo("user"))
        .addColumn("roles", "jsonb", (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
        .addColumn("permissions", "jsonb", (column) =>
          column.notNull().defaultTo(sql`'[]'::jsonb`),
        )
        .addColumn("auth_context", "varchar(200)")
        .addColumn("active", "boolean", (column) => column.notNull().defaultTo(true))
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addCheckConstraint(
          "local_account_actor_type_check",
          sql`actor_type in ('user', 'service')`,
        )
        .execute();

      await db.schema
        .createTable("local_session")
        .addColumn("token", "varchar(200)", (column) => column.primaryKey())
        .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("actor_type", "varchar(20)", (column) => column.notNull())
        .addColumn("roles", "jsonb", (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
        .addColumn("permissions", "jsonb", (column) =>
          column.notNull().defaultTo(sql`'[]'::jsonb`),
        )
        .addColumn("auth_context", "varchar(200)")
        .addColumn("expires_at", "timestamptz", (column) => column.notNull())
        .addColumn("revoked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addCheckConstraint(
          "local_session_actor_type_check",
          sql`actor_type in ('user', 'service')`,
        )
        .execute();
      await sql`create index local_session_expiry_idx on local_session(expires_at)`.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("local_session").ifExists().execute();
      await db.schema.dropTable("local_account").ifExists().execute();
    },
  }
