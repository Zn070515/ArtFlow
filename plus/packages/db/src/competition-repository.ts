import { sql, type Kysely, type Selectable } from "kysely";

import { StaleRevisionError } from "./activity-repository.js";
import type {
  CompetitionRoundRow,
  Database,
  JudgeSeatRow,
  PanelMemberRow,
  PanelSnapshotRow,
  PerformanceRow,
  PerformanceScoreStateRow,
} from "./types.js";

export type RoundState = "prepared" | "scoring" | "locked";
export type PanelState = "active" | "hold" | "superseded";
export type JudgeSeatState = "assigned" | "revoked" | "hold";
export type PerformanceState = "not_opened" | "open" | "locked";
export type PerformanceScoreState = PerformanceState;

export interface StoredRound {
  readonly id: string;
  readonly activityId: string;
  readonly roundKey: string;
  readonly releaseVersion: number;
  readonly state: RoundState;
  readonly revision: number;
  readonly scoreVersion: number;
  readonly minimumJudges: number;
  readonly judgeCount: number;
  readonly completionMode: "full_matrix" | "minimum_valid";
  readonly scoringMethod?: "average" | "drop_high_low";
  readonly advanceCount: number;
  readonly currentPanelId: string | null;
  readonly lockedAt: string | null;
}

export interface StoredPanelSnapshot {
  readonly id: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly version: number;
  readonly state: PanelState;
  readonly expectedJudges: number;
  readonly minimumJudges: number;
  readonly rosterDigest: string;
  readonly contextVersion: number;
  readonly current: boolean;
}

export interface StoredPanelMember {
  readonly panelId: string;
  readonly judgeId: string;
  readonly seatKey: string;
}

export interface StoredJudgeSeat {
  readonly id: string;
  readonly panelId: string;
  readonly judgeId: string;
  readonly state: JudgeSeatState;
  readonly revision: number;
}

export interface StoredPerformance {
  readonly id: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly contestantId: string;
  readonly sequence: number;
  readonly state: PerformanceState;
  readonly contextVersion: number;
}

