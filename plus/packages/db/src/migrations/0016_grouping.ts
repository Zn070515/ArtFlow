import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await sql`
        create table grouping_stage (
          id varchar(100) primary key,
          activity_id varchar(100) not null references activity(id) on delete cascade,
          stage_key varchar(100) not null,
          name varchar(200) not null,
          status varchar(20) not null default 'draft'
            check (status in ('draft', 'confirmed', 'frozen', 'cancelled')),
          roster_source varchar(20) not null default 'all_approved'
            check (roster_source in ('all_approved', 'round_advanced')),
          source_round_id varchar(100) references competition_round(id),
          source_fingerprint varchar(128) not null default '',
          material_window varchar(20) not null default 'closed'
            check (material_window in ('closed', 'open', 'supplement_only')),
          cancel_reason text not null default '',
          confirmed_at timestamptz,
          confirmed_by varchar(100),
          frozen_at timestamptz,
          frozen_by varchar(100),
          cancelled_at timestamptz,
          cancelled_by varchar(100),
          revision integer not null default 1,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique (activity_id, stage_key),
          check (
            (roster_source = 'round_advanced' and source_round_id is not null) or
            (roster_source = 'all_approved' and source_round_id is null)
          )
        );
        create index grouping_stage_activity_idx on grouping_stage(activity_id, revision);

        create table grouping_group (
          id varchar(100) primary key,
          stage_id varchar(100) not null references grouping_stage(id) on delete cascade,
          group_order integer not null check (group_order >= 1),
          name varchar(200) not null,
          is_active boolean not null default true,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
        create unique index grouping_group_active_order_key
          on grouping_group(stage_id, group_order) where is_active = true;

        create table grouping_membership (
          id varchar(100) primary key,
          stage_id varchar(100) not null references grouping_stage(id) on delete cascade,
          group_id varchar(100) not null references grouping_group(id) on delete cascade,
          participant_id varchar(100) not null,
          is_current boolean not null default true,
          joined_at timestamptz not null default now(),
          left_at timestamptz,
          removed_by varchar(100),
          reason text not null default ''
        );
        create unique index grouping_membership_current_key
          on grouping_membership(stage_id, participant_id) where is_current = true;
        create index grouping_membership_group_idx
          on grouping_membership(group_id) where is_current = true;
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`
        drop table if exists grouping_membership;
        drop table if exists grouping_group;
        drop table if exists grouping_stage;
      `.execute(db);
    },
  }
