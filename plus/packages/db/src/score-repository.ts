import type { ScoreSource } from "@artflow-plus/domain";
import { sql, type Kysely, type Selectable } from "kysely";

import { StaleRevisionError } from "./activity-repository.js";
import type {
  AdvancementDecisionRow,
  Database,
  RankingSnapshotRow,
  ScoreCorrectionRow,
  ScoreFactRow,
  ScoreRevisionRow,
  TieDecisionRow,
  PodiumCandidateRow,
} from "./types.js";

export type ScoreCorrectionState = "open" | "revised" | "closed" | "recalculated" | "cancelled";
export type RankingStatus = "ready" | "hold";
export type AdvancementStatus = "auto" | "needs_review" | "finalized";

export interface StoredScoreFact {
  readonly id: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly performanceId: string;
  readonly contestantId: string;
  readonly judgeId: string;
  readonly panelSnapshotId: string;
  readonly seatId: string;
  readonly source: ScoreSource;
  readonly total: number;
  readonly criteria: Readonly<Record<string, number>>;
  readonly notes: string;
  readonly version: number;
  readonly contextVersion: number;
  readonly current: boolean;
}

export interface StoredScoreRevision {
  readonly id: string;
  readonly scoreFactId: string;
  readonly version: number;
  readonly source: ScoreSource;
  readonly total: number;
  readonly criteria: Readonly<Record<string, number>>;
  readonly reason: string;
  readonly commandId: string;
  readonly actorId: string;
  readonly createdAt: string;
}

export interface StoredScoreCorrection {
  readonly id: string;
  readonly scoreFactId: string;
  readonly inputFingerprint: string;
  readonly state: ScoreCorrectionState;
  readonly baseVersion: number;
  readonly reason: string;
  readonly revision: number;
}

export interface StoredRankingSnapshot {
  readonly id: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly sourceScoreVersion: number;
  readonly inputFingerprint: string;
  readonly status: RankingStatus;
  readonly rows: readonly unknown[];
  readonly tieGroups: readonly unknown[];
  readonly revision: number;
}

export interface StoredAdvancementDecision {
  readonly id: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly inputFingerprint: string;
  readonly status: AdvancementStatus;
  readonly decisions: readonly unknown[];
  readonly decidedBy: string | null;
  readonly revision: number;
}

export interface StoredTieDecision {
  readonly id: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly rankingSnapshotId: string;
  readonly inputFingerprint: string;
  readonly contestants: readonly string[];
  readonly ordering: readonly string[];
  readonly reason: string;
  readonly revision: number;
}

export interface StoredPodiumCandidate {
  readonly id: string;
  readonly activityId: string;
  readonly inputFingerprint: string;
  readonly status: "candidate" | "hold";
  readonly placements: readonly unknown[];
  readonly sourceRoundIds: readonly string[];
  readonly sourceScoreVersions: readonly { readonly roundId: string; readonly sourceScoreVersion: number }[];
  readonly revision: number;
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === "string") return JSON.parse(value) as Readonly<Record<string, unknown>>;
  return (value ?? {}) as Readonly<Record<string, unknown>>;
}