export interface StoredPerformanceScoreState {
  readonly performanceId: string;
  readonly state: PerformanceScoreState;
  readonly contextVersion: number;
  readonly revision: number;
  readonly openedAt: string | null;
  readonly lockedAt: string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function round(row: Selectable<CompetitionRoundRow>): StoredRound {
  return {
    id: row.id,
    activityId: row.activity_id,
    roundKey: row.round_key,
    releaseVersion: row.release_version,
    state: row.state as RoundState,
    revision: row.revision,
    scoreVersion: row.score_version,
    minimumJudges: row.minimum_judges,
    judgeCount: row.judge_count,
    completionMode: row.completion_mode as StoredRound["completionMode"],
    scoringMethod: row.scoring_method as StoredRound["scoringMethod"],
    advanceCount: row.advance_count,
    currentPanelId: row.current_panel_id,
    lockedAt: iso(row.locked_at),
  };
}

function panel(row: Selectable<PanelSnapshotRow>): StoredPanelSnapshot {
  return {
    id: row.id,
    activityId: row.activity_id,
    roundId: row.round_id,
    version: row.version,
    state: row.state as PanelState,
    expectedJudges: row.expected_judges,
    minimumJudges: row.minimum_judges,
    rosterDigest: row.roster_digest,
    contextVersion: row.context_version,
    current: row.current,
  };
}

function member(row: Selectable<PanelMemberRow>): StoredPanelMember {
  return { panelId: row.panel_id, judgeId: row.judge_id, seatKey: row.seat_key };
}

function seat(row: Selectable<JudgeSeatRow>): StoredJudgeSeat {
  return { id: row.id, panelId: row.panel_id, judgeId: row.judge_id, state: row.state as JudgeSeatState, revision: row.revision };
}

function performance(row: Selectable<PerformanceRow>): StoredPerformance {
  return {
    id: row.id,
    activityId: row.activity_id,
    roundId: row.round_id,
    contestantId: row.contestant_id,
    sequence: row.sequence,
    state: row.state as PerformanceState,
    contextVersion: row.context_version,
  };
}

function performanceScoreState(row: Selectable<PerformanceScoreStateRow>): StoredPerformanceScoreState {
  return {
    performanceId: row.performance_id,
    state: row.state as PerformanceScoreState,
    contextVersion: row.context_version,
    revision: row.revision,
    openedAt: iso(row.opened_at),
    lockedAt: iso(row.locked_at),
  };
}

export async function insertRound(db: Kysely<Database>, value: StoredRound): Promise<void> {
  await db.insertInto("competition_round").values({
    id: value.id,
    activity_id: value.activityId,
    round_key: value.roundKey,
    release_version: value.releaseVersion,
    state: value.state,
    revision: value.revision,
    score_version: value.scoreVersion,
    minimum_judges: value.minimumJudges,
    judge_count: value.judgeCount,
    completion_mode: value.completionMode,
    scoring_method: value.scoringMethod ?? "average",
    advance_count: value.advanceCount,
    current_panel_id: value.currentPanelId,
    locked_at: value.lockedAt,
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
}

export async function listRoundsForActivity(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredRound[]> {
  const rows = await db.selectFrom("competition_round").selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("round_key", "asc")
    .execute();
  return rows.map(round);
}

export async function getRoundForUpdate(trx: Kysely<Database>, id: string): Promise<StoredRound | null> {
  const row = await trx.selectFrom("competition_round").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
  return row === undefined ? null : round(row);
}

export async function getRoundByKeyForUpdate(
  trx: Kysely<Database>,
  activityId: string,
  roundKey: string,
): Promise<StoredRound | null> {
  const row = await trx.selectFrom("competition_round").selectAll()
    .where("activity_id", "=", activityId).where("round_key", "=", roundKey).forUpdate().executeTakeFirst();
  return row === undefined ? null : round(row);
}

export async function getRoundByKey(
  db: Kysely<Database>,
  activityId: string,
  roundKey: string,
): Promise<StoredRound | null> {
  const row = await db.selectFrom("competition_round").selectAll()
    .where("activity_id", "=", activityId).where("round_key", "=", roundKey)
    .executeTakeFirst();
  return row === undefined ? null : round(row);
}

export async function updateRound(
  trx: Kysely<Database>,
  value: StoredRound,
  expectedRevision: number,
): Promise<StoredRound> {
  const row = await trx.updateTable("competition_round").set({
    state: value.state,
    revision: value.revision,
    score_version: value.scoreVersion,
    current_panel_id: value.currentPanelId,
    locked_at: value.lockedAt,
    updated_at: new Date(),
  }).where("id", "=", value.id).where("revision", "=", expectedRevision).returningAll().executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(value.id);
  return round(row);
}

export async function getNextPanelVersion(
  db: Kysely<Database>,
  roundId: string,
): Promise<number> {
  const result = await sql<{ version: number | string | null }>`
    select coalesce(max(version), 0)::int as version
      from panel_snapshot
     where round_id = ${roundId}
  `.execute(db);
  return Number(result.rows[0]?.version ?? 0) + 1;
}

export async function insertPanelSnapshot(db: Kysely<Database>, value: StoredPanelSnapshot): Promise<void> {
  await db.insertInto("panel_snapshot").values({
    id: value.id,
    activity_id: value.activityId,
    round_id: value.roundId,
    version: value.version,
    state: value.state,
    expected_judges: value.expectedJudges,
    minimum_judges: value.minimumJudges,
    roster_digest: value.rosterDigest,
    context_version: value.contextVersion,
    current: value.current,
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
}

export async function getPanel(
  db: Kysely<Database>,
  panelId: string,
): Promise<StoredPanelSnapshot | null> {
  const row = await db.selectFrom("panel_snapshot").selectAll().where("id", "=", panelId).executeTakeFirst();
  return row === undefined ? null : panel(row);
}

export async function listJudgeSeatsForPanel(
  db: Kysely<Database>,
  panelId: string,
): Promise<readonly StoredJudgeSeat[]> {
  const rows = await db.selectFrom("judge_seat").selectAll()
    .where("panel_id", "=", panelId)
    .orderBy("judge_id", "asc")
    .execute();
  return rows.map(seat);
}

export async function getPanelMember(
  db: Kysely<Database>,
  panelId: string,
  judgeId: string,
): Promise<{ readonly panelId: string; readonly judgeId: string; readonly seatKey: string } | null> {
  const row = await db.selectFrom("panel_member").selectAll()
    .where("panel_id", "=", panelId)
    .where("judge_id", "=", judgeId)
    .executeTakeFirst();
  return row === undefined ? null : member(row);
}

export async function getPanelMemberBySeatKey(
  db: Kysely<Database>,
  panelId: string,
  seatKey: string,
): Promise<{ readonly panelId: string; readonly judgeId: string; readonly seatKey: string } | null> {
  const row = await db.selectFrom("panel_member").selectAll()
    .where("panel_id", "=", panelId)
    .where("seat_key", "=", seatKey)
    .executeTakeFirst();
  return row === undefined ? null : member(row);
}

export async function getJudgeSeatByPanelAndJudge(
  db: Kysely<Database>,
  panelId: string,
  judgeId: string,
): Promise<StoredJudgeSeat | null> {
  const row = await db.selectFrom("judge_seat").selectAll()
    .where("panel_id", "=", panelId)
    .where("judge_id", "=", judgeId)
    .executeTakeFirst();
  return row === undefined ? null : seat(row);
}

export interface CurrentPanelMember {
  readonly panelId: string;
  readonly roundId: string;
  readonly judgeId: string;
  readonly seatKey: string;
}

/** A seat key repeats across rounds, so every current panel that holds it is returned. */
export async function listCurrentPanelMembersBySeatKey(
  db: Kysely<Database>,
  activityId: string,
  seatKey: string,
): Promise<readonly CurrentPanelMember[]> {
  const rows = await db
    .selectFrom("panel_snapshot")
    .innerJoin("panel_member", "panel_member.panel_id", "panel_snapshot.id")
    .select([
      "panel_snapshot.id as panel_id",
      "panel_snapshot.round_id as round_id",
      "panel_member.judge_id as judge_id",
      "panel_member.seat_key as seat_key",
    ])
    .where("panel_snapshot.activity_id", "=", activityId)
    .where("panel_snapshot.current", "=", true)
    .where("panel_member.seat_key", "=", seatKey)
    .orderBy("panel_snapshot.round_id", "asc")
    .execute();
  return rows.map((row) => ({
    panelId: row.panel_id,
    roundId: row.round_id,
    judgeId: row.judge_id,
    seatKey: row.seat_key,
  }));
}

export async function getJudgeSeat(
  db: Kysely<Database>,
  seatId: string,
): Promise<StoredJudgeSeat | null> {
  const row = await db.selectFrom("judge_seat").selectAll().where("id", "=", seatId).executeTakeFirst();
  return row === undefined ? null : seat(row);
}

export async function getRound(
  db: Kysely<Database>,
  roundId: string,
): Promise<StoredRound | null> {
  const row = await db.selectFrom("competition_round").selectAll().where("id", "=", roundId).executeTakeFirst();
  return row === undefined ? null : round(row);
}

export async function getPerformance(
  db: Kysely<Database>,
  performanceId: string,
): Promise<StoredPerformance | null> {
  const row = await db.selectFrom("performance").selectAll().where("id", "=", performanceId).executeTakeFirst();
  return row === undefined ? null : performance(row);
}

export async function getPerformanceScoreState(
  db: Kysely<Database>,
  performanceId: string,
): Promise<StoredPerformanceScoreState | null> {
  const row = await db.selectFrom("performance_score_state").selectAll()
    .where("performance_id", "=", performanceId)
    .executeTakeFirst();
  return row === undefined ? null : performanceScoreState(row);
}

export async function deletePerformancesForRound(
  trx: Kysely<Database>,
  roundId: string,
): Promise<number> {
  const rows = await trx.selectFrom("performance").select("id")
    .where("round_id", "=", roundId)
    .execute();
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await trx.deleteFrom("performance_score_state").where("performance_id", "in", ids).execute();
    await trx.deleteFrom("performance").where("id", "in", ids).execute();
  }
  return ids.length;
}

export async function supersedeCurrentPanelForRound(
  trx: Kysely<Database>,
  roundId: string,
): Promise<void> {
  await trx.updateTable("panel_snapshot")
    .set({ current: false, state: "superseded" })
    .where("round_id", "=", roundId)
    .where("current", "=", true)
    .execute();
}

export async function getCurrentPanelForUpdate(trx: Kysely<Database>, roundId: string): Promise<StoredPanelSnapshot | null> {
  const row = await trx.selectFrom("panel_snapshot").selectAll()
    .where("round_id", "=", roundId).where("current", "=", true).forUpdate().executeTakeFirst();
  return row === undefined ? null : panel(row);
}

export async function updatePanelSnapshot(
  trx: Kysely<Database>,
  value: StoredPanelSnapshot,
  expectedVersion: number,
): Promise<StoredPanelSnapshot> {
  const row = await trx.updateTable("panel_snapshot").set({
    state: value.state,
    context_version: value.contextVersion,
    current: value.current,
    updated_at: new Date(),
  }).where("id", "=", value.id).where("version", "=", expectedVersion)
    .returningAll().executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(value.id);
  return panel(row);
}

export async function insertPanelMember(db: Kysely<Database>, value: StoredPanelMember): Promise<void> {
  await db.insertInto("panel_member").values({
    panel_id: value.panelId,
    judge_id: value.judgeId,
    seat_key: value.seatKey,
    created_at: new Date(),
  }).execute();
}

export async function listPanelMembers(db: Kysely<Database>, panelId: string): Promise<readonly StoredPanelMember[]> {
  const rows = await db.selectFrom("panel_member").selectAll().where("panel_id", "=", panelId).orderBy("seat_key").execute();
  return rows.map(member);
}

export async function insertJudgeSeat(db: Kysely<Database>, value: StoredJudgeSeat): Promise<void> {
  await db.insertInto("judge_seat").values({
    id: value.id,
    panel_id: value.panelId,
    judge_id: value.judgeId,
    state: value.state,
    revision: value.revision,
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
}

export async function getJudgeSeatForUpdate(trx: Kysely<Database>, id: string): Promise<StoredJudgeSeat | null> {
  const row = await trx.selectFrom("judge_seat").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
  return row === undefined ? null : seat(row);
}

export async function insertPerformance(db: Kysely<Database>, value: StoredPerformance): Promise<void> {
  await db.insertInto("performance").values({
    id: value.id,
    activity_id: value.activityId,
    round_id: value.roundId,
    contestant_id: value.contestantId,
    sequence: value.sequence,
    state: value.state,
    context_version: value.contextVersion,
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
  await db.insertInto("performance_score_state").values({
    performance_id: value.id,
    state: value.state,
    context_version: value.contextVersion,
    revision: 0,
    opened_at: value.state === "open" ? new Date() : null,
    locked_at: value.state === "locked" ? new Date() : null,
    updated_at: new Date(),
  }).execute();
}

export async function updatePerformance(
  trx: Kysely<Database>,
  value: StoredPerformance,
  expectedContextVersion: number,
): Promise<StoredPerformance> {
  const row = await trx.updateTable("performance").set({
    state: value.state,
    context_version: value.contextVersion,
    updated_at: new Date(),
  }).where("id", "=", value.id).where("context_version", "=", expectedContextVersion)
    .returningAll().executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(value.id);
  return performance(row);
}

export async function getPerformanceForUpdate(trx: Kysely<Database>, id: string): Promise<StoredPerformance | null> {
  const row = await trx.selectFrom("performance").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
  return row === undefined ? null : performance(row);
}

export async function getPerformanceScoreStateForUpdate(
  trx: Kysely<Database>,
  performanceId: string,
): Promise<StoredPerformanceScoreState | null> {
  const row = await trx.selectFrom("performance_score_state").selectAll()
    .where("performance_id", "=", performanceId).forUpdate().executeTakeFirst();
  return row === undefined ? null : performanceScoreState(row);
}

export async function updatePerformanceScoreState(
  trx: Kysely<Database>,
  value: StoredPerformanceScoreState,
  expectedRevision: number,
): Promise<StoredPerformanceScoreState> {
  const row = await trx.updateTable("performance_score_state").set({
    state: value.state,
    context_version: value.contextVersion,
    revision: value.revision,
    opened_at: value.openedAt,
    locked_at: value.lockedAt,
    updated_at: new Date(),
  }).where("performance_id", "=", value.performanceId).where("revision", "=", expectedRevision).returningAll().executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(value.performanceId);
  return performanceScoreState(row);
}

export async function listRoundPerformances(db: Kysely<Database>, roundId: string): Promise<readonly StoredPerformance[]> {
  const rows = await db.selectFrom("performance").selectAll().where("round_id", "=", roundId).orderBy("sequence").execute();
  return rows.map(performance);
}

export async function countCurrentPanelMembers(db: Kysely<Database>, panelId: string): Promise<number> {
  const result = await sql<{ count: number }>`select count(*)::int as count from panel_member where panel_id = ${panelId}`.execute(db);
  return result.rows[0]?.count ?? 0;
}
