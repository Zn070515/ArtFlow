import type {
  Database,
  StoredPodiumCandidate,
  StoredResultPublication,
  StoredResultRelease,
  StoredResultSource,
  StoredStageResult,
} from "@artflow-plus/db";
import {
  getActiveResultRelease,
  getActivity,
  getActivityForUpdate,
  getLatestPodiumCandidate,
  getRelease,
  getVoteSession,
  listRoundsForActivity,
  listVoteOptions,
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
  buildVoteResultDecisions,
  decimalValue,
  decodePublishingArtifact,
  DomainError,
  requirePermission,
  validateAwards,
} from "@artflow-plus/domain";
import type {
  ActorContext,
  CompiledPublishingArtifact,
  PublishingStageDefinition,
  ResultAward,
  ResultDecision,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { requireRunningCommandSession } from "./command-scope.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";
import { requireSourceFingerprint } from "./result-consumption.js";
import { getClosedVoteScores } from "./voting-ticket-service.js";

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

/**
 * The shared write-command preamble: permission, activity lock, capability and
 * running publishing session. Every publishing command must pass through it.
 */
async function lockPublishingActivity(
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
  const note = input.note?.trim() ?? "";
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
      note,
    },
  }, async (trx) => {
    const { activity, session } = await lockPublishingActivity(trx, actor, input.activityId, "publishing.stage_result.confirm", input.scope);
    requireCapability(activity, "competition");
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
    const sourceRelease = await getRelease(trx, activity.id, session.definitionVersion);
    if (sourceRelease === null) {
      throw new DomainError("VERSION_NOT_RELEASED", "The publishing release is no longer available.");
    }
    const rounds = await listRoundsForActivity(trx, activity.id);
    const sourceRounds = candidate.sourceRoundIds.map((roundId) =>
      rounds.find((round) => round.id === roundId),
    );
    if (
      candidate.sourceRoundIds.length === 0 ||
      sourceRounds.some((round) => round === undefined) ||
      sourceRounds.some((round) => round?.releaseVersion !== session.definitionVersion)
    ) {
      throw new DomainError(
        "SOURCE_RELEASE_MISMATCH",
        "The podium candidate was produced by a different definition release.",
      );
    }
    const source: StoredResultSource = {
      kind: "podium_candidate",
      aggregateId: candidate.id,
      definitionVersion: session.definitionVersion,
      releaseHash: sourceRelease.contentHash,
      mode: session.mode,
      sourceRevision: candidate.revision,
      inputFingerprint: candidate.inputFingerprint,
      dependencyIds: [...candidate.sourceRoundIds],
    };
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
      source,
      decisions,
      awards: input.awards.map((award) => ({ award: award.award.trim(), contestantId: award.contestantId })),
      note,
      revision: (existing?.revision ?? 0) + 1,
      confirmedAt: deps.now(),
      staleReason: "",
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
        note: stored.note,
        source: stored.source,
      },
    });
    return { body: stored, status: existing === null ? 201 : 200 };
  });
}

export interface VoteResultCandidateDecision {
  readonly rank: number;
  readonly contestantId: string;
  readonly score: string;
  readonly count: number;
  readonly unit: "percent";
}

export interface VoteResultCandidate {
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly mode: string;
  readonly totalBallots: number;
  readonly status: "ready" | "hold";
  readonly holdReason?: "NO_VALID_BALLOTS";
  readonly inputFingerprint: string;
  readonly decisions: readonly VoteResultCandidateDecision[];
}

async function voteResultData(
  db: Kysely<Database>,
  activityId: string,
  session: { readonly id: string; readonly revision: number },
): Promise<{
  readonly tally: Awaited<ReturnType<typeof getClosedVoteScores>>;
  readonly entries: readonly {
    readonly contestantId: string;
    readonly count: number;
    readonly share: string;
    readonly ordinal: number;
  }[];
  readonly fingerprint: string;
}> {
  const tally = await getClosedVoteScores(db, session.id);
  const options = await listVoteOptions(db, session.id);
  const entries = options.map((option) => ({
    contestantId: option.candidateId.trim(),
    count: tally.rawCounts[option.id] ?? 0,
    share: tally.scoreInputs?.[option.id] ?? "0",
    ordinal: option.ordinal,
  }));
  const countsByOption = Object.fromEntries(
    Object.keys(tally.rawCounts)
      .sort()
      .map((optionId) => [optionId, tally.rawCounts[optionId] ?? 0]),
  );
  const fingerprint = stableHash({
    kind: "vote_result",
    activityId,
    sessionId: session.id,
    sessionRevision: session.revision,
    totalBallots: tally.totalBallots,
    countsByOption,
  });
  return { tally, entries, fingerprint };
}

