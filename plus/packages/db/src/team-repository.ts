import type { Kysely, Selectable } from "kysely";

import type { Database, TournamentTeamMemberRow, TournamentTeamRow } from "./types.js";

export type StoredTeamStatus = "draft" | "frozen" | "withdrawn";
export type StoredTeamSource = "manual" | "grouping";
export type StoredTeamMemberRole = "member" | "captain";

export interface StoredTeam {
  readonly id: string;
  readonly activityId: string;
  readonly teamKey: string;
  readonly name: string;
  readonly status: StoredTeamStatus;
  readonly source: StoredTeamSource;
  readonly sourceGroupingStageId?: string;
  readonly sourceRevision?: number;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly withdrawnAt?: string;
  readonly withdrawReason?: string;
}

export interface StoredTeamMember {
  readonly id: string;
  readonly activityId: string;
  readonly teamId: string;
  readonly participantId: string;
  readonly role: StoredTeamMemberRole;
  readonly addedAt: string;
  readonly removedAt?: string;
}

function iso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function team(row: Selectable<TournamentTeamRow>): StoredTeam {
  const withdrawnAt = iso(row.withdrawn_at);
  return {
    id: row.id,
    activityId: row.activity_id,
    teamKey: row.team_key,
    name: row.name,
    status: row.status as StoredTeamStatus,
    source: row.source as StoredTeamSource,
    ...(row.source_grouping_stage_id === null ? {} : { sourceGroupingStageId: row.source_grouping_stage_id }),
    ...(row.source_revision === null ? {} : { sourceRevision: row.source_revision }),
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
    ...(withdrawnAt === undefined ? {} : { withdrawnAt }),
    ...(row.withdraw_reason === null ? {} : { withdrawReason: row.withdraw_reason }),
  };
}

function member(row: Selectable<TournamentTeamMemberRow>): StoredTeamMember {
  const removedAt = iso(row.removed_at);
  return {
    id: row.id,
    activityId: row.activity_id,
    teamId: row.team_id,
    participantId: row.participant_id,
    role: row.role as StoredTeamMemberRole,
    addedAt: iso(row.added_at) ?? new Date().toISOString(),
    ...(removedAt === undefined ? {} : { removedAt }),
  };
}

