import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("competition_round")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_key", "varchar(100)", (column) => column.notNull())
        .addColumn("release_version", "integer", (column) => column.notNull())
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("score_version", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("minimum_judges", "integer", (column) => column.notNull())
        .addColumn("judge_count", "integer", (column) => column.notNull())
        .addColumn("completion_mode", "varchar(20)", (column) => column.notNull())
        .addColumn("advance_count", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("current_panel_id", "varchar(100)")
        .addColumn("locked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("competition_round_state_check", sql`state in ('prepared', 'scoring', 'locked')`)
        .addCheckConstraint("competition_round_judge_count_check", sql`judge_count >= 1 and minimum_judges >= 1 and minimum_judges <= judge_count`)
        .addCheckConstraint("competition_round_revision_check", sql`revision >= 0 and score_version >= 0 and advance_count >= 0`)
        .execute();
      await sql`create unique index competition_round_activity_key on competition_round(activity_id, round_key)`.execute(db);

      await db.schema
        .createTable("panel_snapshot")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_id", "varchar(100)", (column) => column.notNull().references("competition_round.id").onDelete("restrict"))
        .addColumn("version", "integer", (column) => column.notNull())
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("expected_judges", "integer", (column) => column.notNull())
        .addColumn("minimum_judges", "integer", (column) => column.notNull())
        .addColumn("roster_digest", "varchar(64)", (column) => column.notNull())
        .addColumn("context_version", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("current", "boolean", (column) => column.notNull().defaultTo(true))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("panel_snapshot_state_check", sql`state in ('active', 'hold', 'superseded')`)
        .addCheckConstraint("panel_snapshot_judge_count_check", sql`expected_judges >= 1 and minimum_judges >= 1 and minimum_judges <= expected_judges`)
        .execute();
      await sql`create unique index panel_snapshot_round_version on panel_snapshot(round_id, version)`.execute(db);
      await sql`create unique index panel_snapshot_one_current on panel_snapshot(round_id) where current = true`.execute(db);

      await db.schema
        .createTable("panel_member")
        .addColumn("panel_id", "varchar(100)", (column) => column.notNull().references("panel_snapshot.id").onDelete("restrict"))
        .addColumn("judge_id", "varchar(100)", (column) => column.notNull())
        .addColumn("seat_key", "varchar(100)", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint("panel_member_pkey", ["panel_id", "judge_id"])
        .execute();
      await sql`create unique index panel_member_seat_key on panel_member(panel_id, seat_key)`.execute(db);

      await db.schema
        .createTable("judge_seat")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("panel_id", "varchar(100)", (column) => column.notNull().references("panel_snapshot.id").onDelete("restrict"))
        .addColumn("judge_id", "varchar(100)", (column) => column.notNull())
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("judge_seat_state_check", sql`state in ('assigned', 'revoked', 'hold')`)
        .execute();
      await sql`create unique index judge_seat_panel_judge_key on judge_seat(panel_id, judge_id)`.execute(db);

      await db.schema
        .createTable("performance")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_id", "varchar(100)", (column) => column.notNull().references("competition_round.id").onDelete("restrict"))
        .addColumn("contestant_id", "varchar(100)", (column) => column.notNull())
        .addColumn("sequence", "integer", (column) => column.notNull())
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("context_version", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("performance_state_check", sql`state in ('not_opened', 'open', 'locked')`)
        .addCheckConstraint("performance_sequence_check", sql`sequence >= 1 and context_version >= 0`)
        .addUniqueConstraint("performance_round_contestant_key", ["round_id", "contestant_id"])
        .execute();

      await db.schema
        .createTable("performance_score_state")
        .addColumn("performance_id", "varchar(100)", (column) => column.primaryKey().references("performance.id").onDelete("restrict"))
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("context_version", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("opened_at", "timestamptz")
        .addColumn("locked_at", "timestamptz")
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("performance_score_state_check", sql`state in ('not_opened', 'open', 'locked') and context_version >= 0 and revision >= 0`)
        .execute();

      await db.schema
        .createTable("score_fact")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_id", "varchar(100)", (column) => column.notNull().references("competition_round.id").onDelete("restrict"))
        .addColumn("performance_id", "varchar(100)", (column) => column.notNull().references("performance.id").onDelete("restrict"))
        .addColumn("contestant_id", "varchar(100)", (column) => column.notNull())
        .addColumn("judge_id", "varchar(100)", (column) => column.notNull())
        .addColumn("panel_snapshot_id", "varchar(100)", (column) => column.notNull().references("panel_snapshot.id").onDelete("restrict"))
        .addColumn("seat_id", "varchar(100)", (column) => column.notNull().references("judge_seat.id").onDelete("restrict"))
        .addColumn("source", "varchar(20)", (column) => column.notNull())
        .addColumn("total", "numeric", (column) => column.notNull())
        .addColumn("criteria", "jsonb", (column) => column.notNull())
        .addColumn("notes", "text", (column) => column.notNull().defaultTo(""))
        .addColumn("version", "integer", (column) => column.notNull().defaultTo(1))
        .addColumn("context_version", "integer", (column) => column.notNull())
        .addColumn("current", "boolean", (column) => column.notNull().defaultTo(true))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("score_fact_source_check", sql`source in ('direct_judge', 'staff_rapid', 'staff_proxy', 'paper_dr')`)
        .addCheckConstraint("score_fact_version_check", sql`version >= 1 and context_version >= 0`)
        .execute();
      await sql`create unique index score_fact_current_key on score_fact(round_id, contestant_id, judge_id) where current = true`.execute(db);

      await db.schema
        .createTable("score_revision")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("score_fact_id", "varchar(100)", (column) => column.notNull().references("score_fact.id").onDelete("restrict"))
        .addColumn("version", "integer", (column) => column.notNull())
        .addColumn("source", "varchar(20)", (column) => column.notNull())
        .addColumn("total", "numeric", (column) => column.notNull())
        .addColumn("criteria", "jsonb", (column) => column.notNull())
        .addColumn("reason", "text", (column) => column.notNull())
        .addColumn("command_id", "varchar(100)", (column) => column.notNull())
        .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) => column.notNull())
        .addUniqueConstraint("score_revision_fact_version_key", ["score_fact_id", "version"])
        .execute();

      await db.schema
        .createTable("score_correction")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("score_fact_id", "varchar(100)", (column) => column.notNull().references("score_fact.id").onDelete("restrict"))
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("base_version", "integer", (column) => column.notNull())
        .addColumn("reason", "text", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("score_correction_state_check", sql`state in ('open', 'revised', 'closed', 'cancelled')`)
        .execute();
      await sql`create unique index score_correction_one_open on score_correction(score_fact_id) where state = 'open'`.execute(db);

      await db.schema
        .createTable("ranking_snapshot")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_id", "varchar(100)", (column) => column.notNull().references("competition_round.id").onDelete("restrict"))
        .addColumn("source_score_version", "integer", (column) => column.notNull())
        .addColumn("input_fingerprint", "varchar(64)", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("rows", "jsonb", (column) => column.notNull())
        .addColumn("tie_groups", "jsonb", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("ranking_snapshot_status_check", sql`status in ('ready', 'hold')`)
        .execute();
      await sql`create index ranking_snapshot_round_idx on ranking_snapshot(round_id, revision desc)`.execute(db);

      await db.schema
        .createTable("advancement_decision")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("round_id", "varchar(100)", (column) => column.notNull().references("competition_round.id").onDelete("restrict"))
        .addColumn("input_fingerprint", "varchar(64)", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("decisions", "jsonb", (column) => column.notNull())
        .addColumn("decided_by", "varchar(100)")
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("advancement_decision_status_check", sql`status in ('auto', 'needs_review', 'finalized')`)
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("advancement_decision").ifExists().execute();
      await sql`drop index if exists ranking_snapshot_round_idx`.execute(db);
      await db.schema.dropTable("ranking_snapshot").ifExists().execute();
      await sql`drop index if exists score_correction_one_open`.execute(db);
      await db.schema.dropTable("score_correction").ifExists().execute();
      await db.schema.dropTable("score_revision").ifExists().execute();
      await sql`drop index if exists score_fact_current_key`.execute(db);
      await db.schema.dropTable("score_fact").ifExists().execute();
      await db.schema.dropTable("performance_score_state").ifExists().execute();
      await db.schema.dropTable("performance").ifExists().execute();
      await sql`drop index if exists judge_seat_panel_judge_key`.execute(db);
      await db.schema.dropTable("judge_seat").ifExists().execute();
      await sql`drop index if exists panel_member_seat_key`.execute(db);
      await db.schema.dropTable("panel_member").ifExists().execute();
      await sql`drop index if exists panel_snapshot_one_current`.execute(db);
      await sql`drop index if exists panel_snapshot_round_version`.execute(db);
      await db.schema.dropTable("panel_snapshot").ifExists().execute();
      await sql`drop index if exists competition_round_activity_key`.execute(db);
      await db.schema.dropTable("competition_round").ifExists().execute();
    },
  }
