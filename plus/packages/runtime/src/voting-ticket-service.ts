import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  Database,
  StoredBallot,
  StoredTicket,
  StoredVoteOption,
  StoredVoteSession,
} from "@artflow-plus/db";
import {
  countBallots,
  countVotesByOption,
  findActivityByPublicCodeAndVersion,
  findJudgeSession,
  findTicketAccessSession,
  findTicketByCredential,
  findRunningSessionByScope,
  getActivityForUpdate,
  getJudgeEntryForUpdate,
  getRelease,
  getTicketForUpdate,
  getTicket,
  getTicketAccessSessionForUpdate,
  getTicketAccessSessionByIdForUpdate,
  getVoteSession,
  getVoteSessionForUpdate,
  insertBallot,
  insertJudgeSession,
  claimJudgeEntrySeat,
  insertTicket,
  insertTicketAccessSession,
  insertVoteSession,
  insertVoteOptions,
  insertVoteRecords,
  listAvailableJudgeSeatsForUpdate,
  listVoteOptions,
  updateJudgeEntry,
  updateTicket,
  revokeTicketAccessSession as revokeTicketAccessSessionRow,
  updateVoteSessionStatus,
} from "@artflow-plus/db";
import {
  computeVoteScores,
  DomainError,
  requirePermission,
} from "@artflow-plus/domain";
import type { CompiledVotingArtifact, ExecutionMode } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";

const DEFAULT_TICKET_TTL_MS = 8 * 60 * 60 * 1000;

type CredentialKind = "T" | "J";

interface ParsedCredential {
  readonly kind: CredentialKind;
  readonly publicCode: string;
  readonly version: number;
  readonly signature: string;
}

function secret(deps: RuntimeDeps): string {
  const value = deps.credentialSecret;
  if (value === undefined || value.length < 16) {
    throw new DomainError("INVALID_INPUT", "A credential signing secret is not configured.");
  }
  return value;
}

function signature(kind: CredentialKind, publicCode: string, version: number, signingSecret: string): string {
  return createHmac("sha256", signingSecret)
    .update(`AF1.${kind}.${publicCode}.${version}`)
    .digest("hex")
    .slice(0, 32);
}

function credential(kind: CredentialKind, publicCode: string, version: number, signingSecret: string): string {
  return `AF1.${kind}.${publicCode}.${version}.${signature(kind, publicCode, version, signingSecret)}`;
}

function parseCredential(raw: unknown, kind: CredentialKind, signingSecret: string): ParsedCredential | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(".");
  if (parts.length !== 5 || parts[0] !== "AF1" || parts[1] !== kind) return null;
  const publicCode = parts[2];
  const versionText = parts[3];
  const provided = parts[4];
  if (publicCode === undefined || versionText === undefined || provided === undefined || !/^\d+$/.test(versionText)) return null;
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 1 || !/^[a-f0-9]{32}$/.test(provided)) return null;
  const expected = signature(kind, publicCode, version, signingSecret);
  const expectedBytes = Buffer.from(expected, "ascii");
  const providedBytes = Buffer.from(provided, "ascii");
  if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) return null;
  return { kind, publicCode, version, signature: provided };
}

function validCredentialForRow(
  raw: string,
  kind: CredentialKind,
  publicCode: string,
  version: number,
  signingSecret: string,
): boolean {
  const parsed = parseCredential(raw, kind, signingSecret);
  return parsed !== null && parsed.publicCode === publicCode && parsed.version === version;
}

function requireActive(activity: { readonly status: string }, label: string): void {
  if (activity.status !== "active") throw new DomainError("ACTIVITY_NOT_ACTIVE", `${label} requires an active activity.`);
}

function requireReason(value: string): string {
  const reason = value.trim();
  if (!reason) throw new DomainError("INVALID_INPUT", "A reason is required.");
  return reason;
}

function requireCapability(activity: { readonly enabledCapabilities: readonly string[] }, key: string): void {
  if (!activity.enabledCapabilities.includes(key)) throw new DomainError("CAPABILITY_NOT_ENABLED", `Capability ${key} is not enabled on this activity.`);
}

