import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .alterTable("material")
        .addColumn("content_ready", "boolean", (column) => column.notNull().defaultTo(true))
        .execute();
      await db.schema
        .alterTable("registration")
        .addColumn("supplement_keys", "jsonb", (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
        .execute();
      await sql`
        create table material_check (
          id varchar(100) primary key,
          activity_id varchar(100) not null references activity(id) on delete cascade,
          registration_id varchar(100) not null references registration(id) on delete cascade,
          slot_key varchar(100) not null,
          item_name varchar(200) not null,
          purpose varchar(24) not null default '',
          accepted_purposes jsonb not null default '[]'::jsonb,
          status varchar(20) not null default 'missing'
            check (status in ('missing', 'uploaded', 'approved', 'needs_supplement')),
          required boolean not null default true,
          review_note text not null default '',
          revision integer not null default 0,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique (registration_id, slot_key)
        );
        create index material_check_activity_idx on material_check(activity_id, status);

        create table supplement_grant (
          id varchar(100) primary key,
          activity_id varchar(100) not null references activity(id) on delete cascade,
          registration_id varchar(100) not null references registration(id) on delete cascade,
          token_digest varchar(64) not null unique,
          allowed_keys jsonb not null default '[]'::jsonb,
          expires_at timestamptz not null,
          revoked_at timestamptz,
          created_by varchar(100) not null,
          created_at timestamptz not null default now()
        );
        create index supplement_grant_registration_idx on supplement_grant(registration_id);
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`
        drop table if exists supplement_grant;
        drop table if exists material_check;
      `.execute(db);
      await db.schema.alterTable("registration").dropColumn("supplement_keys").execute();
      await db.schema.alterTable("material").dropColumn("content_ready").execute();
    },
  }
