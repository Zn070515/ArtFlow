import type {
  Database,
  StoredPodiumCandidate,
  StoredResultPublication,
  StoredResultRelease,
  StoredStageResult,
} from "@artflow-plus/db";
import {
  findRunningSessionByScope,
  getActiveResultRelease,
  getActivityForUpdate,
  getLatestPodiumCandidate,
  getRelease,
  getResultPublicationForUpdate,
  getResultReleaseByIdForUpdate,
  getStageResultForUpdate,
  insertResultPublication,
  insertResultRelease,
  insertStageResult,
  listResultPublications,
  listResultReleases,
  listStageResults,
  updateResultPublication,
  updateResultReleaseStatus,
  updateStageResult,
} from "@artflow-plus/db";
import {
  buildResultSnapshot,
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

export interface ReleaseResultInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly scope: string;
  readonly expectedCandidateRevision: number;
  readonly note: string;
}

export async function releaseResult(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ReleaseResultInput,
): Promise<CommandOutcome<StoredResultRelease>> {
  const actor = runtimeActor(deps);
  const note = input.note.trim();
  if (!note) throw new DomainError("INVALID_INPUT", "A release note is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "publishing",
    commandType: "publishing.result.release",
    scope: input.scope,
    actor,
    payload: { stageKey: input.stageKey, expectedCandidateRevision: input.expectedCandidateRevision, note },
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
    const stageResult = await getStageResultForUpdate(trx, activity.id, stage.key);
    if (stageResult === null) throw new DomainError("RESULT_NOT_CONFIRMED", "The stage result has not been confirmed.");
    if (stageResult.status !== "confirmed") {
      throw new DomainError("RESULT_NOT_CONFIRMED", "The stage result is unlocked and must be confirmed again.");
    }
    if (stageResult.candidateRevision !== input.expectedCandidateRevision) {
      throw new DomainError("STALE_REVISION", "The stage result changed since it was read.");
    }
    const active = await getActiveResultRelease(trx, activity.id, stage.key);
    if (active !== null) {
      throw new DomainError("RESULT_ALREADY_RELEASED", "Revoke the active release before publishing again.");
    }
    const snapshot = buildResultSnapshot({
      activityTitle: activity.title,
      stageKey: stage.key,
      stageLabel: stage.label,
      decisions: stageResult.decisions,
      awards: stageResult.awards,
    });
    let publication = await getResultPublicationForUpdate(trx, activity.id, stage.key);
    if (publication === null) {
      publication = {
        id: idFromCommand("result-publication", `${activity.id}:${stage.key}`),
        activityId: activity.id,
        stageKey: stage.key,
        title: snapshot.publicTitle,
        content: "",
        version: 1,
        revision: 0,
      };
      await insertResultPublication(trx, publication);
    }
    const stored: StoredResultRelease = {
      id: idFromCommand("result-release", input.commandId),
      activityId: activity.id,
      publicationId: publication.id,
      stageResultId: stageResult.id,
      stageKey: stage.key,
      status: "active",
      snapshot,
      snapshotCandidateRevision: stageResult.candidateRevision,
      resultVersion: stageResult.candidateRevision,
      postVersion: publication.version,
      inputFingerprint: stageResult.inputFingerprint,
      note,
      releasedAt: deps.now(),
      revision: 0,
    };
    await insertResultRelease(trx, stored);
    await appendEngineEvent(trx, deps, {
      type: "ResultReleased",
      activityId: activity.id,
      aggregateType: "result_release",
      aggregateId: stored.id,
      revision: stored.revision,
      capability: "publishing",
      mode: session.mode,
      scope: input.scope,
      payload: {
        releaseId: stored.id,
        stageKey: stored.stageKey,
        candidateRevision: stored.snapshotCandidateRevision,
        publicTitle: stored.snapshot.publicTitle,
      },
    });
    return { body: stored, status: 201 };
  });
}

export interface RevokeResultReleaseInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly releaseId: string;
  readonly scope: string;
  readonly note: string;
}

export async function revokeResultRelease(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: RevokeResultReleaseInput,
): Promise<CommandOutcome<StoredResultRelease>> {
  const actor = runtimeActor(deps);
  const note = input.note.trim();
  if (!note) throw new DomainError("INVALID_INPUT", "A revoke note is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "publishing",
    commandType: "publishing.result.revoke",
    scope: input.scope,
    actor,
    payload: { releaseId: input.releaseId, note },
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
    const release = await getResultReleaseByIdForUpdate(trx, input.releaseId);
    if (release === null || release.activityId !== activity.id) {
      throw new DomainError("NOT_FOUND", "The result release was not found.");
    }
    if (release.status !== "active") {
      throw new DomainError("RESULT_RELEASE_NOT_ACTIVE", "Only an active release can be revoked.");
    }
    const revokedAt = deps.now();
    await updateResultReleaseStatus(trx, {
      id: release.id,
      activityId: release.activityId,
      status: "revoked",
      revokedAt,
      supersededAt: null,
      revision: release.revision + 1,
    });
    const stored: StoredResultRelease = { ...release, status: "revoked", revokedAt, revision: release.revision + 1 };
    await appendEngineEvent(trx, deps, {
      type: "ResultReleaseRevoked",
      activityId: activity.id,
      aggregateType: "result_release",
      aggregateId: stored.id,
      revision: stored.revision,
      capability: "publishing",
      mode: session.mode,
      scope: input.scope,
      payload: { releaseId: stored.id, stageKey: stored.stageKey, note },
    });
    return { body: stored, status: 200 };
  });
}

