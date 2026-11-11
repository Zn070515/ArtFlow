import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("participant_identity_link").ifExists().execute();
      await db.schema.dropTable("participant_claim").ifExists().execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("participant_claim")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("registration_id", "varchar(100)", (column) =>
          column.notNull().references("registration.id").onDelete("cascade"),
        )
        .addColumn("legacy_participant_id", "varchar(100)", (column) => column.notNull())
        .addColumn("token_digest", "varchar(64)", (column) => column.notNull())
        .addColumn("expires_at", "timestamptz", (column) => column.notNull())
        .addColumn("consumed_at", "timestamptz")
        .addColumn("consumed_by_actor_id", "varchar(100)")
        .addColumn("issued_by", "varchar(100)", (column) => column.notNull())
        .addColumn("revoked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addUniqueConstraint("participant_claim_token_digest_key", ["token_digest"])
        .addCheckConstraint(
          "participant_claim_legacy_id_check",
          sql`legacy_participant_id like 'legacy-user:%'`,
        )
        .addCheckConstraint(
          "participant_claim_consumed_pair_check",
          sql`(consumed_at is null and consumed_by_actor_id is null) or (consumed_at is not null and consumed_by_actor_id is not null)`,
        )
        .execute();
      await db.schema
        .createIndex("participant_claim_registration_idx")
        .on("participant_claim")
        .columns(["activity_id", "registration_id"])
        .execute();
      await sql`
        create unique index participant_claim_active_registration_key
          on participant_claim(registration_id)
         where consumed_at is null and revoked_at is null
      `.execute(db);
      await db.schema
        .createTable("participant_identity_link")
        .addColumn("legacy_participant_id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("linked_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addColumn("linked_by", "varchar(100)", (column) => column.notNull())
        .addColumn("claim_id", "varchar(100)", (column) =>
          column.notNull().references("participant_claim.id").onDelete("restrict"),
        )
        .addUniqueConstraint("participant_identity_link_actor_key", ["actor_id"])
        .addCheckConstraint(
          "participant_identity_link_legacy_id_check",
          sql`legacy_participant_id like 'legacy-user:%'`,
        )
        .execute();
    },
  }
