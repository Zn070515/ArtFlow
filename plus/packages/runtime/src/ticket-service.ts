import type { Database, StoredTicket } from "@artflow-plus/db";
import {
  findJudgeSession,
  findTicketAccessSession,
  findTicketByCredential,
  getActivityForUpdate,
  getTicket,
  getTicketAccessSessionByIdForUpdate,
  getTicketForUpdate,
  insertTicket,
  insertTicketAccessSession,
  listVoteSessionIdsForTicket,
  revokeTicketAccessSession as revokeTicketAccessSessionRow,
  updateTicket,
} from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";
import { markConsumedResultsStale } from "./result-consumption.js";
import {
  DEFAULT_TICKET_TTL_MS,
  credential,
  parseCredential,
  requireActive,
  requireAnyPermission,
  requireCapability,
  requireNotArchived,
  requireReason,
  secret,
  ticketAccessToken,
  validCredentialForRow,
} from "./voting-ticket-shared.js";

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
    requireActive(activity, "Ticket rotation");
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
    // Rotation only applies to an issued (never redeemed) ticket, so it cannot
    // have produced a ballot and must not invalidate a confirmed result.
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
    requireNotArchived(activity, "Ticket revocation");
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
    const affectedSessions = await listVoteSessionIdsForTicket(trx, input.activityId, ticket.id);
    if (affectedSessions.length > 0) {
      await markConsumedResultsStale(
        trx,
        deps,
        input.activityId,
        { kind: "vote_session", aggregateIds: affectedSessions },
        "A ticket that voted in this session was revoked.",
      );
    }
    return { body: revoked };
  });
}

export interface AttendanceTicketResolution {
  readonly ticketId: string;
  readonly activityId: string;
}

/**
 * Resolve a scanned ticket credential for attendance without creating a ticket
 * access session or changing the ticket state. The attendance command re-reads
 * the ticket inside its own transaction.
 */
export async function resolveTicketCredentialForAttendance(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  rawCredential: string,
): Promise<AttendanceTicketResolution> {
  const signingSecret = secret(deps);
  const parsed = parseCredential(rawCredential, "T", signingSecret);
  if (parsed === null) throw new DomainError("INVALID_TICKET", "The ticket credential is invalid.");
  const candidate = await findTicketByCredential(db, parsed.publicCode, parsed.version);
  if (
    candidate === null ||
    !validCredentialForRow(rawCredential, "T", candidate.publicCode, candidate.credentialVersion, signingSecret)
  ) {
    throw new DomainError("INVALID_TICKET", "The ticket credential is invalid.");
  }
  return { ticketId: candidate.id, activityId: candidate.activityId };
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
    const accessToken = ticketAccessToken(sessionId, signingSecret);
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
  }, {
    onReplay: (_trx, result) => ({
      ...result,
      accessToken: ticketAccessToken(result.sessionId, signingSecret),
    }),
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
    requireNotArchived(activity, "Ticket access-session revocation");
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
    // The tally predicate only looks at ticket.state, so revoking an access
    // session stops future use but does not re-open the historical ballots.
    return { body: { sessionId: input.sessionId, revoked: true } };
  });
}
