import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("stage_result")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("stage_key", "varchar(100)", (column) => column.notNull())
        .addColumn("status", "varchar(30)", (column) => column.notNull())
        .addColumn("candidate_revision", "integer", (column) => column.notNull())
        .addColumn("source_candidate_revision", "integer", (column) => column.notNull())
        .addColumn("input_fingerprint", "varchar(128)", (column) => column.notNull())
        .addColumn("decisions", "jsonb", (column) => column.notNull())
        .addColumn("awards", "jsonb", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("confirmed_at", "timestamptz")
        .addColumn("unlocked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("stage_result_status_check", sql`status in ('confirmed', 'ready_to_confirm')`)
        .addCheckConstraint(
          "stage_result_revision_check",
          sql`candidate_revision >= 1 and source_candidate_revision >= 1`,
        )
        .addUniqueConstraint("stage_result_activity_stage_key", ["activity_id", "stage_key"])
        .addUniqueConstraint("stage_result_activity_id_key", ["activity_id", "id"])
        .execute();

      await db.schema
        .createTable("result_publication")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("stage_key", "varchar(100)", (column) => column.notNull())
        .addColumn("title", "varchar(300)", (column) => column.notNull())
        .addColumn("content", "text", (column) => column.notNull())
        .addColumn("version", "integer", (column) => column.notNull().defaultTo(1))
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("result_publication_version_check", sql`version >= 1`)
        .addUniqueConstraint("result_publication_activity_stage_key", ["activity_id", "stage_key"])
        .addUniqueConstraint("result_publication_activity_id_key", ["activity_id", "id"])
        .execute();

      await db.schema
        .createTable("result_release")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("publication_id", "varchar(100)", (column) => column.notNull())
        .addColumn("stage_result_id", "varchar(100)", (column) => column.notNull())
        .addColumn("stage_key", "varchar(100)", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("snapshot", "jsonb", (column) => column.notNull())
        .addColumn("snapshot_candidate_revision", "integer", (column) => column.notNull())
        .addColumn("result_version", "integer", (column) => column.notNull())
        .addColumn("post_version", "integer", (column) => column.notNull())
        .addColumn("input_fingerprint", "varchar(128)", (column) => column.notNull())
        .addColumn("note", "text", (column) => column.notNull())
        .addColumn("released_at", "timestamptz", (column) => column.notNull())
        .addColumn("revoked_at", "timestamptz")
        .addColumn("superseded_at", "timestamptz")
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint(
          "result_release_status_check",
          sql`status in ('active', 'revoked', 'superseded')`,
        )
        .execute();

      await sql`
        alter table result_release
          add constraint result_release_publication_activity_fk
            foreign key (activity_id, publication_id)
            references result_publication (activity_id, id)
            on delete restrict,
          add constraint result_release_stage_result_activity_fk
            foreign key (activity_id, stage_result_id)
            references stage_result (activity_id, id)
            on delete restrict
      `.execute(db);
      await sql`
        create unique index result_release_active_key
          on result_release (activity_id, stage_key)
          where status = 'active'
      `.execute(db);
      await sql`
        create index result_release_history_idx
          on result_release (activity_id, stage_key, released_at)
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`drop index if exists result_release_history_idx`.execute(db);
      await sql`drop index if exists result_release_active_key`.execute(db);
      await db.schema.dropTable("result_release").ifExists().execute();
      await db.schema.dropTable("result_publication").ifExists().execute();
      await db.schema.dropTable("stage_result").ifExists().execute();
    },
  }