export async function listTeams(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredTeam[]> {
  const rows = await db
    .selectFrom("tournament_team")
    .selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("team_key", "asc")
    .execute();
  return rows.map(team);
}

export async function listTeamsForUpdate(
  trx: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredTeam[]> {
  const rows = await trx
    .selectFrom("tournament_team")
    .selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("id", "asc")
    .forUpdate()
    .execute();
  return rows.map(team);
}

export async function getTeam(
  db: Kysely<Database>,
  id: string,
): Promise<StoredTeam | null> {
  const row = await db.selectFrom("tournament_team").selectAll()
    .where("id", "=", id).executeTakeFirst();
  return row === undefined ? null : team(row);
}

export async function getTeamForUpdate(
  trx: Kysely<Database>,
  id: string,
): Promise<StoredTeam | null> {
  const row = await trx.selectFrom("tournament_team").selectAll()
    .where("id", "=", id).forUpdate().executeTakeFirst();
  return row === undefined ? null : team(row);
}

export interface NewTeam {
  readonly id: string;
  readonly activityId: string;
  readonly teamKey: string;
  readonly name: string;
  readonly source: StoredTeamSource;
  readonly sourceGroupingStageId?: string;
  readonly sourceRevision?: number;
  readonly createdBy: string;
  readonly now: string;
}

export async function insertTeam(trx: Kysely<Database>, input: NewTeam): Promise<void> {
  await trx.insertInto("tournament_team").values({
    id: input.id,
    activity_id: input.activityId,
    team_key: input.teamKey,
    name: input.name,
    status: "draft",
    source: input.source,
    source_grouping_stage_id: input.sourceGroupingStageId ?? null,
    source_revision: input.sourceRevision ?? null,
    revision: 0,
    created_by: input.createdBy,
    created_at: new Date(input.now),
    updated_at: input.now,
    withdrawn_at: null,
    withdraw_reason: null,
  }).execute();
}

export async function updateTeamName(
  trx: Kysely<Database>,
  id: string,
  expectedRevision: number,
  name: string,
  now: string,
): Promise<boolean> {
  const result = await trx.updateTable("tournament_team")
    .set({ name, revision: expectedRevision + 1, updated_at: new Date(now) })
    .where("id", "=", id)
    .where("revision", "=", expectedRevision)
    .where("status", "=", "draft")
    .returning("id")
    .executeTakeFirst();
  return result !== undefined;
}

export async function freezeTeam(
  trx: Kysely<Database>,
  id: string,
  expectedRevision: number,
  name: string,
  now: string,
): Promise<boolean> {
  const result = await trx.updateTable("tournament_team")
    .set({ name, status: "frozen", revision: expectedRevision + 1, updated_at: new Date(now) })
    .where("id", "=", id)
    .where("revision", "=", expectedRevision)
    .where("status", "=", "draft")
    .returning("id")
    .executeTakeFirst();
  return result !== undefined;
}

export async function correctTeam(
  trx: Kysely<Database>,
  id: string,
  expectedRevision: number,
  name: string,
  now: string,
): Promise<boolean> {
  const result = await trx.updateTable("tournament_team")
    .set({ name, status: "frozen", revision: expectedRevision + 1, updated_at: new Date(now) })
    .where("id", "=", id)
    .where("revision", "=", expectedRevision)
    .where("status", "=", "frozen")
    .returning("id")
    .executeTakeFirst();
  return result !== undefined;
}

export async function bumpTeamRevision(
  trx: Kysely<Database>,
  id: string,
  expectedRevision: number,
  now: string,
): Promise<boolean> {
  const result = await trx.updateTable("tournament_team")
    .set({ revision: expectedRevision + 1, updated_at: new Date(now) })
    .where("id", "=", id)
    .where("revision", "=", expectedRevision)
    .where("status", "=", "draft")
    .returning("id")
    .executeTakeFirst();
  return result !== undefined;
}

export async function withdrawTeam(
  trx: Kysely<Database>,
  id: string,
  expectedRevision: number,
  now: string,
  reason: string,
): Promise<boolean> {
  const result = await trx.updateTable("tournament_team")
    .set({
      status: "withdrawn",
      withdrawn_at: new Date(now),
      withdraw_reason: reason,
      revision: expectedRevision + 1,
      updated_at: new Date(now),
    })
    .where("id", "=", id)
    .where("revision", "=", expectedRevision)
    .where("status", "in", ["draft", "frozen"])
    .returning("id")
    .executeTakeFirst();
  return result !== undefined;
}

export async function listActiveMembers(
  db: Kysely<Database>,
  teamIds: readonly string[],
): Promise<readonly StoredTeamMember[]> {
  if (teamIds.length === 0) return [];
  const rows = await db.selectFrom("tournament_team_member").selectAll()
    .where("team_id", "in", [...teamIds])
    .where("removed_at", "is", null)
    .orderBy("team_id", "asc")
    .orderBy("added_at", "asc")
    .execute();
  return rows.map(member);
}

export interface NewTeamMember {
  readonly id: string;
  readonly activityId: string;
  readonly teamId: string;
  readonly participantId: string;
  readonly role: StoredTeamMemberRole;
  readonly now: string;
}

export async function insertTeamMember(
  trx: Kysely<Database>,
  input: NewTeamMember,
): Promise<void> {
  await trx.insertInto("tournament_team_member").values({
    id: input.id,
    activity_id: input.activityId,
    team_id: input.teamId,
    participant_id: input.participantId,
    role: input.role,
    added_at: new Date(input.now),
    removed_at: null,
  }).execute();
}

export async function removeTeamMember(
  trx: Kysely<Database>,
  teamId: string,
  participantId: string,
  now: string,
): Promise<boolean> {
  const result = await trx.updateTable("tournament_team_member")
    .set({ removed_at: new Date(now) })
    .where("team_id", "=", teamId)
    .where("participant_id", "=", participantId)
    .where("removed_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  return result !== undefined;
}

export async function closeTeamMembers(
  trx: Kysely<Database>,
  teamId: string,
  now: string,
): Promise<void> {
  await trx.updateTable("tournament_team_member")
    .set({ removed_at: new Date(now) })
    .where("team_id", "=", teamId)
    .where("removed_at", "is", null)
    .execute();
}

/** A participant may hold at most one active membership in a non-withdrawn team. */
export async function findActiveMembership(
  trx: Kysely<Database>,
  activityId: string,
  participantId: string,
): Promise<StoredTeamMember | null> {
  const row = await trx.selectFrom("tournament_team_member as member")
    .innerJoin("tournament_team as team", "team.id", "member.team_id")
    .selectAll("member")
    .where("member.activity_id", "=", activityId)
    .where("member.participant_id", "=", participantId)
    .where("member.removed_at", "is", null)
    .where("team.status", "!=", "withdrawn")
    .executeTakeFirst();
  return row === undefined ? null : member(row);
}
