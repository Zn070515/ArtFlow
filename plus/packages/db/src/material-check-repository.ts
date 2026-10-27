import { sql, type Kysely, type Selectable } from "kysely";

import type { Database, MaterialCheckRow, SupplementGrantRow } from "./types.js";

export type MaterialCheckStatus = "missing" | "uploaded" | "approved" | "needs_supplement";

export interface StoredMaterialCheck {
  readonly id: string;
  readonly activityId: string;
  readonly registrationId: string;
  readonly slotKey: string;
  readonly itemName: string;
  readonly purpose: string;
  readonly acceptedPurposes: readonly string[];
  readonly status: MaterialCheckStatus;
  readonly required: boolean;
  readonly reviewNote: string;
  readonly revision: number;
}

function jsonArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") return JSON.parse(value) as string[];
  return [];
}

function check(row: Selectable<MaterialCheckRow>): StoredMaterialCheck {
  return {
    id: row.id,
    activityId: row.activity_id,
    registrationId: row.registration_id,
    slotKey: row.slot_key,
    itemName: row.item_name,
    purpose: row.purpose,
    acceptedPurposes: jsonArray(row.accepted_purposes),
    status: row.status as MaterialCheckStatus,
    required: row.required,
    reviewNote: row.review_note,
    revision: row.revision,
  };
}

export async function insertMaterialCheck(
  trx: Kysely<Database>,
  value: StoredMaterialCheck,
): Promise<void> {
  await trx.insertInto("material_check").values({
    id: value.id,
    activity_id: value.activityId,
    registration_id: value.registrationId,
    slot_key: value.slotKey,
    item_name: value.itemName,
    purpose: value.purpose,
    accepted_purposes: JSON.stringify(value.acceptedPurposes),
    status: value.status,
    required: value.required,
    review_note: value.reviewNote,
    revision: value.revision,
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
}

export async function listMaterialChecks(
  db: Kysely<Database>,
  registrationId: string,
): Promise<readonly StoredMaterialCheck[]> {
  const rows = await db.selectFrom("material_check").selectAll()
    .where("registration_id", "=", registrationId)
    .orderBy("slot_key")
    .execute();
  return rows.map(check);
}

export async function updateMaterialCheckStatus(
  trx: Kysely<Database>,
  registrationId: string,
  slotKey: string,
  status: MaterialCheckStatus,
  reviewNote?: string,
): Promise<void> {
  await trx.updateTable("material_check")
    .set({
      status,
      ...(reviewNote === undefined ? {} : { review_note: reviewNote }),
      revision: sql`revision + 1`,
      updated_at: new Date(),
    })
    .where("registration_id", "=", registrationId)
    .where("slot_key", "=", slotKey)
    .execute();
}

export interface StoredSupplementGrant {
  readonly id: string;
  readonly activityId: string;
  readonly registrationId: string;
  readonly tokenDigest: string;
  readonly allowedKeys: readonly string[];
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly createdBy: string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function grant(row: Selectable<SupplementGrantRow>): StoredSupplementGrant {
  return {
    id: row.id,
    activityId: row.activity_id,
    registrationId: row.registration_id,
    tokenDigest: row.token_digest,
    allowedKeys: jsonArray(row.allowed_keys),
    expiresAt: iso(row.expires_at) ?? "",
    revokedAt: iso(row.revoked_at),
    createdBy: row.created_by,
  };
}

export async function insertSupplementGrant(
  trx: Kysely<Database>,
  value: StoredSupplementGrant,
): Promise<void> {
  await trx.insertInto("supplement_grant").values({
    id: value.id,
    activity_id: value.activityId,
    registration_id: value.registrationId,
    token_digest: value.tokenDigest,
    allowed_keys: JSON.stringify(value.allowedKeys),
    expires_at: value.expiresAt,
    revoked_at: value.revokedAt,
    created_by: value.createdBy,
  }).execute();
}

export async function findSupplementGrantByDigest(
  db: Kysely<Database>,
  digest: string,
): Promise<StoredSupplementGrant | null> {
  const row = await db.selectFrom("supplement_grant").selectAll()
    .where("token_digest", "=", digest)
    .executeTakeFirst();
  return row === undefined ? null : grant(row);
}

export async function revokeSupplementGrant(
  trx: Kysely<Database>,
  id: string,
  revokedAt: string,
): Promise<void> {
  await trx.updateTable("supplement_grant")
    .set({ revoked_at: revokedAt })
    .where("id", "=", id)
    .execute();
}
