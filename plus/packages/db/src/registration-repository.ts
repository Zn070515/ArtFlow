import type {
  RegistrationState,
  RegistrationStatus,
  RosterState,
} from "@artflow-plus/domain";
import { unknownRoster } from "@artflow-plus/domain";
import { sql, type Kysely, type Selectable } from "kysely";

import { StaleRevisionError } from "./activity-repository.js";
import type { Database, RegistrationRow, RosterRow } from "./types.js";

export type StoredRegistration = RegistrationState;
export type StoredRoster = RosterState;

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === "string") return JSON.parse(value) as Readonly<Record<string, unknown>>;
  return (value ?? {}) as Readonly<Record<string, unknown>>;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function registration(row: Selectable<RegistrationRow>): StoredRegistration {
  return {
    id: row.id,
    activityId: row.activity_id,
    participantId: row.participant_id,
    questionnaireVersion: row.questionnaire_version,
    questionnaireHash: row.questionnaire_hash,
    status: row.status as RegistrationStatus,
    answers: objectValue(row.answers),
    revision: row.revision,
    ...(row.review_note === null ? {} : { reviewNote: row.review_note }),
    ...(row.reviewed_by === null ? {} : { reviewedBy: row.reviewed_by }),
  };
}

function roster(row: Selectable<RosterRow>): StoredRoster {
  if (row.status === "unknown") return unknownRoster(row.revision);
  return {
    status: "final",
    revision: row.revision,
    approvedCount: row.approved_count ?? 0,
    finalizedAt: iso(row.finalized_at) ?? "",
  };
}

export async function insertRegistration(
  db: Kysely<Database>,
  value: StoredRegistration,
): Promise<void> {
  await db
    .insertInto("registration")
    .values({
      id: value.id,
      activity_id: value.activityId,
      participant_id: value.participantId,
      questionnaire_version: value.questionnaireVersion,
      questionnaire_hash: value.questionnaireHash,
      status: value.status,
      answers: JSON.stringify(value.answers),
      revision: value.revision,
      review_note: value.reviewNote ?? "",
      reviewed_by: value.reviewedBy ?? null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
}

export async function getRegistration(
  db: Kysely<Database>,
  id: string,
): Promise<StoredRegistration | null> {
  const row = await db.selectFrom("registration").selectAll().where("id", "=", id).executeTakeFirst();
  return row === undefined ? null : registration(row);
}

export async function getRegistrationForUpdate(
  trx: Kysely<Database>,
  id: string,
): Promise<StoredRegistration | null> {
  const row = await trx.selectFrom("registration").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
  return row === undefined ? null : registration(row);
}

export async function getRegistrationByParticipant(
  db: Kysely<Database>,
  activityId: string,
  participantId: string,
): Promise<StoredRegistration | null> {
  const row = await db
    .selectFrom("registration")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("participant_id", "=", participantId)
    .executeTakeFirst();
  return row === undefined ? null : registration(row);
}

export async function getRegistrationByParticipantForUpdate(
  trx: Kysely<Database>,
  activityId: string,
  participantId: string,
): Promise<StoredRegistration | null> {
  const row = await trx
    .selectFrom("registration")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("participant_id", "=", participantId)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : registration(row);
}

export async function updateRegistration(
  trx: Kysely<Database>,
  value: StoredRegistration,
  expectedRevision: number,
): Promise<StoredRegistration> {
  const row = await trx
    .updateTable("registration")
    .set({
      status: value.status,
      answers: JSON.stringify(value.answers),
      revision: value.revision,
      review_note: value.reviewNote ?? "",
      reviewed_by: value.reviewedBy ?? null,
      updated_at: new Date(),
    })
    .where("id", "=", value.id)
    .where("revision", "=", expectedRevision)
    .returningAll()
    .executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(value.id);
  return registration(row);
}

export async function listRegistrations(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredRegistration[]> {
  const rows = await db.selectFrom("registration").selectAll().where("activity_id", "=", activityId).orderBy("id").execute();
  return rows.map(registration);
}

export async function listApprovedRegistrationCount(
  db: Kysely<Database>,
  activityId: string,
): Promise<number> {
  const result = await sql<{ count: number }>`
    select count(*)::int as count from registration
     where activity_id = ${activityId} and status = 'approved'
  `.execute(db);
  return result.rows[0]?.count ?? 0;
}

export async function listApprovedParticipantIds(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly string[]> {
  const rows = await db.selectFrom("registration").select("participant_id")
    .where("activity_id", "=", activityId).where("status", "=", "approved")
    .orderBy("participant_id").execute();
  return rows.map((row) => row.participant_id);
}

export async function getRoster(
  db: Kysely<Database>,
  activityId: string,
): Promise<StoredRoster> {
  const row = await db.selectFrom("roster").selectAll().where("activity_id", "=", activityId).executeTakeFirst();
  return row === undefined ? unknownRoster() : roster(row);
}

export async function getRosterForUpdate(
  trx: Kysely<Database>,
  activityId: string,
): Promise<StoredRoster> {
  const row = await trx.selectFrom("roster").selectAll().where("activity_id", "=", activityId).forUpdate().executeTakeFirst();
  return row === undefined ? unknownRoster() : roster(row);
}

export async function upsertRoster(
  trx: Kysely<Database>,
  activityId: string,
  value: StoredRoster,
  expectedRevision: number,
): Promise<StoredRoster> {
  const current = await getRosterForUpdate(trx, activityId);
  if (current.revision !== expectedRevision) throw new StaleRevisionError(activityId);
  if (current.status === "unknown" && value.status === "unknown" && current.revision === 0) {
    await trx.insertInto("roster").values({
      activity_id: activityId,
      status: "unknown",
      approved_count: null,
      revision: value.revision,
      finalized_at: null,
      updated_at: new Date(),
    }).onConflict((conflict) => conflict.column("activity_id").doNothing()).execute();
    return value;
  }
  const row = await trx.updateTable("roster").set({
    status: value.status,
    approved_count: value.status === "final" ? value.approvedCount : null,
    revision: value.revision,
    finalized_at: value.status === "final" ? value.finalizedAt : null,
    updated_at: new Date(),
  }).where("activity_id", "=", activityId).where("revision", "=", expectedRevision).returningAll().executeTakeFirst();
  if (row === undefined) {
    if (current.status === "unknown" && value.status === "final" && expectedRevision === 0) {
      const inserted = await trx.insertInto("roster").values({
        activity_id: activityId,
        status: "final",
        approved_count: value.approvedCount,
        revision: value.revision,
        finalized_at: value.finalizedAt,
        updated_at: new Date(),
      }).returningAll().executeTakeFirstOrThrow();
      return roster(inserted);
    }
    throw new StaleRevisionError(activityId);
  }
  return roster(row);
}
