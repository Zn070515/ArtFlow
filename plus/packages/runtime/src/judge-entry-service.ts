import type { Database } from "@artflow-plus/db";
import {
  claimJudgeEntrySeat,
  findActivityByPublicCodeAndVersion,
  getActivityForUpdate,
  getJudgeEntryForUpdate,
  insertJudgeSession,
  listAvailableJudgeSeatsForUpdate,
  updateJudgeEntry,
} from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";
import {
  DEFAULT_TICKET_TTL_MS,
  credential,
  judgeSessionToken,
  parseCredential,
  requireActive,
  requireAnyPermission,
  requireCapability,
  requireNotArchived,
  requireReason,
  secret,
  validCredentialForRow,
} from "./voting-ticket-shared.js";

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
    requireActive(activity, "Judge capability reissue");
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
    requireNotArchived(activity, "Judge entry closure");
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
    const sessionToken = judgeSessionToken(sessionId, signingSecret);
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
  }, {
    onReplay: (_trx, result) => ({
      ...result,
      sessionToken: judgeSessionToken(result.sessionId, signingSecret),
    }),
  });
}

export { credential as capabilityCredential, parseCredential };
