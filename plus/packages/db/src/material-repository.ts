import type { Kysely, Selectable } from "kysely";

import type { Database, MaterialRow } from "./types.js";

export type MaterialStatus = "uploaded" | "approved" | "needs_supplement";

export interface StoredMaterial {
  readonly id: string;
  readonly activityId: string;
  readonly registrationId: string;
  readonly questionKey: string;
  readonly storageKey: string;
  readonly originalName: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly ownerActorId: string;
  readonly status: MaterialStatus;
  readonly reviewNote: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly revision: number;
  readonly current: boolean;
  readonly contentReady?: boolean;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function material(row: Selectable<MaterialRow>): StoredMaterial {
  return {
    id: row.id,
    activityId: row.activity_id,
    registrationId: row.registration_id,
    questionKey: row.question_key,
    storageKey: row.storage_key,
    originalName: row.original_name,
    contentType: row.content_type,
    byteLength: row.byte_length,
    ownerActorId: row.owner_actor_id,
    status: row.status as MaterialStatus,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: iso(row.reviewed_at),
    revision: row.revision,
    current: row.current,
    contentReady: row.content_ready,
  };
}

export async function insertMaterial(db: Kysely<Database>, value: StoredMaterial): Promise<void> {
  await db.insertInto("material").values({
    id: value.id,
    activity_id: value.activityId,
    registration_id: value.registrationId,
    question_key: value.questionKey,
    storage_key: value.storageKey,
    original_name: value.originalName,
    content_type: value.contentType,
    byte_length: value.byteLength,
    owner_actor_id: value.ownerActorId,
    status: value.status,
    review_note: value.reviewNote,
    reviewed_by: value.reviewedBy,
    reviewed_at: value.reviewedAt,
    revision: value.revision,
    current: value.current,
    content_ready: value.contentReady ?? true,
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
}

export async function retireCurrentMaterial(
  trx: Kysely<Database>,
  registrationId: string,
  questionKey: string,
): Promise<void> {
  await trx
    .updateTable("material")
    .set({ current: false, updated_at: new Date() })
    .where("registration_id", "=", registrationId)
    .where("question_key", "=", questionKey)
    .where("current", "=", true)
    .execute();
}

export async function getMaterial(
  db: Kysely<Database>,
  id: string,
): Promise<StoredMaterial | null> {
  const row = await db.selectFrom("material").selectAll().where("id", "=", id).where("current", "=", true).executeTakeFirst();
  return row === undefined ? null : material(row);
}

export async function getMaterialForUpdate(
  trx: Kysely<Database>,
  id: string,
): Promise<StoredMaterial | null> {
  const row = await trx.selectFrom("material").selectAll().where("id", "=", id).where("current", "=", true).forUpdate().executeTakeFirst();
  return row === undefined ? null : material(row);
}

/** Finds a pending (not yet current) material row by id for content attach. */
export async function getMaterialByIdForUpdate(
  trx: Kysely<Database>,
  id: string,
): Promise<StoredMaterial | null> {
  const row = await trx.selectFrom("material").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
  return row === undefined ? null : material(row);
}

export async function activateMaterialContent(
  trx: Kysely<Database>,
  value: StoredMaterial,
  expectedRevision: number,
): Promise<StoredMaterial> {
  const row = await trx.updateTable("material").set({
    current: true,
    content_ready: true,
    revision: value.revision + 1,
    updated_at: new Date(),
  }).where("id", "=", value.id).where("revision", "=", expectedRevision).returningAll().executeTakeFirst();
  if (row === undefined) {
    const error = new Error(`Material ${value.id} changed since it was read.`);
    Object.assign(error, { code: "STALE_REVISION" });
    throw error;
  }
  return material(row);
}

export async function listMaterials(
  db: Kysely<Database>,
  registrationId: string,
): Promise<readonly StoredMaterial[]> {
  const rows = await db.selectFrom("material").selectAll().where("registration_id", "=", registrationId).where("current", "=", true).orderBy("question_key").execute();
  return rows.map(material);
}

export async function updateMaterialReview(
  trx: Kysely<Database>,
  value: StoredMaterial,
  expectedRevision: number,
): Promise<StoredMaterial> {
  const row = await trx.updateTable("material").set({
    status: value.status,
    review_note: value.reviewNote,
    reviewed_by: value.reviewedBy,
    reviewed_at: value.reviewedAt,
    revision: value.revision,
    updated_at: new Date(),
  }).where("id", "=", value.id).where("revision", "=", expectedRevision).returningAll().executeTakeFirst();
  if (row === undefined) {
    const error = new Error(`Material ${value.id} changed since it was read.`);
    Object.assign(error, { code: "STALE_REVISION" });
    throw error;
  }
  return material(row);
}
