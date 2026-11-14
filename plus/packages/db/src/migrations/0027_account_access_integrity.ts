import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    // Every authenticated request joins local_session to local_account on
    // actor_id. Without this index that join scans the whole registry, and
    // duplicates would make the resolved account ambiguous.
    await sql`create unique index local_account_actor_id_uq on local_account(actor_id)`.execute(db);
    // revokeLocalSessionsForActor updates by actor_id.
    await sql`create index local_session_actor_idx on local_session(actor_id)`.execute(db);
    // Compare-and-set for concurrent administrator edits.
    await db.schema
      .alterTable("local_account")
      .addColumn("access_revision", "integer", (column) => column.notNull().defaultTo(0))
      .execute();
  },
  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.alterTable("local_account").dropColumn("access_revision").execute();
    await sql`drop index if exists local_session_actor_idx`.execute(db);
    await sql`drop index if exists local_account_actor_id_uq`.execute(db);
  },
};