export async function getVoteResultCandidate(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string; readonly sessionId: string },
): Promise<VoteResultCandidate> {
  requirePermission(runtimeActor(deps), "result.manage");
  const activity = await getActivity(db, input.activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  requireCapability(activity, "publishing");
  requireCapability(activity, "voting");
  const session = await getVoteSession(db, input.sessionId);
  if (session === null) throw new DomainError("NOT_FOUND", "The voting session was not found.");
  if (session.activityId !== input.activityId) {
    throw new DomainError("CROSS_ACTIVITY", "The voting session belongs to another activity.");
  }
  if (session.status !== "closed") {
    throw new DomainError("VOTE_SESSION_NOT_OPEN", "Only a closed voting session has publishable scores.");
  }
  const { tally, entries, fingerprint } = await voteResultData(db, activity.id, session);
  if (tally.scoreStatus === "hold") {
    return {
      sessionId: session.id,
      sessionRevision: session.revision,
      mode: session.mode,
      totalBallots: tally.totalBallots,
      status: "hold",
      holdReason: "NO_VALID_BALLOTS",
      inputFingerprint: fingerprint,
      decisions: [],
    };
  }
  const decisions = buildVoteResultDecisions(entries);
  // buildVoteResultDecisions sorts, so attach counts by contestant id, not index.
  const counts = new Map(entries.map((entry) => [entry.contestantId, entry.count]));
  return {
    sessionId: session.id,
    sessionRevision: session.revision,
    mode: session.mode,
    totalBallots: tally.totalBallots,
    status: "ready",
    inputFingerprint: fingerprint,
    decisions: decisions.map((decision) => ({
      ...decision,
      count: counts.get(decision.contestantId) ?? 0,
      unit: "percent" as const,
    })),
  };
}

export interface ConfirmVoteStageResultInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly scope: string;
  readonly voteSessionId: string;
  readonly expectedSessionRevision: number;
  readonly expectedInputFingerprint: string;
  readonly awards: readonly ResultAward[];
  readonly note?: string;
}

export async function confirmVoteStageResult(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ConfirmVoteStageResultInput,
): Promise<CommandOutcome<StoredStageResult>> {
  const actor = runtimeActor(deps);
  const note = input.note?.trim() ?? "";
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "publishing",
    commandType: "publishing.vote_result.confirm",
    scope: input.scope,
    actor,
    payload: {
      stageKey: input.stageKey,
      voteSessionId: input.voteSessionId,
      expectedSessionRevision: input.expectedSessionRevision,
      expectedInputFingerprint: input.expectedInputFingerprint,
      awards: input.awards,
      note,
    },
  }, async (trx) => {
    const { activity, session } = await lockPublishingActivity(trx, actor, input.activityId, "publishing.vote_result.confirm", input.scope);
    requireCapability(activity, "voting");
    const stage = requireStage(
      await publishingArtifact(trx, activity, session.definitionVersion),
      input.stageKey,
    );
    const voteSession = await getVoteSession(trx, input.voteSessionId);
    if (voteSession === null) throw new DomainError("NOT_FOUND", "The voting session was not found.");
    if (voteSession.activityId !== activity.id) {
      throw new DomainError("CROSS_ACTIVITY", "The voting session belongs to another activity.");
    }
    if (voteSession.status !== "closed") {
      throw new DomainError("VOTE_SESSION_NOT_OPEN", "Only a closed voting session has publishable scores.");
    }
    if (voteSession.mode !== session.mode) {
      throw new DomainError("FORMAL_MODE_REQUIRED", "The voting session belongs to another execution mode.");
    }
    if (voteSession.definitionVersion !== session.definitionVersion) {
      throw new DomainError(
        "SOURCE_RELEASE_MISMATCH",
        "The voting session was opened by a different definition release.",
      );
    }
    const sourceRelease = await getRelease(trx, activity.id, session.definitionVersion);
    if (sourceRelease === null) {
      throw new DomainError("VERSION_NOT_RELEASED", "The publishing release is no longer available.");
    }
    const { tally, entries, fingerprint } = await voteResultData(trx, activity.id, voteSession);
    const source: StoredResultSource = {
      kind: "vote_session",
      aggregateId: voteSession.id,
      definitionVersion: session.definitionVersion,
      releaseHash: sourceRelease.contentHash,
      mode: session.mode,
      sourceRevision: voteSession.revision,
      inputFingerprint: fingerprint,
      dependencyIds: [voteSession.id],
    };
    if (tally.scoreStatus === "hold") {
      throw new DomainError("NO_VALID_BALLOTS", "A voting session with no valid ballots cannot be published.");
    }
    if (
      voteSession.revision !== input.expectedSessionRevision ||
      fingerprint !== input.expectedInputFingerprint
    ) {
      throw new DomainError("STALE_RESOLUTION_INPUT", "The vote tally changed since it was read.");
    }
    const decisions = buildVoteResultDecisions(entries);
    validateAwards(decisions, input.awards);
    const existing = await getStageResultForUpdate(trx, activity.id, stage.key);
    if (existing !== null && existing.status === "confirmed") {
      throw new DomainError("INVALID_TRANSITION", "Unlock the confirmed stage result before confirming it again.");
    }
    const candidateRevision = existing === null
      ? voteSession.revision
      : Math.max(existing.candidateRevision + 1, voteSession.revision);
    const stored: StoredStageResult = {
      id: existing?.id ?? idFromCommand("stage-result", `${activity.id}:${stage.key}`),
      activityId: activity.id,
      stageKey: stage.key,
      status: "confirmed",
      candidateRevision,
      sourceCandidateRevision: voteSession.revision,
      inputFingerprint: fingerprint,
      source,
      decisions,
      awards: input.awards.map((award) => ({ award: award.award.trim(), contestantId: award.contestantId })),
      note,
      revision: (existing?.revision ?? 0) + 1,
      confirmedAt: deps.now(),
      staleReason: "",
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
        note: stored.note,
        source: stored.source,
      },
    });
    return { body: stored, status: existing === null ? 201 : 200 };
  });
}

