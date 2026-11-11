import type { Database, StoredBallot, StoredVoteOption, StoredVoteSession } from "@artflow-plus/db";
import {
  countBallots,
  getActivityForUpdate,
  getTicketAccessSessionForUpdate,
  getTicketForUpdate,
  getVoteSession,
  getVoteSessionForUpdate,
  insertBallot,
  insertVoteOptions,
  insertVoteRecords,
  insertVoteSession,
  listVoteOptions,
  readValidVoteTally,
  updateVoteSessionStatus,
} from "@artflow-plus/db";
import { computeVoteScores, DomainError } from "@artflow-plus/domain";
import type { DecimalValue, ExecutionMode } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { requireRunningCommandSession } from "./command-scope.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";
import {
  credential,
  isUniqueViolation,
  requireActive,
  requireAnyPermission,
  votingArtifact,
} from "./voting-ticket-shared.js";

export interface OpenVoteSessionInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly sessionId: string;
  readonly scope: string;
  readonly candidateIds: readonly string[];
}

export interface OpenVoteSessionResult {
  readonly session: StoredVoteSession;
  readonly options: readonly StoredVoteOption[];
  readonly mode: ExecutionMode;
}

export async function openVoteSession(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: OpenVoteSessionInput,
): Promise<CommandOutcome<OpenVoteSessionResult>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "voting",
    commandType: "voting.session.open",
    scope: input.scope,
    actor,
    payload: { sessionId: input.sessionId, scope: input.scope, candidateIds: [...input.candidateIds].sort() },
  }, async (trx) => {
    requireAnyPermission(actor, ["voting.manage"]);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity, "Voting");
    const { session } = await requireRunningCommandSession(trx, activity, "voting.session.open", input.scope);
    const artifact = await votingArtifact(trx, activity, session.definitionVersion);
    const candidateIds = [...new Set(input.candidateIds.map((candidate) => candidate.trim()).filter(Boolean))];
    if (candidateIds.length === 0) throw new DomainError("INVALID_INPUT", "A voting session needs at least one candidate.");
    if (candidateIds.length !== input.candidateIds.length) throw new DomainError("INVALID_INPUT", "Candidate ids must be non-empty and unique.");
    const voteSession: StoredVoteSession = {
      id: input.sessionId,
      activityId: input.activityId,
      definitionVersion: session.definitionVersion,
      mode: session.mode,
      purpose: artifact.purpose,
      selectionType: artifact.selectionType,
      maxSelections: artifact.maxSelections,
      identityPolicy: artifact.identityPolicy,
      scoringRule: artifact.scoringRule,
      status: "open",
      revision: 0,
      openedAt: deps.now(),
    };
    if (await getVoteSessionForUpdate(trx, input.sessionId) !== null) throw new DomainError("INVALID_TRANSITION", "The voting session already exists.");
    const options = candidateIds.map((candidateId, ordinal) => ({
      id: idFromCommand("vote-option", `${input.sessionId}:${candidateId}`),
      activityId: input.activityId,
      sessionId: input.sessionId,
      candidateId,
      ordinal,
    }));
    await insertVoteSession(trx, voteSession);
    await insertVoteOptions(trx, options);
    await appendEngineEvent(trx, deps, {
      type: "VoteSessionOpened",
      activityId: input.activityId,
      aggregateType: "vote_session",
      aggregateId: input.sessionId,
      revision: 0,
      capability: "voting",
      scope: input.scope,
      mode: session.mode,
      payload: { sessionId: input.sessionId, optionIds: options.map((option) => option.id), definitionVersion: voteSession.definitionVersion },
    });
    return { body: { session: voteSession, options, mode: session.mode }, status: 201 };
  });
}

export type BallotIdentity =
  | { readonly type: "ticket"; readonly sessionToken: string }
  | { readonly type: "browser"; readonly fingerprint: string }
  | { readonly type: "anonymous" };

export interface SubmitBallotInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly sessionId: string;
  readonly scope: string;
  readonly optionIds: readonly string[];
  readonly identity: BallotIdentity;
}

export interface SubmitBallotResult {
  readonly ballot: StoredBallot;
  readonly mode: ExecutionMode;
}