function arrayValue(value: unknown): readonly unknown[] {
  if (typeof value === "string") return JSON.parse(value) as readonly unknown[];
  return Array.isArray(value) ? value : [];
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function scoreFact(row: Selectable<ScoreFactRow>): StoredScoreFact {
  return {
    id: row.id,
    activityId: row.activity_id,
    roundId: row.round_id,
    performanceId: row.performance_id,
    contestantId: row.contestant_id,
    judgeId: row.judge_id,
    panelSnapshotId: row.panel_snapshot_id,
    seatId: row.seat_id,
    source: row.source as ScoreSource,
    total: Number(row.total),
    criteria: objectValue(row.criteria) as Readonly<Record<string, number>>,
    notes: row.notes,
    version: row.version,
    contextVersion: row.context_version,
    current: row.current,
  };
}

function scoreRevision(row: Selectable<ScoreRevisionRow>): StoredScoreRevision {
  return {
    id: row.id,
    scoreFactId: row.score_fact_id,
    version: row.version,
    source: row.source as ScoreSource,
    total: Number(row.total),
    criteria: objectValue(row.criteria) as Readonly<Record<string, number>>,
    reason: row.reason,
    commandId: row.command_id,
    actorId: row.actor_id,
    createdAt: iso(row.created_at),
  };
}

function correction(row: Selectable<ScoreCorrectionRow>): StoredScoreCorrection {
  return {
    id: row.id,
    scoreFactId: row.score_fact_id,
    inputFingerprint: row.input_fingerprint,
    state: row.state as ScoreCorrectionState,
    baseVersion: row.base_version,
    reason: row.reason,
    revision: row.revision,
  };
}

function ranking(row: Selectable<RankingSnapshotRow>): StoredRankingSnapshot {
  return {
    id: row.id,
    activityId: row.activity_id,
    roundId: row.round_id,
    sourceScoreVersion: row.source_score_version,
    inputFingerprint: row.input_fingerprint,
    status: row.status as RankingStatus,
    rows: arrayValue(row.rows),
    tieGroups: arrayValue(row.tie_groups),
    revision: row.revision,
  };
}

function advancement(row: Selectable<AdvancementDecisionRow>): StoredAdvancementDecision {
  return {
    id: row.id,
    activityId: row.activity_id,
    roundId: row.round_id,
    inputFingerprint: row.input_fingerprint,
    status: row.status as AdvancementStatus,
    decisions: arrayValue(row.decisions),
    decidedBy: row.decided_by,
    revision: row.revision,
  };
}

function tieDecision(row: Selectable<TieDecisionRow>): StoredTieDecision {
  return {
    id: row.id,
    activityId: row.activity_id,
    roundId: row.round_id,
    rankingSnapshotId: row.ranking_snapshot_id,
    inputFingerprint: row.input_fingerprint,
    contestants: arrayValue(row.contestants).map(String),
    ordering: arrayValue(row.ordering).map(String),
    reason: row.reason,
    revision: row.revision,
  };
}

function podium(row: Selectable<PodiumCandidateRow>): StoredPodiumCandidate {
  return {
    id: row.id,
    activityId: row.activity_id,
    inputFingerprint: row.input_fingerprint,
    status: row.status as StoredPodiumCandidate["status"],
    placements: arrayValue(row.placements),
    sourceRoundIds: arrayValue(row.source_round_ids).map(String),
    sourceScoreVersions: arrayValue(row.source_score_versions).map((value) => {
      const item = value as { roundId?: unknown; sourceScoreVersion?: unknown };
      return { roundId: String(item.roundId), sourceScoreVersion: Number(item.sourceScoreVersion) };
    }),
    revision: row.revision,
  };
}

export async function getScoreFactForUpdate(
  trx: Kysely<Database>,
  roundId: string,
  contestantId: string,
  judgeId: string,
): Promise<StoredScoreFact | null> {
  const row = await trx.selectFrom("score_fact").selectAll()
    .where("round_id", "=", roundId).where("contestant_id", "=", contestantId)
    .where("judge_id", "=", judgeId).where("current", "=", true).forUpdate().executeTakeFirst();
  return row === undefined ? null : scoreFact(row);
}

export async function getScoreFactByIdForUpdate(
  trx: Kysely<Database>,
  id: string,
): Promise<StoredScoreFact | null> {
  const row = await trx.selectFrom("score_fact").selectAll()
    .where("id", "=", id).where("current", "=", true).forUpdate().executeTakeFirst();
  return row === undefined ? null : scoreFact(row);
}

export async function listCurrentScoreFacts(
  db: Kysely<Database>,
  roundId: string,
): Promise<readonly StoredScoreFact[]> {
  const rows = await db.selectFrom("score_fact").selectAll()
    .where("round_id", "=", roundId).where("current", "=", true)
    .orderBy("contestant_id", "asc").orderBy("judge_id", "asc").execute();
  return rows.map(scoreFact);
}

export async function countCurrentScoreFacts(
  db: Kysely<Database>,
  performanceId: string,
): Promise<number> {
  const result = await sql<{ count: number }>`
    select count(*)::int as count
      from score_fact
     where performance_id = ${performanceId}
       and current = true
  `.execute(db);
  return result.rows[0]?.count ?? 0;
}

export async function countCurrentScoreFactsForContext(
  db: Kysely<Database>,
  input: { readonly performanceId: string; readonly panelSnapshotId: string; readonly contextVersion: number },
): Promise<number> {
  const result = await sql<{ count: number }>`
    select count(*)::int as count
      from score_fact
     where performance_id = ${input.performanceId}
       and panel_snapshot_id = ${input.panelSnapshotId}
       and context_version = ${input.contextVersion}
       and current = true
  `.execute(db);
  return result.rows[0]?.count ?? 0;
}

export async function retireCurrentScoreFactsForPerformance(
  trx: Kysely<Database>,
  performanceId: string,
  contextVersion: number,
): Promise<readonly string[]> {
  const rows = await trx.updateTable("score_fact").set({
    current: false,
    updated_at: new Date(),
  }).where("performance_id", "=", performanceId).where("context_version", "<", contextVersion)
    .where("current", "=", true).returning(["id"]).execute();
  return rows.map((row) => row.id);
}

export async function insertScoreFact(db: Kysely<Database>, value: StoredScoreFact): Promise<void> {
  await db.insertInto("score_fact").values({
    id: value.id,
    activity_id: value.activityId,
    round_id: value.roundId,
    performance_id: value.performanceId,
    contestant_id: value.contestantId,
    judge_id: value.judgeId,
    panel_snapshot_id: value.panelSnapshotId,
    seat_id: value.seatId,
    source: value.source,
    total: value.total,
    criteria: JSON.stringify(value.criteria),
    notes: value.notes,
    version: value.version,
    context_version: value.contextVersion,
    current: value.current,
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
}

export async function updateScoreFact(
  trx: Kysely<Database>,
  value: StoredScoreFact,
  expectedVersion: number,
): Promise<StoredScoreFact> {
  const row = await trx.updateTable("score_fact").set({
    source: value.source,
    total: value.total,
    criteria: JSON.stringify(value.criteria),
    notes: value.notes,
    version: value.version,
    context_version: value.contextVersion,
    updated_at: new Date(),
  }).where("id", "=", value.id).where("version", "=", expectedVersion).where("current", "=", true)
    .returningAll().executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(value.id);
  return scoreFact(row);
}

export async function insertScoreRevision(db: Kysely<Database>, value: StoredScoreRevision): Promise<void> {
  await db.insertInto("score_revision").values({
    id: value.id,
    score_fact_id: value.scoreFactId,
    version: value.version,
    source: value.source,
    total: value.total,
    criteria: JSON.stringify(value.criteria),
    reason: value.reason,
    command_id: value.commandId,
    actor_id: value.actorId,
    created_at: value.createdAt,
  }).execute();
}

export async function insertCorrection(db: Kysely<Database>, value: StoredScoreCorrection): Promise<void> {
  await db.insertInto("score_correction").values({
    id: value.id,
    score_fact_id: value.scoreFactId,
    input_fingerprint: value.inputFingerprint,
    state: value.state,
    base_version: value.baseVersion,
    reason: value.reason,
    revision: value.revision,
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
}

export async function getOpenCorrectionForUpdate(trx: Kysely<Database>, scoreFactId: string): Promise<StoredScoreCorrection | null> {
  const row = await trx.selectFrom("score_correction").selectAll()
    .where("score_fact_id", "=", scoreFactId).where("state", "=", "open").forUpdate().executeTakeFirst();
  return row === undefined ? null : correction(row);
}

export async function getCorrectionForUpdate(
  trx: Kysely<Database>,
  id: string,
): Promise<StoredScoreCorrection | null> {
  const row = await trx.selectFrom("score_correction").selectAll()
    .where("id", "=", id).forUpdate().executeTakeFirst();
  return row === undefined ? null : correction(row);
}

export async function updateCorrection(
  trx: Kysely<Database>,
  value: StoredScoreCorrection,
  expectedRevision: number,
): Promise<StoredScoreCorrection> {
  const row = await trx.updateTable("score_correction").set({
    state: value.state,
    base_version: value.baseVersion,
    reason: value.reason,
    revision: value.revision,
    updated_at: new Date(),
  }).where("id", "=", value.id).where("revision", "=", expectedRevision)
    .returningAll().executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(value.id);
  return correction(row);
}

export async function insertRankingSnapshot(db: Kysely<Database>, value: StoredRankingSnapshot): Promise<void> {
  await db.insertInto("ranking_snapshot").values({
    id: value.id,
    activity_id: value.activityId,
    round_id: value.roundId,
    source_score_version: value.sourceScoreVersion,
    input_fingerprint: value.inputFingerprint,
    status: value.status,
    rows: JSON.stringify(value.rows),
    tie_groups: JSON.stringify(value.tieGroups),
    revision: value.revision,
    created_at: new Date(),
  }).execute();
}

export async function getCurrentRankingSnapshot(db: Kysely<Database>, roundId: string): Promise<StoredRankingSnapshot | null> {
  const row = await db.selectFrom("ranking_snapshot").selectAll().where("round_id", "=", roundId)
    .orderBy("revision", "desc").executeTakeFirst();
  return row === undefined ? null : ranking(row);
}

export async function insertAdvancementDecision(db: Kysely<Database>, value: StoredAdvancementDecision): Promise<void> {
  await db.insertInto("advancement_decision").values({
    id: value.id,
    activity_id: value.activityId,
    round_id: value.roundId,
    input_fingerprint: value.inputFingerprint,
    status: value.status,
    decisions: JSON.stringify(value.decisions),
    decided_by: value.decidedBy,
    revision: value.revision,
    created_at: new Date(),
  }).execute();
}

export async function getLatestAdvancementDecision(db: Kysely<Database>, roundId: string): Promise<StoredAdvancementDecision | null> {
  const row = await db.selectFrom("advancement_decision").selectAll().where("round_id", "=", roundId)
    .orderBy("revision", "desc").executeTakeFirst();
  return row === undefined ? null : advancement(row);
}

export async function insertTieDecision(db: Kysely<Database>, value: StoredTieDecision): Promise<void> {
  await db.insertInto("tie_decision").values({
    id: value.id,
    activity_id: value.activityId,
    round_id: value.roundId,
    ranking_snapshot_id: value.rankingSnapshotId,
    input_fingerprint: value.inputFingerprint,
    contestants: JSON.stringify(value.contestants),
    ordering: JSON.stringify(value.ordering),
    reason: value.reason,
    revision: value.revision,
    created_at: new Date(),
  }).execute();
}

export async function listTieDecisions(db: Kysely<Database>, roundId: string): Promise<readonly StoredTieDecision[]> {
  const rows = await db.selectFrom("tie_decision").selectAll()
    .where("round_id", "=", roundId).orderBy("revision", "asc").execute();
  return rows.map(tieDecision);
}

export async function insertPodiumCandidate(db: Kysely<Database>, value: StoredPodiumCandidate): Promise<void> {
  await db.insertInto("podium_candidate").values({
    id: value.id,
    activity_id: value.activityId,
    input_fingerprint: value.inputFingerprint,
    status: value.status,
    placements: JSON.stringify(value.placements),
    source_round_ids: JSON.stringify(value.sourceRoundIds),
    source_score_versions: JSON.stringify(value.sourceScoreVersions),
    revision: value.revision,
    created_at: new Date(),
  }).execute();
}

export async function getLatestPodiumCandidate(db: Kysely<Database>, activityId: string): Promise<StoredPodiumCandidate | null> {
  const row = await db.selectFrom("podium_candidate").selectAll()
    .where("activity_id", "=", activityId).orderBy("revision", "desc").executeTakeFirst();
  return row === undefined ? null : podium(row);
}
