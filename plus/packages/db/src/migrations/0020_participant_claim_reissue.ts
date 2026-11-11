import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .alterTable("participant_claim")
        .addColumn("revoked_at", "timestamptz")
        .execute();
      await sql`
        with ranked_claims as (
          select id,
                 row_number() over (
                   partition by registration_id
                   order by created_at desc, id desc
                 ) as claim_rank
            from participant_claim
           where consumed_at is null
             and revoked_at is null
        )
        update participant_claim as claim
           set revoked_at = now()
          from ranked_claims
         where claim.id = ranked_claims.id
           and ranked_claims.claim_rank > 1
      `.execute(db);
      await sql`
        create unique index participant_claim_active_registration_key
          on participant_claim(registration_id)
         where consumed_at is null and revoked_at is null
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`drop index if exists participant_claim_active_registration_key`.execute(db);
      await db.schema
        .alterTable("participant_claim")
        .dropColumn("revoked_at")
        .execute();
    },
  }