export interface PublishingState {
  readonly stageResults: readonly StoredStageResult[];
  readonly publications: readonly StoredResultPublication[];
  readonly releases: readonly StoredResultRelease[];
  readonly stages: readonly PublishingStageDefinition[];
}

export async function getPublishingState(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string },
): Promise<PublishingState> {
  requirePermission(runtimeActor(deps), "result.manage");
  const activity = await getActivity(db, input.activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  let stages: readonly PublishingStageDefinition[] = [];
  if (activity.activeDefinitionVersion > 0) {
    const release = await getRelease(db, activity.id, activity.activeDefinitionVersion);
    const plan = release?.capabilities.publishing;
    if (plan !== undefined && plan.ok === true) {
      stages = decodePublishingArtifact(plan.artifact).stages;
    }
  }
  // The three collections are independent reads; issue them together.
  const [stageResults, publications, releases] = await Promise.all([
    listStageResults(db, input.activityId),
    listResultPublications(db, input.activityId),
    listResultReleases(db, input.activityId),
  ]);
  return { stageResults, publications, releases, stages };
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
    const { activity, session } = await lockPublishingActivity(trx, actor, input.activityId, "publishing.result.release", input.scope);
    const stage = requireStage(await publishingArtifact(trx, activity, session.definitionVersion), input.stageKey);
    const stageResult = await getStageResultForUpdate(trx, activity.id, stage.key);
    if (stageResult === null) throw new DomainError("RESULT_NOT_CONFIRMED", "The stage result has not been confirmed.");
    if (stageResult.status !== "confirmed") {
      throw new DomainError("RESULT_NOT_CONFIRMED", "The stage result is unlocked and must be confirmed again.");
    }
    if (stageResult.candidateRevision !== input.expectedCandidateRevision) {
      throw new DomainError("STALE_REVISION", "The stage result changed since it was read.");
    }
    if (stageResult.source === undefined || stageResult.source === null) {
      throw new DomainError(
        "RESULT_PROVENANCE_MISSING",
        "The confirmed result has no frozen source identity; unlock and confirm it again.",
      );
    }
    if (stageResult.source.definitionVersion !== session.definitionVersion) {
      throw new DomainError(
        "SOURCE_RELEASE_MISMATCH",
        "The confirmed result was produced by a different definition release.",
      );
    }
    let currentFingerprint = stageResult.inputFingerprint;
    if (stageResult.source.kind === "vote_session") {
      const voteSession = await getVoteSession(trx, stageResult.source.aggregateId);
      if (voteSession === null || voteSession.activityId !== activity.id) {
        throw new DomainError("RESULT_STALE", "The source voting session no longer exists.");
      }
      currentFingerprint = (await voteResultData(trx, activity.id, voteSession)).fingerprint;
    } else if (stageResult.source.kind === "podium_candidate") {
      const candidate = await getLatestPodiumCandidate(trx, activity.id);
      if (candidate === null || candidate.id !== stageResult.source.aggregateId) {
        throw new DomainError("RESULT_STALE", "The source podium candidate was replaced.");
      }
      currentFingerprint = candidate.inputFingerprint;
    }
    requireSourceFingerprint(stageResult, currentFingerprint);
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
        publicTitle: snapshot.publicTitle,
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
    const { activity, session } = await lockPublishingActivity(trx, actor, input.activityId, "publishing.result.revoke", input.scope);
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
    const { activity, session } = await lockPublishingActivity(trx, actor, input.activityId, "publishing.stage_result.unlock", input.scope);
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
    const { staleAt: _staleAt, ...current } = stageResult;
    const unlocked: StoredStageResult = {
      ...current,
      status: "ready_to_confirm",
      candidateRevision: stageResult.candidateRevision + 1,
      revision: stageResult.revision + 1,
      unlockedAt: deps.now(),
      staleReason: "",
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
    const { activity, session } = await lockPublishingActivity(trx, actor, input.activityId, "publishing.publication.edit", input.scope);
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