function requireAnyPermission(actor: Parameters<typeof requirePermission>[0], permissions: readonly string[]): void {
  if (actor.permissions.includes("*") || permissions.some((permission) => actor.permissions.includes(permission))) return;
  throw new DomainError("FORBIDDEN", `One of ${permissions.join(", ")} is required.`);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

async function votingArtifact(
  trx: Kysely<Database>,
  activity: { readonly id: string },
  definitionVersion: number,
): Promise<CompiledVotingArtifact> {
  const release = await getRelease(trx, activity.id, definitionVersion);
  if (release === null) throw new DomainError("VERSION_NOT_RELEASED", "The activity has no active released definition.");
  const plan = release.capabilities.voting;
  if (plan === undefined || plan.ok !== true) throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The release has no voting snapshot.");
  return plan.artifact as CompiledVotingArtifact;
}

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
    const session = await findRunningSessionByScope(trx, input.activityId, input.scope);
    if (session === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution.`);
    const artifact = await votingArtifact(trx, activity, session.definitionVersion);
    const candidateIds = [...new Set(input.candidateIds.map((candidate) => candidate.trim()).filter(Boolean))];
    if (candidateIds.length === 0) throw new DomainError("INVALID_INPUT", "A voting session needs at least one candidate.");
    if (candidateIds.length !== input.candidateIds.length) throw new DomainError("INVALID_INPUT", "Candidate ids must be non-empty and unique.");
    const voteSession: StoredVoteSession = {
      id: input.sessionId,
      activityId: input.activityId,
      definitionVersion: session.definitionVersion,
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
    const execution = await findRunningSessionByScope(trx, input.activityId, input.scope);
    if (execution === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution.`);
    if (execution.definitionVersion !== voteSession.definitionVersion) throw new DomainError("STALE_CONTEXT", "The voting session is bound to a different execution release.");
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
    const execution = await findRunningSessionByScope(trx, input.activityId, input.scope);
    if (execution === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution.`);
    if (execution.definitionVersion !== session.definitionVersion) throw new DomainError("STALE_CONTEXT", "The voting session is bound to a different execution release.");
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
  readonly scoreInputs?: Readonly<Record<string, number>>;
}

export async function getClosedVoteScores(
  db: Kysely<Database>,
  sessionId: string,
): Promise<VoteScoreReadModel> {
  const session = await getVoteSession(db, sessionId);
  if (session === null) throw new DomainError("NOT_FOUND", "The voting session was not found.");
  if (session.status !== "closed") throw new DomainError("VOTE_SESSION_NOT_OPEN", "Only a closed voting session has authoritative scores.");
  const totalBallots = await countBallots(db, sessionId);
  const counted = await countVotesByOption(db, sessionId);
  const options = await listVoteOptions(db, sessionId);
  const rawCounts = Object.fromEntries(options.map((option) => [option.id, counted[option.id] ?? 0]));
  const computed = computeVoteScores({ counts: rawCounts, totalBallots, rule: session.scoringRule });
  return computed.status === "ready"
    ? { sessionId, totalBallots, rawCounts, scoreStatus: "ready", scoreInputs: computed.scores }
    : { sessionId, totalBallots, rawCounts, scoreStatus: "hold", holdReason: computed.reason };
}

export interface IssueTicketInput {
  readonly commandId: string;
  readonly activityId: string;
}

export interface IssuedTicketResult {
  readonly ticket: StoredTicket;
  readonly credential?: string;
}

export async function issueTicket(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: IssueTicketInput,
): Promise<CommandOutcome<IssuedTicketResult>> {
  const actor = runtimeActor(deps);
  const signingSecret = secret(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "ticketing",
    commandType: "ticketing.ticket.issue",
    actor,
    payload: {},
  }, async (trx) => {
    requireAnyPermission(actor, ["ticket.manage"]);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireCapability(activity, "ticketing");
    requireActive(activity, "Ticket issuance");
    const id = idFromCommand("ticket", input.commandId);
    const publicCode = idFromCommand("ticket-code", input.commandId).replace(/[^A-Za-z0-9]/g, "").slice(-24);
    const rawCredential = credential("T", publicCode, 1, signingSecret);
    const ticket: StoredTicket = {
      id,
      activityId: input.activityId,
      publicCode,
      credentialDigest: stableHash(rawCredential),
      credentialVersion: 1,
      state: "issued",
      issuedAt: deps.now(),
    };
    await insertTicket(trx, ticket);
    await appendEngineEvent(trx, deps, {
      type: "TicketIssued",
      activityId: input.activityId,
      aggregateType: "ticket",
      aggregateId: ticket.id,
      revision: 0,
      capability: "ticketing",
      payload: { ticketId: ticket.id, publicCode: ticket.publicCode, credentialVersion: 1 },
    });
    const body: IssuedTicketResult = { ticket, credential: rawCredential };
    return { body, persistedBody: { ticket, credential: null }, status: 201 };
  });
}

export interface RotateTicketInput { readonly commandId: string; readonly activityId: string; readonly ticketId: string; }

export async function rotateTicketCredential(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: RotateTicketInput,
): Promise<CommandOutcome<IssuedTicketResult>> {
  const actor = runtimeActor(deps);
  const signingSecret = secret(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "ticketing",
    commandType: "ticketing.ticket.rotate",
    actor,
    payload: { ticketId: input.ticketId },
  }, async (trx) => {
    requireAnyPermission(actor, ["ticket.manage"]);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireCapability(activity, "ticketing");
    const current = await getTicketForUpdate(trx, input.ticketId);
    if (current === null) throw new DomainError("NOT_FOUND", "The ticket was not found.");
    if (current.activityId !== input.activityId) throw new DomainError("CROSS_ACTIVITY", "The ticket belongs to another activity.");
    if (current.state !== "issued") throw new DomainError("INVALID_TRANSITION", "Only an issued ticket credential can be rotated.");
    const nextVersion = current.credentialVersion + 1;
    const rawCredential = credential("T", current.publicCode, nextVersion, signingSecret);
    const next: StoredTicket = { ...current, credentialVersion: nextVersion, credentialDigest: stableHash(rawCredential) };
    await updateTicket(trx, next);
    await appendEngineEvent(trx, deps, {
      type: "TicketCredentialRotated",
      activityId: input.activityId,
      aggregateType: "ticket",
      aggregateId: current.id,
      revision: nextVersion,
      capability: "ticketing",
      payload: { ticketId: current.id, credentialVersion: nextVersion },
    });
    const body: IssuedTicketResult = { ticket: next, credential: rawCredential };
    return { body, persistedBody: { ticket: next, credential: null } };
  });
}

export async function revokeTicket(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly commandId: string; readonly activityId: string; readonly ticketId: string; readonly reason: string },
): Promise<CommandOutcome<StoredTicket>> {
  const actor = runtimeActor(deps);
  const reason = requireReason(input.reason);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "ticketing",
    commandType: "ticketing.ticket.revoke",
    actor,
    payload: { ticketId: input.ticketId, reason },
  }, async (trx) => {
    requireAnyPermission(actor, ["ticket.manage"]);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireCapability(activity, "ticketing");
    const ticket = await getTicketForUpdate(trx, input.ticketId);
    if (ticket === null) throw new DomainError("NOT_FOUND", "The ticket was not found.");
    if (ticket.activityId !== input.activityId) throw new DomainError("CROSS_ACTIVITY", "The ticket belongs to another activity.");
    if (ticket.state === "revoked" || ticket.state === "expired") throw new DomainError("INVALID_TRANSITION", "The ticket is already in a terminal state.");
    const revoked: StoredTicket = { ...ticket, state: "revoked", revokedAt: deps.now() };
    await updateTicket(trx, revoked);
    await appendEngineEvent(trx, deps, {
      type: "TicketRevoked",
      activityId: input.activityId,
      aggregateType: "ticket",
      aggregateId: ticket.id,
      revision: ticket.credentialVersion,
      capability: "ticketing",
      payload: { ticketId: ticket.id, reason },
    });
    return { body: revoked };
  });
}

export interface RedeemTicketInput {
  readonly commandId: string;
  readonly credential: string;
  readonly ttlMs?: number;
}

export interface RedeemedTicketResult {
  readonly ticketId: string;
  readonly activityId: string;
  readonly sessionId: string;
  readonly accessToken?: string;
  readonly expiresAt: string;
}

/** Resolves a ticket, then locks and revalidates the exact ticket before redeeming it. */
export async function redeemTicketCredential(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: RedeemTicketInput,
): Promise<CommandOutcome<RedeemedTicketResult>> {
  const signingSecret = secret(deps);
  const parsed = parseCredential(input.credential, "T", signingSecret);
  if (parsed === null) throw new DomainError("INVALID_TICKET", "The ticket credential is invalid.");
  const candidate = await findTicketByCredential(db, parsed.publicCode, parsed.version);
  if (candidate === null) throw new DomainError("INVALID_TICKET", "The ticket credential is invalid.");
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: candidate.activityId,
    capability: "ticketing",
    commandType: "ticketing.ticket.redeem",
    actor,
    payload: { ticketId: candidate.id },
  }, async (trx) => {
    const activity = await getActivityForUpdate(trx, candidate.activityId);
    if (activity === null) throw new DomainError("INVALID_TICKET", "The ticket credential is invalid.");
    requireCapability(activity, "ticketing");
    requireActive(activity, "Ticket redemption");
    const ticket = await getTicketForUpdate(trx, candidate.id);
    if (ticket === null || ticket.activityId !== candidate.activityId || ticket.state === "revoked" || ticket.state === "expired" || !validCredentialForRow(input.credential, "T", ticket.publicCode, ticket.credentialVersion, signingSecret)) {
      throw new DomainError("INVALID_TICKET", "The ticket credential is invalid.");
    }
    if (ticket.state === "redeemed") throw new DomainError("TICKET_REPLAYED", "The ticket credential has already been redeemed.");
    const sessionId = idFromCommand("ticket-session", input.commandId);
    const accessToken = `AF1.S.${sessionId}.${deps.newEventId()}`;
    const expiresAt = new Date(Date.parse(deps.now()) + (input.ttlMs ?? DEFAULT_TICKET_TTL_MS)).toISOString();
    await insertTicketAccessSession(trx, {
      id: sessionId,
      activity_id: candidate.activityId,
      ticket_id: ticket.id,
      token_digest: stableHash(accessToken),
      expires_at: expiresAt,
      last_seen_at: null,
      revoked_at: null,
      created_at: new Date(deps.now()),
    });
    const redeemed: StoredTicket = { ...ticket, state: "redeemed", redeemedAt: deps.now() };
    await updateTicket(trx, redeemed);
    await appendEngineEvent(trx, deps, {
      type: "TicketRedeemed",
      activityId: candidate.activityId,
      aggregateType: "ticket",
      aggregateId: ticket.id,
      revision: ticket.credentialVersion,
      capability: "ticketing",
      payload: { ticketId: ticket.id, sessionId, expiresAt },
    });
    const body: RedeemedTicketResult = { ticketId: ticket.id, activityId: candidate.activityId, sessionId, accessToken, expiresAt };
    return { body, persistedBody: { ...body, accessToken: null } };
  });
}

export interface AuthenticatedTicketSession {
  readonly sessionId: string;
  readonly activityId: string;
  readonly ticketId: string;
  readonly expiresAt: string;
}

/** Read-only session authentication; it never refreshes a credential or creates authority. */
export async function authenticateTicketSession(
  db: Kysely<Database>,
  rawToken: string,
  now = new Date(),
): Promise<AuthenticatedTicketSession> {
  if (!rawToken.trim()) throw new DomainError("UNAUTHENTICATED", "A ticket access session is required.");
  const session = await findTicketAccessSession(db, stableHash(rawToken));
  if (session === null) throw new DomainError("UNAUTHENTICATED", "The ticket access session is invalid.");
  if (session.revokedAt !== undefined) throw new DomainError("TICKET_SESSION_REVOKED", "The ticket access session is revoked.");
  if (Date.parse(session.expiresAt) <= now.getTime()) throw new DomainError("TICKET_SESSION_EXPIRED", "The ticket access session has expired.");
  const ticket = await getTicket(db, session.ticketId);
  if (ticket === null || ticket.state === "revoked" || ticket.state === "expired") throw new DomainError("UNAUTHENTICATED", "The ticket access session is invalid.");
  return { sessionId: session.id, activityId: session.activityId, ticketId: session.ticketId, expiresAt: session.expiresAt };
}

export interface AuthenticatedJudgeSession {
  readonly sessionId: string;
  readonly activityId: string;
  readonly seatId: string;
  readonly expiresAt: string;
}

/** Read-only judge-session authentication; scoring still rechecks the locked row. */
export async function authenticateJudgeSession(
  db: Kysely<Database>,
  rawToken: string,
  now = new Date(),
): Promise<AuthenticatedJudgeSession> {
  if (!rawToken.trim()) throw new DomainError("UNAUTHENTICATED", "A judge session is required.");
  const session = await findJudgeSession(db, stableHash(rawToken));
  if (session === null || session.revokedAt !== undefined) throw new DomainError("UNAUTHENTICATED", "The judge session is invalid.");
  if (Date.parse(session.expiresAt) <= now.getTime()) throw new DomainError("UNAUTHENTICATED", "The judge session has expired.");
  return { sessionId: session.id, activityId: session.activityId, seatId: session.seatId, expiresAt: session.expiresAt };
}

export async function revokeTicketAccessSession(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly commandId: string; readonly activityId: string; readonly sessionId: string; readonly reason: string },
): Promise<CommandOutcome<{ readonly sessionId: string; readonly revoked: true }>> {
  const actor = runtimeActor(deps);
  const reason = requireReason(input.reason);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "ticketing",
    commandType: "ticketing.session.revoke",
    actor,
    payload: { sessionId: input.sessionId, reason },
  }, async (trx) => {
    requireAnyPermission(actor, ["ticket.manage"]);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireCapability(activity, "ticketing");
    const session = await getTicketAccessSessionByIdForUpdate(trx, input.sessionId);
    if (session === null || session.activity_id !== input.activityId) throw new DomainError("NOT_FOUND", "The ticket access session was not found.");
    if (session.revoked_at !== null) throw new DomainError("INVALID_TRANSITION", "The ticket access session is already revoked.");
    await revokeTicketAccessSessionRow(trx, input.sessionId, deps.now());
    await appendEngineEvent(trx, deps, {
      type: "TicketAccessSessionRevoked",
      activityId: input.activityId,
      aggregateType: "ticket_access_session",
      aggregateId: input.sessionId,
      revision: 1,
      capability: "ticketing",
      payload: { sessionId: input.sessionId, ticketId: session.ticket_id, reason },
    });
    return { body: { sessionId: input.sessionId, revoked: true } };
  });
}

export interface ReissueJudgeCapabilityInput { readonly commandId: string; readonly activityId: string; readonly reason: string; }

export async function reissueJudgeCapability(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ReissueJudgeCapabilityInput,
): Promise<CommandOutcome<{ readonly version: number; readonly capability?: string }>> {
  const actor = runtimeActor(deps);
  const reason = requireReason(input.reason);
  const signingSecret = secret(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "ticketing",
    commandType: "ticketing.judge_capability.reissue",
    actor,
    payload: { reason },
  }, async (trx) => {
    requireAnyPermission(actor, ["ticket.manage", "judge.manage"]);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireCapability(activity, "ticketing");
    const entry = await getJudgeEntryForUpdate(trx, input.activityId);
    if (entry === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    const version = entry.version + 1;
    await updateJudgeEntry(trx, input.activityId, { open: entry.open, version });
    await appendEngineEvent(trx, deps, {
      type: "JudgeCapabilityReissued",
      activityId: input.activityId,
      aggregateType: "judge_entry",
      aggregateId: input.activityId,
      revision: version,
      capability: "ticketing",
      payload: { version, reason },
    });
    const capability = credential("J", entry.publicCode, version, signingSecret);
    return { body: { version, capability }, persistedBody: { version, capability: null } };
  });
}

export async function closeJudgeEntry(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly commandId: string; readonly activityId: string; readonly reason: string },
): Promise<CommandOutcome<{ readonly open: false; readonly version: number }>> {
  const actor = runtimeActor(deps);
  const reason = requireReason(input.reason);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "ticketing",
    commandType: "ticketing.judge_entry.close",
    actor,
    payload: { reason },
  }, async (trx) => {
    requireAnyPermission(actor, ["ticket.manage", "judge.manage"]);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireCapability(activity, "ticketing");
    const entry = await getJudgeEntryForUpdate(trx, input.activityId);
    if (entry === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    if (!entry.open) throw new DomainError("INVALID_TRANSITION", "The judge entry is already closed.");
    await updateJudgeEntry(trx, input.activityId, { open: false, version: entry.version });
    await appendEngineEvent(trx, deps, {
      type: "JudgeEntryClosed",
      activityId: input.activityId,
      aggregateType: "judge_entry",
      aggregateId: input.activityId,
      revision: entry.version,
      capability: "ticketing",
      payload: { reason },
    });
    return { body: { open: false, version: entry.version } };
  });
}

export interface ClaimJudgeSeatInput {
  readonly commandId: string;
  readonly publicCode: string;
  readonly capability: string;
}

export interface ClaimedJudgeSeatResult {
  readonly activityId: string;
  readonly seatId: string;
  readonly seatKey: string;
  readonly sessionId: string;
  readonly sessionToken?: string;
  readonly expiresAt: string;
}

export async function claimJudgeSeat(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ClaimJudgeSeatInput,
): Promise<CommandOutcome<ClaimedJudgeSeatResult>> {
  const signingSecret = secret(deps);
  const parsed = parseCredential(input.capability, "J", signingSecret);
  if (parsed === null || parsed.publicCode !== input.publicCode) throw new DomainError("INVALID_JUDGE_ENTRY", "The judge entry capability is invalid.");
  const candidate = await findActivityByPublicCodeAndVersion(db, input.publicCode, parsed.version);
  if (candidate === null) throw new DomainError("INVALID_JUDGE_ENTRY", "The judge entry capability is invalid.");
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: candidate.activityId,
    capability: "ticketing",
    commandType: "ticketing.judge_seat.claim",
    actor,
    payload: { publicCode: input.publicCode, capabilityVersion: parsed.version },
  }, async (trx) => {
    const activity = await getActivityForUpdate(trx, candidate.activityId);
    if (activity === null) throw new DomainError("INVALID_JUDGE_ENTRY", "The judge entry capability is invalid.");
    requireCapability(activity, "ticketing");
    requireActive(activity, "Judge entry");
    const entry = await getJudgeEntryForUpdate(trx, candidate.activityId);
    if (entry === null || parsed.version !== entry.version || !validCredentialForRow(input.capability, "J", entry.publicCode, entry.version, signingSecret)) throw new DomainError("INVALID_JUDGE_ENTRY", "The judge entry capability is invalid.");
    if (!entry.open) throw new DomainError("JUDGE_ENTRY_CLOSED", "The judge entry is closed.");
    const seats = await listAvailableJudgeSeatsForUpdate(trx, candidate.activityId);
    const seat = seats[0];
    if (seat === undefined) throw new DomainError("SEAT_UNAVAILABLE", "No judge seat is available.");
    const sessionId = idFromCommand("judge-session", input.commandId);
    const sessionToken = `AF1.S.${sessionId}.${deps.newEventId()}`;
    const expiresAt = new Date(Date.parse(deps.now()) + DEFAULT_TICKET_TTL_MS).toISOString();
    await insertJudgeSession(trx, {
      id: sessionId,
      activity_id: candidate.activityId,
      seat_id: seat.id,
      actor_id: actor.actorId,
      token_digest: stableHash(sessionToken),
      expires_at: expiresAt,
      revoked_at: null,
      created_at: new Date(deps.now()),
    });
    await claimJudgeEntrySeat(trx, seat, actor.actorId, sessionId);
    await appendEngineEvent(trx, deps, {
      type: "JudgeSeatClaimed",
      activityId: candidate.activityId,
      aggregateType: "judge_entry",
      aggregateId: candidate.activityId,
      revision: entry.version,
      capability: "ticketing",
      payload: { seatId: seat.id, seatKey: seat.seatKey, sessionId, judgeId: actor.actorId },
    });
    const body: ClaimedJudgeSeatResult = { activityId: candidate.activityId, seatId: seat.id, seatKey: seat.seatKey, sessionId, sessionToken, expiresAt };
    return { body, persistedBody: { ...body, sessionToken: null } };
  });
}

export { credential as capabilityCredential, parseCredential };
