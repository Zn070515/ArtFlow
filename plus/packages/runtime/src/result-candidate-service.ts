import type {
  Database,
  StoredResultSource,
  StoredStageResult,
} from "@artflow-plus/db";
import {
  getActivity,
  getRelease,
  getStageResultForUpdate,
  getVoteSession,
  insertStageResult,
  listVoteOptions,
  updateStageResult,
} from "@artflow-plus/db";
import {
  buildVoteResultDecisions,
  DomainError,
  requirePermission,
  validateAwards,
} from "@artflow-plus/domain";
import type { ResultAward } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";
import { getClosedVoteScores } from "./voting-session-service.js";
import {
  lockPublishingActivity,
  publishingArtifact,
  requireCapability,
  requireStage,
} from "./publishing-shared.js";

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

export async function voteResultData(
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
      dependencyRefs: [`voteSession:${voteSession.id}`],
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
