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

/**
 * A result that was confirmed from a source class owns that source. Normal
 * corrections must unlock the result first; security actions may proceed, but
 * they must atomically make the consumed result stale instead of letting it
 * drift silently.
 */
export async function requireNoConfirmedResult(
  trx: Kysely<Database>,
  activityId: string,
  code: DomainErrorCode,
  message: string,
): Promise<void> {
  const results = await listStageResults(trx, activityId);
  if (results.some((result) => result.status === "confirmed")) {
    throw new DomainError(code, message);
  }
}

export interface MarkStaleResult {
  readonly stageKey: string;
  readonly resultId: string;
}

/**
 * Marks every confirmed result sourced from `kind` as needing reconfirmation
 * and supersedes its active release in the same transaction.
 */
export async function markConsumedResultsStale(
  trx: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
  kind: StoredResultSource["kind"],
  reason: string,
): Promise<readonly MarkStaleResult[]> {
  const results = await listStageResults(trx, activityId);
  const marked: MarkStaleResult[] = [];
  for (const result of results) {
    if (result.status !== "confirmed" || result.source?.kind !== kind || result.staleAt !== undefined) {
      continue;
    }
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
