import { isResultSnapshot } from "@artflow-plus/domain";
import type {
  ResultAward,
  ResultDecision,
  ResultSnapshot,
} from "@artflow-plus/domain";
import type { Kysely, Selectable } from "kysely";

import type {
  Database,
  ResultPublicationRow,
  ResultReleaseRow,
  StageResultRow,
} from "./types.js";

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function json(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

export interface StoredResultSource {
  readonly kind: "podium_candidate" | "vote_session" | "legacy_import";
  readonly aggregateId: string;
  readonly definitionVersion: number;
  readonly releaseHash: string;
  readonly mode: "test" | "rehearsal" | "formal";
  readonly sourceRevision: number;
  readonly inputFingerprint: string;
  /**
   * The upstream aggregates this result actually consumed. A score edit only
   * invalidates results whose dependency set intersects its round; a vote
   * security action only invalidates the affected vote session.
   */
  readonly dependencyIds?: readonly string[];
  /** Typed references such as `round:<id>`, `voteSession:<id>`, `groupingStage:<id>`. */
  readonly dependencyRefs?: readonly string[];
}

export interface StoredStageResult {
  readonly id: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly status: "confirmed" | "ready_to_confirm";
  readonly candidateRevision: number;
  readonly sourceCandidateRevision: number;
  readonly inputFingerprint: string;
  readonly source?: StoredResultSource | null;
  readonly decisions: readonly ResultDecision[];
  readonly awards: readonly ResultAward[];
  readonly note: string;
  readonly revision: number;
  readonly confirmedAt?: string;
  readonly unlockedAt?: string;
  readonly staleAt?: string;
  readonly staleReason?: string;
}

function stageResult(row: Selectable<StageResultRow>): StoredStageResult {
  const confirmedAt = iso(row.confirmed_at);
  const unlockedAt = iso(row.unlocked_at);
  const staleAt = iso(row.stale_at);
  const source = row.source === null ? null : (json(row.source) as StoredResultSource);
  return {
    id: row.id,
    activityId: row.activity_id,
    stageKey: row.stage_key,
    status: row.status as StoredStageResult["status"],
    candidateRevision: row.candidate_revision,
    sourceCandidateRevision: row.source_candidate_revision,
    inputFingerprint: row.input_fingerprint,
    source,
    decisions: json(row.decisions) as ResultDecision[],
    awards: json(row.awards) as ResultAward[],
    note: row.note,
    revision: row.revision,
    staleReason: row.stale_reason,
    ...(confirmedAt === null ? {} : { confirmedAt }),
    ...(unlockedAt === null ? {} : { unlockedAt }),
    ...(staleAt === null ? {} : { staleAt }),
  };
}

export async function getStageResult(
  db: Kysely<Database>,
  activityId: string,
  stageKey: string,
): Promise<StoredStageResult | null> {
  const row = await db.selectFrom("stage_result").selectAll()
    .where("activity_id", "=", activityId)
    .where("stage_key", "=", stageKey)
    .executeTakeFirst();
  return row === undefined ? null : stageResult(row);
}

export async function getStageResultForUpdate(
  db: Kysely<Database>,
  activityId: string,
  stageKey: string,
): Promise<StoredStageResult | null> {
  const row = await db.selectFrom("stage_result").selectAll()
    .where("activity_id", "=", activityId)
    .where("stage_key", "=", stageKey)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : stageResult(row);
}

export async function listStageResults(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredStageResult[]> {
  const rows = await db.selectFrom("stage_result").selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("stage_key", "asc")
    .execute();
  return rows.map(stageResult);
}

export async function insertStageResult(
  db: Kysely<Database>,
  value: StoredStageResult,
): Promise<void> {
  await db.insertInto("stage_result").values({
    id: value.id,
    activity_id: value.activityId,
    stage_key: value.stageKey,
    status: value.status,
    candidate_revision: value.candidateRevision,
    source_candidate_revision: value.sourceCandidateRevision,
    input_fingerprint: value.inputFingerprint,
    decisions: JSON.stringify(value.decisions),
    awards: JSON.stringify(value.awards),
    note: value.note,
    source: value.source === undefined || value.source === null ? null : JSON.stringify(value.source),
    stale_at: value.staleAt ?? null,
    stale_reason: value.staleReason ?? "",
    revision: value.revision,
    confirmed_at: value.confirmedAt ?? null,
    unlocked_at: value.unlockedAt ?? null,
  }).execute();
}

export async function updateStageResult(
  db: Kysely<Database>,
  value: StoredStageResult,
): Promise<void> {
  await db.updateTable("stage_result").set({
    status: value.status,
    candidate_revision: value.candidateRevision,
    source_candidate_revision: value.sourceCandidateRevision,
    input_fingerprint: value.inputFingerprint,
    decisions: JSON.stringify(value.decisions),
    awards: JSON.stringify(value.awards),
    note: value.note,
    source: value.source === undefined || value.source === null ? null : JSON.stringify(value.source),
    stale_at: value.staleAt ?? null,
    stale_reason: value.staleReason ?? "",
    revision: value.revision,
    confirmed_at: value.confirmedAt ?? null,
    unlocked_at: value.unlockedAt ?? null,
    updated_at: new Date(),
  }).where("id", "=", value.id).execute();
}

export interface StoredResultPublication {
  readonly id: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly title: string;
  readonly content: string;
  readonly version: number;
  readonly revision: number;
}

function publication(row: Selectable<ResultPublicationRow>): StoredResultPublication {
  return {
    id: row.id,
    activityId: row.activity_id,
    stageKey: row.stage_key,
    title: row.title,
    content: row.content,
    version: row.version,
    revision: row.revision,
  };
}

export async function getResultPublication(
  db: Kysely<Database>,
  activityId: string,
  stageKey: string,
): Promise<StoredResultPublication | null> {
  const row = await db.selectFrom("result_publication").selectAll()
    .where("activity_id", "=", activityId)
    .where("stage_key", "=", stageKey)
    .executeTakeFirst();
  return row === undefined ? null : publication(row);
}

export async function getResultPublicationForUpdate(
  db: Kysely<Database>,
  activityId: string,
  stageKey: string,
): Promise<StoredResultPublication | null> {
  const row = await db.selectFrom("result_publication").selectAll()
    .where("activity_id", "=", activityId)
    .where("stage_key", "=", stageKey)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : publication(row);
}

export async function listResultPublications(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredResultPublication[]> {
  const rows = await db.selectFrom("result_publication").selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("stage_key", "asc")
    .execute();
  return rows.map(publication);
}

export async function insertResultPublication(
  db: Kysely<Database>,
  value: StoredResultPublication,
): Promise<void> {
  await db.insertInto("result_publication").values({
    id: value.id,
    activity_id: value.activityId,
    stage_key: value.stageKey,
    title: value.title,
    content: value.content,
    version: value.version,
    revision: value.revision,
  }).execute();
}

export async function updateResultPublication(
  db: Kysely<Database>,
  value: StoredResultPublication,
): Promise<void> {
  await db.updateTable("result_publication").set({
    title: value.title,
    content: value.content,
    version: value.version,
    revision: value.revision,
    updated_at: new Date(),
  }).where("id", "=", value.id).execute();
}

export interface StoredResultRelease {
  readonly id: string;
  readonly activityId: string;
  readonly publicationId: string;
  readonly stageResultId: string;
  readonly stageKey: string;
  readonly status: "active" | "revoked" | "superseded";
  readonly snapshot: ResultSnapshot | null;
  readonly snapshotCandidateRevision: number;
  readonly resultVersion: number;
  readonly postVersion: number;
  readonly inputFingerprint: string;
  readonly note: string;
  readonly releasedAt: string;
  readonly revokedAt?: string;
  readonly supersededAt?: string;
  readonly revision: number;
}

function resultRelease(row: Selectable<ResultReleaseRow>): StoredResultRelease {
  const releasedAt = iso(row.released_at) ?? "";
  const revokedAt = iso(row.revoked_at);
  const supersededAt = iso(row.superseded_at);
  return {
    id: row.id,
    activityId: row.activity_id,
    publicationId: row.publication_id,
    stageResultId: row.stage_result_id,
    stageKey: row.stage_key,
    status: row.status as StoredResultRelease["status"],
    snapshot: json(row.snapshot) as ResultSnapshot,
    snapshotCandidateRevision: row.snapshot_candidate_revision,
    resultVersion: row.result_version,
    postVersion: row.post_version,
    inputFingerprint: row.input_fingerprint,
    note: row.note,
    releasedAt,
    ...(revokedAt === null ? {} : { revokedAt }),
    ...(supersededAt === null ? {} : { supersededAt }),
    revision: row.revision,
  };
}

export async function getActiveResultRelease(
  db: Kysely<Database>,
  activityId: string,
  stageKey: string,
): Promise<StoredResultRelease | null> {
  const row = await db.selectFrom("result_release").selectAll()
    .where("activity_id", "=", activityId)
    .where("stage_key", "=", stageKey)
    .where("status", "=", "active")
    .executeTakeFirst();
  return row === undefined ? null : resultRelease(row);
}

export async function listActiveResultReleases(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredResultRelease[]> {
  const rows = await db.selectFrom("result_release").selectAll()
    .where("activity_id", "=", activityId)
    .where("status", "=", "active")
    .orderBy("stage_key", "asc")
    .execute();
  return rows.map(resultRelease);
}

export async function getResultReleaseByIdForUpdate(
  db: Kysely<Database>,
  releaseId: string,
): Promise<StoredResultRelease | null> {
  const row = await db.selectFrom("result_release").selectAll()
    .where("id", "=", releaseId)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : resultRelease(row);
}

export async function listResultReleases(
  db: Kysely<Database>,
  activityId: string,
  stageKey?: string,
): Promise<readonly StoredResultRelease[]> {
  let query = db.selectFrom("result_release").selectAll().where("activity_id", "=", activityId);
  if (stageKey !== undefined) query = query.where("stage_key", "=", stageKey);
  const rows = await query.orderBy("released_at", "asc").orderBy("id", "asc").execute();
  return rows.map(resultRelease);
}

export async function insertResultRelease(
  db: Kysely<Database>,
  value: StoredResultRelease,
): Promise<void> {
  await db.insertInto("result_release").values({
    id: value.id,
    activity_id: value.activityId,
    publication_id: value.publicationId,
    stage_result_id: value.stageResultId,
    stage_key: value.stageKey,
    status: value.status,
    snapshot: JSON.stringify(value.snapshot),
    snapshot_candidate_revision: value.snapshotCandidateRevision,
    result_version: value.resultVersion,
    post_version: value.postVersion,
    input_fingerprint: value.inputFingerprint,
    note: value.note,
    released_at: value.releasedAt,
    revoked_at: value.revokedAt ?? null,
    superseded_at: value.supersededAt ?? null,
    revision: value.revision,
  }).execute();
}

export async function updateResultReleaseStatus(
  db: Kysely<Database>,
  value: {
    readonly id: string;
    readonly activityId: string;
    readonly status: "active" | "revoked" | "superseded";
    readonly revokedAt: string | null;
    readonly supersededAt: string | null;
    readonly revision: number;
  },
): Promise<void> {
  await db.updateTable("result_release").set({
    status: value.status,
    revoked_at: value.revokedAt,
    superseded_at: value.supersededAt,
    revision: value.revision,
  }).where("id", "=", value.id).where("activity_id", "=", value.activityId).execute();
}

export interface PublicResult {
  readonly releaseId: string;
  readonly stageKey: string;
  readonly publicTitle: string;
  readonly releasedAt: string;
  readonly decisions: readonly ResultDecision[];
  readonly awards: readonly ResultAward[];
}

export interface PublicResults {
  readonly activity: { readonly publicCode: string };
  readonly activityTitle: string;
  readonly results: readonly PublicResult[];
}

/** The single public selector: active snapshots only, never internal fields. */
export async function selectPublicResults(
  db: Kysely<Database>,
  publicCode: string,
  stageKey?: string,
): Promise<PublicResults | null> {
  const activity = await db.selectFrom("activity")
    .select(["id", "public_code"])
    .where("public_code", "=", publicCode)
    .executeTakeFirst();
  if (activity === undefined) return null;
  const rows = await db.selectFrom("result_release")
    .innerJoin("stage_result", (join) =>
      join
        .onRef("stage_result.id", "=", "result_release.stage_result_id")
        .onRef("stage_result.activity_id", "=", "result_release.activity_id"),
    )
    .selectAll("result_release")
    .where("result_release.activity_id", "=", activity.id)
    .where("result_release.status", "=", "active")
    // Fail closed: an active release whose source is missing, unconfirmed, or
    // stale is not public, even if an older code path forgot to supersede it.
    .where("stage_result.status", "=", "confirmed")
    .where("stage_result.source", "is not", null)
    .where("stage_result.stale_at", "is", null)
    .orderBy("result_release.stage_key", "asc")
    .orderBy("result_release.released_at", "desc")
    .execute();
  const validRows = rows.filter((row) => isResultSnapshot(json(row.snapshot)));
  // The response title and results must come from the same stage's snapshot;
  // filter first, then choose the newest visible release.
  const visible = stageKey === undefined
    ? validRows
    : validRows.filter((row) => row.stage_key === stageKey);
  const newest = [...visible].sort((left, right) => {
    const leftAt = iso(left.released_at) ?? "";
    const rightAt = iso(right.released_at) ?? "";
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    return right.id.localeCompare(left.id);
  })[0];
  const activityTitle = newest === undefined
    ? ""
    : (json(newest.snapshot) as ResultSnapshot).activityTitle;
  const results = visible.map((row) => {
    const snapshot = json(row.snapshot) as ResultSnapshot;
    return {
      releaseId: row.id,
      stageKey: row.stage_key,
      publicTitle: snapshot.publicTitle,
      releasedAt: iso(row.released_at) ?? "",
      decisions: snapshot.decisions,
      awards: snapshot.awards,
    };
  });
  return { activity: { publicCode: activity.public_code }, activityTitle, results };
}
