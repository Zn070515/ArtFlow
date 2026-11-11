import type {
  Database,
  StoredPodiumCandidate,
} from "@artflow-plus/db";
import { getActivityForUpdate, getRelease } from "@artflow-plus/db";
import {
  decimalValue,
  decodePublishingArtifact,
  DomainError,
  requirePermission,
} from "@artflow-plus/domain";
import type {
  ActorContext,
  CompiledPublishingArtifact,
  PublishingStageDefinition,
  ResultDecision,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { requireRunningCommandSession } from "./command-scope.js";

export function requireActive(activity: { readonly status: string }, label: string): void {
  if (activity.status !== "active") {
    throw new DomainError("ACTIVITY_NOT_ACTIVE", `${label} requires an active activity.`);
  }
}

export function requireCapability(
  activity: { readonly enabledCapabilities: readonly string[] },
  key: string,
): void {
  if (!activity.enabledCapabilities.includes(key)) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", `Capability ${key} is not enabled on this activity.`);
  }
}

/**
 * The shared write-command preamble: permission, activity lock, capability and
 * running publishing session. Every publishing command must pass through it.
 */
export async function lockPublishingActivity(
  trx: Kysely<Database>,
  actor: ActorContext,
  activityId: string,
  commandType: string,
  scope: string,
) {
  requirePermission(actor, "result.manage");
  const activity = await getActivityForUpdate(trx, activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  requireActive(activity, "Publishing");
  requireCapability(activity, "publishing");
  const { session } = await requireRunningCommandSession(trx, activity, commandType, scope);
  if (session.mode !== "formal") {
    throw new DomainError("FORMAL_MODE_REQUIRED", "Publishing is a formal-only capability.");
  }
  return { activity, session };
}

export async function publishingArtifact(
  trx: Kysely<Database>,
  activity: { readonly id: string },
  definitionVersion: number,
): Promise<CompiledPublishingArtifact> {
  const release = await getRelease(trx, activity.id, definitionVersion);
  if (release === null) {
    throw new DomainError("VERSION_NOT_RELEASED", "The activity has no active released definition.");
  }
  const plan = release.capabilities.publishing;
  if (plan === undefined || plan.ok !== true) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The release has no publishing snapshot.");
  }
  return decodePublishingArtifact(plan.artifact);
}

export function requireStage(
  artifact: CompiledPublishingArtifact,
  stageKey: string,
): PublishingStageDefinition {
  const stage = artifact.stages.find((candidate) => candidate.key === stageKey);
  if (stage === undefined) {
    throw new DomainError("INVALID_INPUT", `Stage ${stageKey} is not declared in the released publishing definition.`);
  }
  return stage;
}

export function decisionsFromCandidate(candidate: StoredPodiumCandidate): ResultDecision[] {
  return candidate.placements.map((placement) => {
    // Candidates written before the decimal authority migration stored totals as
    // JSON numbers; normalize both forms instead of refusing to confirm them.
    const rawTotal: unknown = placement.total;
    const score =
      typeof rawTotal === "string"
        ? rawTotal
        : typeof rawTotal === "number" && Number.isFinite(rawTotal)
          ? decimalValue(rawTotal)
          : null;
    if (
      !Number.isInteger(placement.place) ||
      placement.place < 1 ||
      typeof placement.contestantId !== "string" ||
      !placement.contestantId.trim() ||
      score === null
    ) {
      throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The podium candidate placements are malformed.");
    }
    return { rank: placement.place, contestantId: placement.contestantId, score };
  });
}
