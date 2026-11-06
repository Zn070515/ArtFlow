import type { Database, StoredResultSource, StoredStageResult } from "@artflow-plus/db";
import {
  getActiveResultRelease,
  listStageResults,
  updateResultReleaseStatus,
  updateStageResult,
} from "@artflow-plus/db";
import { DomainError, type DomainErrorCode } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import type { RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";

async function confirmedResults(
  trx: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredStageResult[]> {
  const results = await listStageResults(trx, activityId);
  return results.filter((result) => result.status === "confirmed");
}

function intersects(left: readonly string[] | undefined, right: readonly string[]): boolean {
  if (left === undefined) return true; // unknown dependency: fail closed
  return left.some((item) => right.includes(item));
}

/**
 * A score write may proceed unless a confirmed result actually consumed the
 * round it is changing. An unrelated stage must not lock the whole activity.
 */
export async function requireNoConsumedRound(
  trx: Kysely<Database>,
  activityId: string,
  roundId: string,
  code: DomainErrorCode,
  message: string,
): Promise<void> {
  const results = await confirmedResults(trx, activityId);
  const consumed = results.some((result) => {
    const source = result.source;
    if (source?.kind !== "podium_candidate") return false;
    // A source without dependency metadata predates precise consumption; treat
    // it conservatively instead of silently allowing the edit.
    return intersects(source.dependencyIds, [roundId]);
  });
  if (consumed) throw new DomainError(code, message);
}

/**
 * A grouping correction is blocked only when a confirmed result explicitly
 * declared a dependency on this grouping stage. Participant overlap alone is
 * not a dependency.
 */
export async function requireNoConsumedGrouping(
  trx: Kysely<Database>,
  activityId: string,
  groupingStageId: string,
  code: DomainErrorCode,
  message: string,
): Promise<void> {
  const ref = `groupingStage:${groupingStageId}`;
  const results = await confirmedResults(trx, activityId);
  const consumed = results.some((result) => {
    const refs = result.source?.dependencyRefs;
    // Unknown dependency metadata predates typed refs; fail closed.
    return refs === undefined || refs.includes(ref);
  });
  if (consumed) throw new DomainError(code, message);
}

export interface MarkStaleSelector {
  readonly kind: StoredResultSource["kind"];
  /** Match only these source aggregates (for example affected vote sessions). */
  readonly aggregateIds?: readonly string[];
  /** Match a result whose dependency set intersects these upstream ids. */
  readonly dependencyIds?: readonly string[];
}

function matchesSelector(result: StoredStageResult, selector: MarkStaleSelector): boolean {
  const source = result.source;
  if (source?.kind !== selector.kind) return false;
  if (selector.aggregateIds !== undefined && selector.aggregateIds.length > 0) {
    return selector.aggregateIds.includes(source.aggregateId);
  }
  if (selector.dependencyIds !== undefined && selector.dependencyIds.length > 0) {
    return intersects(source.dependencyIds, selector.dependencyIds);
  }
  return true;
}

export interface MarkStaleResult {
  readonly stageKey: string;
  readonly resultId: string;
}

/**
 * Marks the confirmed results selected by `selector` stale and supersedes their
 * active release in the same transaction.
 */
export async function markConsumedResultsStale(
  trx: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
  selector: MarkStaleSelector,
  reason: string,
): Promise<readonly MarkStaleResult[]> {
  const results = await confirmedResults(trx, activityId);
  const marked: MarkStaleResult[] = [];
  for (const result of results) {
    if (result.staleAt !== undefined) continue;
    if (!matchesSelector(result, selector)) continue;
    const staleAt = deps.now();
    const updated: StoredStageResult = {
      ...result,
      staleAt,
      staleReason: reason,
      revision: result.revision + 1,
    };
    await updateStageResult(trx, updated);
    const active = await getActiveResultRelease(trx, activityId, result.stageKey);
    if (active !== null) {
      await updateResultReleaseStatus(trx, {
        id: active.id,
        activityId,
        status: "superseded",
        revokedAt: null,
        supersededAt: staleAt,
        revision: active.revision + 1,
      });
      await appendEngineEvent(trx, deps, {
        type: "ResultReleaseSuperseded",
        activityId,
        aggregateType: "result_release",
        aggregateId: active.id,
        revision: active.revision + 1,
        capability: "publishing",
        mode: result.source?.mode,
        payload: { releaseId: active.id, stageKey: active.stageKey, reason },
      });
    }
    await appendEngineEvent(trx, deps, {
      type: "StageResultMarkedStale",
      activityId,
      aggregateType: "stage_result",
      aggregateId: updated.id,
      revision: updated.revision,
      capability: "publishing",
      mode: result.source?.mode,
      payload: { stageKey: updated.stageKey, reason },
    });
    marked.push({ stageKey: updated.stageKey, resultId: updated.id });
  }
  return marked;
}

/**
 * Recomputes the source fingerprint for a confirmed result and fails when the
 * source moved after confirmation. Legacy imports have no live source.
 */
export function requireSourceFingerprint(
  result: StoredStageResult,
  currentFingerprint: string,
): void {
  if (result.staleAt !== undefined) {
    throw new DomainError("RESULT_STALE", "The result source changed after confirmation; reconfirm it.");
  }
  if (result.source?.kind === "legacy_import") return;
  if (currentFingerprint !== result.inputFingerprint) {
    throw new DomainError("RESULT_STALE", "The result source changed after confirmation; reconfirm it.");
  }
}
