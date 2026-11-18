import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable("tournament_team")
      .addColumn("id", "varchar(100)", (column) => column.primaryKey())
      .addColumn("activity_id", "varchar(100)", (column) =>
        column.notNull().references("activity.id").onDelete("cascade"),
      )
      .addColumn("team_key", "varchar(40)", (column) => column.notNull())
      .addColumn("name", "varchar(80)", (column) => column.notNull())
      .addColumn("status", "varchar(20)", (column) => column.notNull().defaultTo("draft"))
      .addColumn("source", "varchar(20)", (column) => column.notNull().defaultTo("manual"))
      .addColumn("source_grouping_stage_id", "varchar(100)")
      .addColumn("source_revision", "integer")
      .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("created_by", "varchar(100)", (column) => column.notNull())
      .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn("withdrawn_at", "timestamptz")
      .addColumn("withdraw_reason", "text")
      .addUniqueConstraint("tournament_team_activity_key_unique", ["activity_id", "team_key"])
      .addUniqueConstraint("tournament_team_activity_name_unique", ["activity_id", "name"])
      .addCheckConstraint(
        "tournament_team_status_check",
        sql`status in ('draft', 'frozen', 'withdrawn')`,
      )
      .addCheckConstraint(
        "tournament_team_source_check",
        sql`source in ('manual', 'grouping')`,
      )
      .execute();

    await db.schema
      .createTable("tournament_team_member")
      .addColumn("id", "varchar(100)", (column) => column.primaryKey())
      .addColumn("activity_id", "varchar(100)", (column) =>
        column.notNull().references("activity.id").onDelete("cascade"),
      )
      .addColumn("team_id", "varchar(100)", (column) =>
        column.notNull().references("tournament_team.id").onDelete("cascade"),
      )
      .addColumn("participant_id", "varchar(100)", (column) => column.notNull())
      .addColumn("role", "varchar(20)", (column) => column.notNull().defaultTo("member"))
      .addColumn("added_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn("removed_at", "timestamptz")
      .addCheckConstraint(
        "tournament_team_member_role_check",
        sql`role in ('member', 'captain')`,
      )
      .execute();

    await sql`
      create unique index tournament_team_member_active_idx
      on tournament_team_member(activity_id, participant_id)
      where removed_at is null
    `.execute(db);
    await sql`
      create index tournament_team_member_team_idx
      on tournament_team_member(team_id, added_at)
    `.execute(db);
  },
  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.dropTable("tournament_team_member").ifExists().execute();
    await db.schema.dropTable("tournament_team").ifExists().execute();
  },
};