export async function submitBallot(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: SubmitBallotInput,
): Promise<CommandOutcome<SubmitBallotResult>> {
  const actor = runtimeActor(deps);
  const optionIds = [...new Set(input.optionIds)].sort();
  if (optionIds.length !== input.optionIds.length || optionIds.length === 0) throw new DomainError("INVALID_INPUT", "Ballot selections must be non-empty and unique.");
  const ticketSessionDigest = input.identity.type === "ticket" ? stableHash(input.identity.sessionToken) : null;
  const identityPayload = input.identity.type === "ticket"
    ? { type: "ticket", sessionDigest: ticketSessionDigest }
    : input.identity.type === "browser"
      ? { type: "browser", digest: stableHash(input.identity.fingerprint) }
      : { type: "anonymous" };
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "voting",
    commandType: "voting.ballot.submit",
    scope: input.scope,
    actor,
    payload: { sessionId: input.sessionId, optionIds, identity: identityPayload },
  }, async (trx) => {
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity, "Voting");
    const voteSession = await getVoteSessionForUpdate(trx, input.sessionId);
    if (voteSession === null) throw new DomainError("NOT_FOUND", "The voting session was not found.");
    if (voteSession.activityId !== input.activityId) throw new DomainError("CROSS_ACTIVITY", "The voting session belongs to another activity.");
    if (voteSession.status !== "open") throw new DomainError("VOTE_SESSION_CLOSED", "The voting session is closed.");
    const { session: execution } = await requireRunningCommandSession(trx, activity, "voting.ballot.submit", input.scope);
    if (execution.definitionVersion !== voteSession.definitionVersion) throw new DomainError("STALE_CONTEXT", "The voting session is bound to a different execution release.");
    if (execution.mode !== voteSession.mode) throw new DomainError("STALE_CONTEXT", "The voting session belongs to another execution mode.");
    let ticketId: string | undefined;
    if (input.identity.type === "ticket") {
      if (voteSession.identityPolicy !== "ticket") throw new DomainError("BALLOT_IDENTITY_INVALID", "Ticket identity is not allowed for this voting session.");
      const accessSession = ticketSessionDigest === null ? null : await getTicketAccessSessionForUpdate(trx, ticketSessionDigest);
      const accessExpiresAt = accessSession === null ? Number.NaN : Date.parse(String(accessSession.expires_at));
      if (accessSession === null || accessSession.activity_id !== input.activityId || accessSession.revoked_at !== null || accessExpiresAt <= Date.parse(deps.now())) {
        throw new DomainError("INVALID_TICKET", "The ticket credential is invalid.");
      }
      const lockedTicket = await getTicketForUpdate(trx, accessSession.ticket_id);
      if (lockedTicket === null || lockedTicket.activityId !== input.activityId || lockedTicket.state !== "redeemed") {
        throw new DomainError("INVALID_TICKET", "The ticket access session is invalid.");
      }
      ticketId = lockedTicket.id;
    } else if (input.identity.type === "browser") {
      if (voteSession.identityPolicy !== "browser" || !input.identity.fingerprint.trim()) {
        throw new DomainError("BALLOT_IDENTITY_INVALID", "Browser identity is not allowed for this voting session.");
      }
    } else if (voteSession.identityPolicy !== "anonymous") {
      throw new DomainError("BALLOT_IDENTITY_INVALID", "Anonymous identity is not allowed for this voting session.");
    }
    const options = await listVoteOptions(trx, input.sessionId);
    const optionById = new Map(options.map((option) => [option.id, option]));
    if (optionIds.some((optionId) => optionById.get(optionId) === undefined)) throw new DomainError("OPTION_NOT_IN_SESSION", "A ballot option is not in the frozen candidate list.");
    if (optionIds.length > voteSession.maxSelections) throw new DomainError("TOO_MANY_SELECTIONS", "The ballot exceeds the frozen selection limit.");
    const identityType = input.identity.type;
    const identityDigest = identityType === "browser" ? stableHash(input.identity.fingerprint) : undefined;
    let duplicateQuery = trx.selectFrom("ballot").select("id").where("session_id", "=", input.sessionId);
    if (identityType === "ticket") duplicateQuery = duplicateQuery.where("ticket_id", "=", ticketId ?? "");
    if (identityType === "browser") duplicateQuery = duplicateQuery.where("identity_digest", "=", identityDigest ?? "");
    if (identityType !== "anonymous" && await duplicateQuery.executeTakeFirst() !== undefined) throw new DomainError("DUPLICATE_BALLOT", "This identity has already submitted a ballot.");
    const ballot: StoredBallot = {
      id: idFromCommand("ballot", input.commandId),
      activityId: input.activityId,
      sessionId: input.sessionId,
      identityType,
      ...(identityDigest === undefined ? {} : { identityDigest }),
      ...(ticketId === undefined ? {} : { ticketId }),
      submittedAt: deps.now(),
    };
    try {
      await insertBallot(trx, ballot);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new DomainError("DUPLICATE_BALLOT", "This identity has already submitted a ballot.");
    }
    await insertVoteRecords(trx, optionIds.map((optionId) => ({
      id: idFromCommand("vote-record", `${input.commandId}:${optionId}`),
      activity_id: input.activityId,
      session_id: input.sessionId,
      ballot_id: ballot.id,
      option_id: optionId,
    })));
    await appendEngineEvent(trx, deps, {
      type: "BallotSubmitted",
      activityId: input.activityId,
      aggregateType: "vote_session",
      aggregateId: input.sessionId,
      revision: voteSession.revision,
      capability: "voting",
      scope: input.scope,
      mode: execution.mode,
      payload: { sessionId: input.sessionId, ballotId: ballot.id, identityType, optionIds, selectionCount: optionIds.length },
    });
    return { body: { ballot, mode: execution.mode }, status: 201 };
  });
}

