import type {
  Database,
  StoredPodiumCandidate,
  StoredResultPublication,
  StoredResultRelease,
  StoredStageResult,
} from "@artflow-plus/db";
import {
  findRunningSessionByScope,
  getActivityForUpdate,
  getLatestPodiumCandidate,
  getRelease,
  getStageResultForUpdate,
  insertStageResult,
  listResultPublications,
  listResultReleases,
  listStageResults,
  updateStageResult,
} from "@artflow-plus/db";
import {
  decodePublishingArtifact,
  DomainError,
  requirePermission,
  validateAwards,
} from "@artflow-plus/domain";
import type {
  CompiledPublishingArtifact,
  PublishingStageDefinition,
  ResultAward,
  ResultDecision,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand } from "./hash.js";

function requireActive(activity: { readonly status: string }, label: string): void {
  if (activity.status !== "active") {
    throw new DomainError("ACTIVITY_NOT_ACTIVE", `${label} requires an active activity.`);
  }
}

function requireCapability(
  activity: { readonly enabledCapabilities: readonly string[] },
  key: string,
): void {
  if (!activity.enabledCapabilities.includes(key)) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", `Capability ${key} is not enabled on this activity.`);
  }
}

async function publishingArtifact(
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

function requireStage(
  artifact: CompiledPublishingArtifact,
  stageKey: string,
): PublishingStageDefinition {
  const stage = artifact.stages.find((candidate) => candidate.key === stageKey);
  if (stage === undefined) {
    throw new DomainError("INVALID_INPUT", `Stage ${stageKey} is not declared in the released publishing definition.`);
  }
  return stage;
}

function decisionsFromCandidate(candidate: StoredPodiumCandidate): ResultDecision[] {
  return candidate.placements.map((placement) => {
    if (
      !Number.isInteger(placement.place) ||
      placement.place < 1 ||
      typeof placement.contestantId !== "string" ||
      !placement.contestantId.trim() ||
      typeof placement.total !== "string"
    ) {
      throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The podium candidate placements are malformed.");
    }
    return { rank: placement.place, contestantId: placement.contestantId, score: placement.total };
  });
}

export interface ConfirmStageResultInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly scope: string;
  readonly expectedSourceRevision: number;
  readonly expectedInputFingerprint: string;
  readonly awards: readonly ResultAward[];
  readonly note?: string;
}

export async function confirmStageResult(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ConfirmStageResultInput,
): Promise<CommandOutcome<StoredStageResult>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "publishing",
    commandType: "publishing.stage_result.confirm",
    scope: input.scope,
    actor,
    payload: {
      stageKey: input.stageKey,
      expectedSourceRevision: input.expectedSourceRevision,
      expectedInputFingerprint: input.expectedInputFingerprint,
      awards: input.awards,
      note: input.note ?? "",
    },
  }, async (trx) => {
    requirePermission(actor, "result.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity, "Publishing");
    requireCapability(activity, "publishing");
    const session = await findRunningSessionByScope(trx, activity.id, input.scope);
    if (session === null) {
      throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution.`);
    }
    const stage = requireStage(await publishingArtifact(trx, activity, session.definitionVersion), input.stageKey);
    const candidate = await getLatestPodiumCandidate(trx, activity.id);
    if (candidate === null) throw new DomainError("NOT_FOUND", "No podium candidate is available to confirm.");
    if (candidate.status !== "candidate") {
      throw new DomainError("RESULT_CANDIDATE_HOLD", "A held podium candidate cannot be confirmed.");
    }
    if (
      candidate.revision !== input.expectedSourceRevision ||
      candidate.inputFingerprint !== input.expectedInputFingerprint
    ) {
      throw new DomainError("STALE_RESOLUTION_INPUT", "The podium candidate changed since it was read.");
    }
    const decisions = decisionsFromCandidate(candidate);
    validateAwards(decisions, input.awards);
    const existing = await getStageResultForUpdate(trx, activity.id, stage.key);
    if (existing !== null && existing.status === "confirmed") {
      throw new DomainError("INVALID_TRANSITION", "Unlock the confirmed stage result before confirming it again.");
    }
    const candidateRevision = existing === null
      ? candidate.revision
      : Math.max(existing.candidateRevision + 1, candidate.revision);
    const stored: StoredStageResult = {
      id: existing?.id ?? idFromCommand("stage-result", `${activity.id}:${stage.key}`),
      activityId: activity.id,
      stageKey: stage.key,
      status: "confirmed",
      candidateRevision,
      sourceCandidateRevision: candidate.revision,
      inputFingerprint: candidate.inputFingerprint,
      decisions,
      awards: input.awards.map((award) => ({ award: award.award.trim(), contestantId: award.contestantId })),
      revision: (existing?.revision ?? 0) + 1,
      confirmedAt: deps.now(),
    };
    if (existing === null) await insertStageResult(trx, stored);
    else await updateStageResult(trx, stored);
    await appendEngineEvent(trx, deps, {
      type: "StageResultConfirmed",
      activityId: activity.id,
      aggregateType: "stage_result",
      aggregateId: stored.id,
      revision: stored.revision,
      capability: "publishing",
      mode: session.mode,
      scope: input.scope,
      payload: {
        stageKey: stored.stageKey,
        candidateRevision: stored.candidateRevision,
        sourceCandidateRevision: stored.sourceCandidateRevision,
        decisions: stored.decisions,
        awards: stored.awards,
      },
    });
    return { body: stored, status: existing === null ? 201 : 200 };
  });
}

export interface PublishingState {
  readonly stageResults: readonly StoredStageResult[];
  readonly publications: readonly StoredResultPublication[];
  readonly releases: readonly StoredResultRelease[];
}

export async function getPublishingState(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string },
): Promise<PublishingState> {
  requirePermission(runtimeActor(deps), "result.manage");
  const activity = await db.selectFrom("activity").select("id").where("id", "=", input.activityId).executeTakeFirst();
  if (activity === undefined) throw new DomainError("NOT_FOUND", "The activity was not found.");
  return {
    stageResults: await listStageResults(db, input.activityId),
    publications: await listResultPublications(db, input.activityId),
    releases: await listResultReleases(db, input.activityId),
  };
}