export interface UnlockStageResultInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly scope: string;
  readonly expectedCandidateRevision: number;
  readonly note: string;
}

export async function unlockStageResult(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: UnlockStageResultInput,
): Promise<CommandOutcome<StoredStageResult>> {
  const actor = runtimeActor(deps);
  const note = input.note.trim();
  if (!note) throw new DomainError("INVALID_INPUT", "An unlock note is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "publishing",
    commandType: "publishing.stage_result.unlock",
    scope: input.scope,
    actor,
    payload: { stageKey: input.stageKey, expectedCandidateRevision: input.expectedCandidateRevision, note },
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
    const stageResult = await getStageResultForUpdate(trx, activity.id, stage.key);
    if (stageResult === null) throw new DomainError("RESULT_NOT_CONFIRMED", "The stage result has not been confirmed.");
    if (stageResult.status !== "confirmed") {
      throw new DomainError("INVALID_TRANSITION", "The stage result is already unlocked.");
    }
    if (stageResult.candidateRevision !== input.expectedCandidateRevision) {
      throw new DomainError("STALE_REVISION", "The stage result changed since it was read.");
    }
    const active = await getActiveResultRelease(trx, activity.id, stage.key);
    if (active !== null) {
      const supersededAt = deps.now();
      await updateResultReleaseStatus(trx, {
        id: active.id,
        activityId: active.activityId,
        status: "superseded",
        revokedAt: null,
        supersededAt,
        revision: active.revision + 1,
      });
      await appendEngineEvent(trx, deps, {
        type: "ResultReleaseSuperseded",
        activityId: activity.id,
        aggregateType: "result_release",
        aggregateId: active.id,
        revision: active.revision + 1,
        capability: "publishing",
        mode: session.mode,
        scope: input.scope,
        payload: { releaseId: active.id, stageKey: active.stageKey },
      });
    }
    const unlocked: StoredStageResult = {
      ...stageResult,
      status: "ready_to_confirm",
      candidateRevision: stageResult.candidateRevision + 1,
      revision: stageResult.revision + 1,
      unlockedAt: deps.now(),
    };
    await updateStageResult(trx, unlocked);
    await appendEngineEvent(trx, deps, {
      type: "StageResultUnlocked",
      activityId: activity.id,
      aggregateType: "stage_result",
      aggregateId: unlocked.id,
      revision: unlocked.revision,
      capability: "publishing",
      mode: session.mode,
      scope: input.scope,
      payload: { stageKey: unlocked.stageKey, candidateRevision: unlocked.candidateRevision, note },
    });
    return { body: unlocked, status: 200 };
  });
}

export interface EditPublicationInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly scope: string;
  readonly expectedVersion: number;
  readonly title: string;
  readonly content: string;
}

export async function editPublication(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: EditPublicationInput,
): Promise<CommandOutcome<StoredResultPublication>> {
  const actor = runtimeActor(deps);
  const title = input.title.trim();
  if (!title) throw new DomainError("INVALID_INPUT", "A publication title is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "publishing",
    commandType: "publishing.publication.edit",
    scope: input.scope,
    actor,
    payload: {
      stageKey: input.stageKey,
      expectedVersion: input.expectedVersion,
      title,
      content: input.content,
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
    if ((await getActiveResultRelease(trx, activity.id, stage.key)) !== null) {
      throw new DomainError("RESULT_POST_FROZEN", "An active result release freezes the publication.");
    }
    const existing = await getResultPublicationForUpdate(trx, activity.id, stage.key);
    if (existing === null) {
      if (input.expectedVersion !== 0) {
        throw new DomainError("STALE_REVISION", "A missing publication has version 0.");
      }
      const created: StoredResultPublication = {
        id: idFromCommand("result-publication", `${activity.id}:${stage.key}`),
        activityId: activity.id,
        stageKey: stage.key,
        title,
        content: input.content,
        version: 1,
        revision: 0,
      };
      await insertResultPublication(trx, created);
      await appendEngineEvent(trx, deps, {
        type: "ResultPublicationEdited",
        activityId: activity.id,
        aggregateType: "result_publication",
        aggregateId: created.id,
        revision: created.revision,
        capability: "publishing",
        mode: session.mode,
        scope: input.scope,
        payload: { publicationId: created.id, stageKey: created.stageKey, version: created.version },
      });
      return { body: created, status: 201 };
    }
    if (existing.version !== input.expectedVersion) {
      throw new DomainError("STALE_REVISION", "The publication changed since it was read.");
    }
    const updated: StoredResultPublication = {
      ...existing,
      title,
      content: input.content,
      version: existing.version + 1,
      revision: existing.revision + 1,
    };
    await updateResultPublication(trx, updated);
    await appendEngineEvent(trx, deps, {
      type: "ResultPublicationEdited",
      activityId: activity.id,
      aggregateType: "result_publication",
      aggregateId: updated.id,
      revision: updated.revision,
      capability: "publishing",
      mode: session.mode,
      scope: input.scope,
      payload: { publicationId: updated.id, stageKey: updated.stageKey, version: updated.version },
    });
    return { body: updated, status: 200 };
  });
}