export interface CloseVoteSessionInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly sessionId: string;
  readonly scope: string;
  readonly expectedRevision: number;
}

export async function closeVoteSession(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: CloseVoteSessionInput,
): Promise<CommandOutcome<StoredVoteSession>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "voting",
    commandType: "voting.session.close",
    scope: input.scope,
    actor,
    payload: { sessionId: input.sessionId, expectedRevision: input.expectedRevision },
  }, async (trx) => {
    requireAnyPermission(actor, ["voting.manage"]);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity, "Voting");
    const session = await getVoteSessionForUpdate(trx, input.sessionId);
    if (session === null) throw new DomainError("NOT_FOUND", "The voting session was not found.");
    if (session.activityId !== input.activityId) throw new DomainError("CROSS_ACTIVITY", "The voting session belongs to another activity.");
    if (session.revision !== input.expectedRevision) throw new DomainError("STALE_REVISION", "The voting session changed since it was read.");
    if (session.status !== "open") throw new DomainError("VOTE_SESSION_CLOSED", "The voting session is already closed.");
    const { session: execution } = await requireRunningCommandSession(trx, activity, "voting.session.close", input.scope);
    if (execution.definitionVersion !== session.definitionVersion) throw new DomainError("STALE_CONTEXT", "The voting session is bound to a different execution release.");
    if (execution.mode !== session.mode) throw new DomainError("STALE_CONTEXT", "The voting session belongs to another execution mode.");
    const closed: StoredVoteSession = { ...session, status: "closed", revision: session.revision + 1, closedAt: deps.now() };
    await updateVoteSessionStatus(trx, closed, input.expectedRevision, deps.now());
    await appendEngineEvent(trx, deps, {
      type: "VoteSessionClosed",
      activityId: input.activityId,
      aggregateType: "vote_session",
      aggregateId: session.id,
      revision: closed.revision,
      capability: "voting",
      scope: input.scope,
      mode: execution.mode,
      payload: { sessionId: session.id, ballotCount: await countBallots(trx, session.id) },
    });
    return { body: closed };
  });
}

export interface VoteScoreReadModel {
  readonly sessionId: string;
  readonly totalBallots: number;
  readonly rawCounts: Readonly<Record<string, number>>;
  readonly scoreStatus: "ready" | "hold";
  readonly holdReason?: "NO_VALID_BALLOTS";
  readonly scoreInputs?: Readonly<Record<string, DecimalValue>>;
}

export async function getClosedVoteScores(
  db: Kysely<Database>,
  sessionId: string,
): Promise<VoteScoreReadModel> {
  const session = await getVoteSession(db, sessionId);
  if (session === null) throw new DomainError("NOT_FOUND", "The voting session was not found.");
  if (session.status !== "closed") throw new DomainError("VOTE_SESSION_NOT_OPEN", "Only a closed voting session has authoritative scores.");
  const tally = await readValidVoteTally(db, sessionId);
  const computed = computeVoteScores({ counts: tally.countsByOption, totalBallots: tally.totalBallots, rule: session.scoringRule });
  return computed.status === "ready"
    ? { sessionId, totalBallots: tally.totalBallots, rawCounts: tally.countsByOption, scoreStatus: "ready", scoreInputs: computed.scores }
    : { sessionId, totalBallots: tally.totalBallots, rawCounts: tally.countsByOption, scoreStatus: "hold", holdReason: computed.reason };
}
