import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .alterTable("local_account")
      .addColumn("email", "varchar(320)")
      .execute();
    await db.schema
      .alterTable("local_account")
      .addColumn("mfa_secret", "varchar(64)")
      .execute();
    await db.schema
      .alterTable("local_account")
      .addColumn("mfa_enabled", "boolean", (column) => column.notNull().defaultTo(false))
      .execute();
    await db.schema
      .alterTable("local_account")
      .addColumn("oidc_issuer", "varchar(300)")
      .execute();
    await db.schema
      .alterTable("local_account")
      .addColumn("oidc_subject", "varchar(255)")
      .execute();

    // Emails are compared case-insensitively for login and reset, while the
    // stored value keeps the address the user typed.
    await sql`
      create unique index local_account_email_uq
      on local_account (lower(email)) where email is not null
    `.execute(db);
    await sql`
      create unique index local_account_oidc_identity_uq
      on local_account (oidc_issuer, oidc_subject)
      where oidc_issuer is not null and oidc_subject is not null
    `.execute(db);

    await db.schema
      .createTable("password_reset_token")
      .addColumn("token_digest", "varchar(64)", (column) => column.primaryKey())
      .addColumn("actor_id", "varchar(100)", (column) =>
        column.notNull().references("local_account.actor_id").onDelete("cascade"),
      )
      .addColumn("expires_at", "timestamptz", (column) => column.notNull())
      .addColumn("used_at", "timestamptz")
      .addColumn("created_at", "timestamptz", (column) =>
        column.notNull().defaultTo(sql`now()`),
      )
      .execute();
    await sql`
      create index password_reset_token_actor_idx
      on password_reset_token(actor_id)
    `.execute(db);
    await sql`
      create index password_reset_token_expiry_idx
      on password_reset_token(expires_at)
    `.execute(db);
  },
  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.dropTable("password_reset_token").ifExists().execute();
    await sql`drop index if exists local_account_oidc_identity_uq`.execute(db);
    await sql`drop index if exists local_account_email_uq`.execute(db);
    await db.schema.alterTable("local_account").dropColumn("oidc_subject").execute();
    await db.schema.alterTable("local_account").dropColumn("oidc_issuer").execute();
    await db.schema.alterTable("local_account").dropColumn("mfa_enabled").execute();
    await db.schema.alterTable("local_account").dropColumn("mfa_secret").execute();
    await db.schema.alterTable("local_account").dropColumn("email").execute();
  },
};
