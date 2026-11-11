import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await sql`
        alter table vote_session
          add column identity_policy varchar(20)
      `.execute(db);
      await sql`
        update vote_session
           set identity_policy = case
             when requires_ticket then 'ticket'
             when allow_browser_identity then 'browser'
             else 'anonymous'
           end
         where identity_policy is null
      `.execute(db);
      await sql`
        alter table vote_session
          alter column identity_policy set not null,
          add constraint vote_session_identity_policy_check
            check (identity_policy in ('ticket', 'browser', 'anonymous'))
      `.execute(db);
      await sql`
        alter table vote_session
          drop constraint if exists vote_session_identity_check,
          drop column requires_ticket,
          drop column allow_browser_identity
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`
        alter table vote_session
          add column requires_ticket boolean not null default false,
          add column allow_browser_identity boolean not null default false
      `.execute(db);
      await sql`
        update vote_session
           set requires_ticket = identity_policy = 'ticket',
               allow_browser_identity = identity_policy = 'browser'
      `.execute(db);
      await sql`
        alter table vote_session
          add constraint vote_session_identity_check
            check (not (requires_ticket and allow_browser_identity))
      `.execute(db);
      await sql`
        alter table vote_session
          drop constraint if exists vote_session_identity_policy_check,
          drop column identity_policy
      `.execute(db);
    },
  }
