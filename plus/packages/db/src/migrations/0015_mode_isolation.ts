import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await sql`
        alter table score_fact
          add column mode varchar(20) not null default 'formal',
          add constraint score_fact_mode_check check (mode in ('test', 'rehearsal', 'formal'));
        drop index if exists score_fact_current_key;
        create unique index score_fact_current_key
          on score_fact(round_id, contestant_id, judge_id, mode)
          where current = true;

        alter table vote_session
          add column mode varchar(20) not null default 'formal',
          add constraint vote_session_mode_check check (mode in ('test', 'rehearsal', 'formal'));

        alter table ranking_snapshot
          add column mode varchar(20) not null default 'formal',
          add constraint ranking_snapshot_mode_check check (mode in ('test', 'rehearsal', 'formal'));
        create index ranking_snapshot_round_mode_idx
          on ranking_snapshot(round_id, mode, revision desc);
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`
        drop index if exists ranking_snapshot_round_mode_idx;
        alter table ranking_snapshot drop constraint if exists ranking_snapshot_mode_check;
        alter table ranking_snapshot drop column if exists mode;
        alter table vote_session drop constraint if exists vote_session_mode_check;
        alter table vote_session drop column if exists mode;
        drop index if exists score_fact_current_key;
        alter table score_fact drop constraint if exists score_fact_mode_check;
        alter table score_fact drop column if exists mode;
        create unique index score_fact_current_key
          on score_fact(round_id, contestant_id, judge_id)
          where current = true;
      `.execute(db);
    },
  }
