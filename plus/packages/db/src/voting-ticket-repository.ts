import type { CompiledVotingArtifact } from "@artflow-plus/domain";
import type { Kysely, Selectable } from "kysely";

import type {
  BallotRow,
  Database,
  JudgeSeatGrantRow,
  JudgeSessionRow,
  TicketAccessSessionRow,
  TicketRow,
  VoteOptionRow,
  VoteRecordRow,
  VoteSessionRow,
} from "./types.js";

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function json(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

export interface StoredVoteSession {
  readonly id: string;
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly purpose: "popularity" | "score_component";
  readonly selectionType: "single" | "multi";
  readonly maxSelections: number;
  readonly requiresTicket: boolean;
  readonly allowBrowserIdentity: boolean;
  readonly scoringRule: CompiledVotingArtifact["scoringRule"];
  readonly status: "draft" | "open" | "closed";
  readonly revision: number;
  readonly openedAt?: string;
  readonly closedAt?: string;
}

function voteSession(row: Selectable<VoteSessionRow>): StoredVoteSession {
  const openedAt = iso(row.opened_at);
  const closedAt = iso(row.closed_at);
  return {
    id: row.id,
    activityId: row.activity_id,
    definitionVersion: row.definition_version,
    purpose: row.purpose as StoredVoteSession["purpose"],
    selectionType: row.selection_type as StoredVoteSession["selectionType"],
    maxSelections: row.max_selections,
    requiresTicket: row.requires_ticket,
    allowBrowserIdentity: row.allow_browser_identity,
    scoringRule: json(row.scoring_rule) as CompiledVotingArtifact["scoringRule"],
    status: row.status as StoredVoteSession["status"],
    revision: row.revision,
    ...(openedAt === null ? {} : { openedAt }),
    ...(closedAt === null ? {} : { closedAt }),
  };
}

export interface StoredVoteOption {
  readonly id: string;
  readonly activityId: string;
  readonly sessionId: string;
  readonly candidateId: string;
  readonly ordinal: number;
}

function voteOption(row: Selectable<VoteOptionRow>): StoredVoteOption {
  return {
    id: row.id,
    activityId: row.activity_id,
    sessionId: row.session_id,
    candidateId: row.candidate_id,
    ordinal: row.ordinal,
  };
}

export interface StoredBallot {
  readonly id: string;
  readonly activityId: string;
  readonly sessionId: string;
  readonly identityType: "ticket" | "browser" | "anonymous";
  readonly identityDigest?: string;
  readonly ticketId?: string;
  readonly submittedAt: string;
}

function ballot(row: Selectable<BallotRow>): StoredBallot {
  return {
    id: row.id,
    activityId: row.activity_id,
    sessionId: row.session_id,
    identityType: row.identity_type as StoredBallot["identityType"],
    ...(row.identity_digest === null ? {} : { identityDigest: row.identity_digest }),
    ...(row.ticket_id === null ? {} : { ticketId: row.ticket_id }),
    submittedAt: iso(row.submitted_at) ?? "",
  };
}

export interface StoredTicket {
  readonly id: string;
  readonly activityId: string;
  readonly publicCode: string;
  readonly credentialDigest: string;
  readonly credentialVersion: number;
  readonly state: "issued" | "redeemed" | "revoked" | "expired";
  readonly issuedAt: string;
  readonly redeemedAt?: string;
  readonly revokedAt?: string;
}

function ticket(row: Selectable<TicketRow>): StoredTicket {
  const redeemedAt = iso(row.redeemed_at);
  const revokedAt = iso(row.revoked_at);
  return {
    id: row.id,
    activityId: row.activity_id,
    publicCode: row.public_code,
    credentialDigest: row.credential_digest,
    credentialVersion: row.credential_version,
    state: row.state as StoredTicket["state"],
    issuedAt: iso(row.issued_at) ?? "",
    ...(redeemedAt === null ? {} : { redeemedAt }),
    ...(revokedAt === null ? {} : { revokedAt }),
  };
}

export interface StoredJudgeEntrySeat {
  readonly id: string;
  readonly activityId: string;
  readonly seatKey: string;
  readonly judgeId?: string;
  readonly state: "available" | "claimed" | "revoked";
  readonly sessionId?: string;
  readonly revision: number;
}

function judgeSeat(row: Selectable<JudgeSeatGrantRow>): StoredJudgeEntrySeat {
  return {
    id: row.id,
    activityId: row.activity_id,
    seatKey: row.seat_key,
    ...(row.judge_id === null ? {} : { judgeId: row.judge_id }),
    state: row.state as StoredJudgeEntrySeat["state"],
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    revision: row.revision,
  };
}

export async function getVoteSession(
  db: Kysely<Database>,
  id: string,
): Promise<StoredVoteSession | null> {
  const row = await db.selectFrom("vote_session").selectAll().where("id", "=", id).executeTakeFirst();
  return row === undefined ? null : voteSession(row);
}

export async function getVoteSessionForUpdate(
  trx: Kysely<Database>,
  id: string,
): Promise<StoredVoteSession | null> {
  const row = await trx.selectFrom("vote_session").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
  return row === undefined ? null : voteSession(row);
}

export async function listVoteOptions(
  db: Kysely<Database>,
  sessionId: string,
): Promise<readonly StoredVoteOption[]> {
  const rows = await db.selectFrom("vote_option").selectAll().where("session_id", "=", sessionId).orderBy("ordinal", "asc").execute();
  return rows.map(voteOption);
}

export async function insertVoteSession(
  trx: Kysely<Database>,
  input: StoredVoteSession,
): Promise<void> {
  await trx.insertInto("vote_session").values({
    id: input.id,
    activity_id: input.activityId,
    definition_version: input.definitionVersion,
    purpose: input.purpose,
    selection_type: input.selectionType,
    max_selections: input.maxSelections,
    requires_ticket: input.requiresTicket,
    allow_browser_identity: input.allowBrowserIdentity,
    scoring_rule: JSON.stringify(input.scoringRule),
    status: input.status,
    revision: input.revision,
    opened_at: input.openedAt ?? null,
    closed_at: input.closedAt ?? null,
  }).execute();
}

export async function insertVoteOptions(
  trx: Kysely<Database>,
  options: readonly StoredVoteOption[],
): Promise<void> {
  if (options.length === 0) return;
  await trx.insertInto("vote_option").values(options.map((option) => ({
    id: option.id,
    activity_id: option.activityId,
    session_id: option.sessionId,
    candidate_id: option.candidateId,
    ordinal: option.ordinal,
  }))).execute();
}

export async function updateVoteSessionStatus(
  trx: Kysely<Database>,
  session: StoredVoteSession,
  expectedRevision: number,
  now: string,
): Promise<void> {
  await trx.updateTable("vote_session").set({
    status: session.status,
    revision: session.revision,
    opened_at: session.openedAt ?? null,
    closed_at: session.closedAt ?? null,
  }).where("id", "=", session.id).where("revision", "=", expectedRevision).executeTakeFirstOrThrow();
  void now;
}

export async function insertBallot(
  trx: Kysely<Database>,
  input: StoredBallot,
): Promise<void> {
  await trx.insertInto("ballot").values({
    id: input.id,
    activity_id: input.activityId,
    session_id: input.sessionId,
    identity_type: input.identityType,
    identity_digest: input.identityDigest ?? null,
    ticket_id: input.ticketId ?? null,
    submitted_at: input.submittedAt,
  }).execute();
}

export async function insertVoteRecords(
  trx: Kysely<Database>,
  records: readonly Pick<Selectable<VoteRecordRow>, "id" | "activity_id" | "session_id" | "ballot_id" | "option_id">[],
): Promise<void> {
  if (records.length === 0) return;
  await trx.insertInto("vote_record").values(records.map((record) => ({ ...record }))).execute();
}

export async function countBallots(
  db: Kysely<Database>,
  sessionId: string,
): Promise<number> {
  const row = await db.selectFrom("ballot").select(({ fn }) => fn.countAll<number>().as("count")).where("session_id", "=", sessionId).executeTakeFirstOrThrow();
  return Number(row.count);
}

export async function countVotesByOption(
  db: Kysely<Database>,
  sessionId: string,
): Promise<Readonly<Record<string, number>>> {
  const rows = await db.selectFrom("vote_record").select(["option_id", ({ fn }) => fn.countAll<number>().as("count")]).where("session_id", "=", sessionId).groupBy("option_id").execute();
  return Object.fromEntries(rows.map((row) => [row.option_id, Number(row.count)]));
}

export async function findTicketByCredential(
  db: Kysely<Database>,
  publicCode: string,
  version: number,
): Promise<StoredTicket | null> {
  const row = await db.selectFrom("ticket").selectAll().where("public_code", "=", publicCode).where("credential_version", "=", version).executeTakeFirst();
  return row === undefined ? null : ticket(row);
}

export async function getTicketForUpdate(
  trx: Kysely<Database>,
  id: string,
): Promise<StoredTicket | null> {
  const row = await trx.selectFrom("ticket").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
  return row === undefined ? null : ticket(row);
}

export async function getTicket(
  db: Kysely<Database>,
  id: string,
): Promise<StoredTicket | null> {
  const row = await db.selectFrom("ticket").selectAll().where("id", "=", id).executeTakeFirst();
  return row === undefined ? null : ticket(row);
}

export async function insertTicket(
  trx: Kysely<Database>,
  input: StoredTicket,
): Promise<void> {
  await trx.insertInto("ticket").values({
    id: input.id,
    activity_id: input.activityId,
    public_code: input.publicCode,
    credential_digest: input.credentialDigest,
    credential_version: input.credentialVersion,
    state: input.state,
    issued_at: input.issuedAt,
    redeemed_at: input.redeemedAt ?? null,
    revoked_at: input.revokedAt ?? null,
  }).execute();
}

export async function updateTicket(
  trx: Kysely<Database>,
  ticketValue: StoredTicket,
): Promise<void> {
  await trx.updateTable("ticket").set({
    credential_digest: ticketValue.credentialDigest,
    credential_version: ticketValue.credentialVersion,
    state: ticketValue.state,
    redeemed_at: ticketValue.redeemedAt ?? null,
    revoked_at: ticketValue.revokedAt ?? null,
  }).where("id", "=", ticketValue.id).executeTakeFirstOrThrow();
}

export async function listAvailableJudgeSeatsForUpdate(
  trx: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredJudgeEntrySeat[]> {
  const rows = await trx.selectFrom("judge_seat_grant").selectAll().where("activity_id", "=", activityId).where("state", "=", "available").orderBy("seat_key", "asc").forUpdate().skipLocked().execute();
  return rows.map(judgeSeat);
}

export async function insertJudgeEntrySeat(
  trx: Kysely<Database>,
  input: StoredJudgeEntrySeat,
): Promise<void> {
  await trx.insertInto("judge_seat_grant").values({
    id: input.id,
    activity_id: input.activityId,
    seat_key: input.seatKey,
    judge_id: input.judgeId ?? null,
    state: input.state,
    session_id: input.sessionId ?? null,
    revision: input.revision,
  }).execute();
}

export async function claimJudgeEntrySeat(
  trx: Kysely<Database>,
  seat: StoredJudgeEntrySeat,
  judgeId: string,
  sessionId: string,
): Promise<void> {
  await trx.updateTable("judge_seat_grant").set({
    judge_id: judgeId,
    state: "claimed",
    session_id: sessionId,
    revision: seat.revision + 1,
    updated_at: new Date(),
  }).where("id", "=", seat.id).where("state", "=", "available").executeTakeFirstOrThrow();
}

export async function insertJudgeSession(
  trx: Kysely<Database>,
  input: {
    readonly id: string;
    readonly activity_id: string;
    readonly seat_id: string;
    readonly actor_id: string;
    readonly token_digest: string;
    readonly expires_at: Date | string;
    readonly revoked_at: Date | string | null;
    readonly created_at?: Date;
  },
): Promise<void> {
  await trx.insertInto("judge_session").values({
    id: input.id,
    activity_id: input.activity_id,
    seat_id: input.seat_id,
    actor_id: input.actor_id,
    token_digest: input.token_digest,
    expires_at: input.expires_at,
    revoked_at: input.revoked_at,
  }).execute();
}

export async function getJudgeEntryForUpdate(
  trx: Kysely<Database>,
  activityId: string,
): Promise<{ readonly activityId: string; readonly publicCode: string; readonly open: boolean; readonly version: number } | null> {
  const row = await trx.selectFrom("activity").select(["id", "public_code", "judge_entry_open", "judge_entry_version"]).where("id", "=", activityId).forUpdate().executeTakeFirst();
  return row === undefined ? null : { activityId: row.id, publicCode: row.public_code, open: row.judge_entry_open, version: row.judge_entry_version };
}

export async function findActivityByPublicCodeAndVersion(
  db: Kysely<Database>,
  publicCode: string,
  version: number,
): Promise<{ readonly activityId: string; readonly publicCode: string; readonly version: number } | null> {
  const row = await db.selectFrom("activity").select(["id", "public_code", "judge_entry_version"]).where("public_code", "=", publicCode).where("judge_entry_version", "=", version).executeTakeFirst();
  return row === undefined ? null : { activityId: row.id, publicCode: row.public_code, version: row.judge_entry_version };
}

export async function updateJudgeEntry(
  trx: Kysely<Database>,
  activityId: string,
  input: { readonly open: boolean; readonly version: number },
): Promise<void> {
  await trx.updateTable("activity").set({ judge_entry_open: input.open, judge_entry_version: input.version }).where("id", "=", activityId).executeTakeFirstOrThrow();
}

export async function getTicketAccessSessionForUpdate(
  trx: Kysely<Database>,
  tokenDigest: string,
): Promise<Selectable<TicketAccessSessionRow> | null> {
  return (await trx.selectFrom("ticket_access_session").selectAll().where("token_digest", "=", tokenDigest).forUpdate().executeTakeFirst()) ?? null;
}

export async function getTicketAccessSessionByIdForUpdate(
  trx: Kysely<Database>,
  id: string,
): Promise<Selectable<TicketAccessSessionRow> | null> {
  return (await trx.selectFrom("ticket_access_session").selectAll().where("id", "=", id).forUpdate().executeTakeFirst()) ?? null;
}

export async function revokeTicketAccessSession(
  trx: Kysely<Database>,
  id: string,
  revokedAt: string,
): Promise<void> {
  await trx.updateTable("ticket_access_session").set({ revoked_at: revokedAt }).where("id", "=", id).where("revoked_at", "is", null).executeTakeFirstOrThrow();
}

export async function findTicketAccessSession(
  db: Kysely<Database>,
  tokenDigest: string,
): Promise<{ readonly id: string; readonly activityId: string; readonly ticketId: string; readonly expiresAt: string; readonly revokedAt?: string } | null> {
  const row = await db.selectFrom("ticket_access_session").selectAll().where("token_digest", "=", tokenDigest).executeTakeFirst();
  if (row === undefined) return null;
  const expiresAt = iso(row.expires_at) ?? "";
  const revokedAt = iso(row.revoked_at);
  return {
    id: row.id,
    activityId: row.activity_id,
    ticketId: row.ticket_id,
    expiresAt,
    ...(revokedAt === null ? {} : { revokedAt }),
  };
}

export async function insertTicketAccessSession(
  trx: Kysely<Database>,
  input: {
    readonly id: string;
    readonly activity_id: string;
    readonly ticket_id: string;
    readonly token_digest: string;
    readonly expires_at: Date | string;
    readonly last_seen_at: Date | string | null;
    readonly revoked_at: Date | string | null;
    readonly created_at?: Date;
  },
): Promise<void> {
  await trx.insertInto("ticket_access_session").values({ ...input }).execute();
}
