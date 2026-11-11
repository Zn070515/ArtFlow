import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema.alterTable("competition_round")
        .addColumn("scoring_method", "varchar(30)", (column) => column.notNull().defaultTo("average"))
        .execute();
      await db.schema
        .createTable("tie_decision")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_id", "varchar(100)", (column) => column.notNull().references("competition_round.id").onDelete("restrict"))
        .addColumn("ranking_snapshot_id", "varchar(100)", (column) => column.notNull().references("ranking_snapshot.id").onDelete("restrict"))
        .addColumn("input_fingerprint", "varchar(64)", (column) => column.notNull())
        .addColumn("contestants", "jsonb", (column) => column.notNull())
        .addColumn("ordering", "jsonb", (column) => column.notNull())
        .addColumn("reason", "text", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema
        .createTable("podium_candidate")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("input_fingerprint", "varchar(64)", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("placements", "jsonb", (column) => column.notNull())
        .addColumn("source_round_ids", "jsonb", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("podium_candidate_status_check", sql`status in ('candidate', 'hold')`)
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("podium_candidate").ifExists().execute();
      await db.schema.dropTable("tie_decision").ifExists().execute();
      await db.schema.alterTable("competition_round").dropColumn("scoring_method").execute();
    },
  }
