import type { Kysely, Selectable } from "kysely";

import type {
  Database,
  ParticipantClaimRow,
  ParticipantIdentityLinkRow,
} from "./types.js";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

export interface StoredParticipantClaim {
  readonly id: string;
  readonly activityId: string;
  readonly registrationId: string;
  readonly legacyParticipantId: string;
  readonly tokenDigest: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly consumedAt: string | null;
  readonly consumedByActorId: string | null;
  readonly issuedBy: string;
  readonly createdAt: string;
}

export type NewParticipantClaim = Omit<StoredParticipantClaim, "createdAt" | "revokedAt"> & {
  readonly revokedAt?: string | null;
};

function participantClaim(row: Selectable<ParticipantClaimRow>): StoredParticipantClaim {
  return {
    id: row.id,
    activityId: row.activity_id,
    registrationId: row.registration_id,
    legacyParticipantId: row.legacy_participant_id,
    tokenDigest: row.token_digest,
    expiresAt: iso(row.expires_at),
    revokedAt: nullableIso(row.revoked_at),
    consumedAt: nullableIso(row.consumed_at),
    consumedByActorId: row.consumed_by_actor_id,
    issuedBy: row.issued_by,
    createdAt: iso(row.created_at),
  };
}

export async function insertParticipantClaim(
  trx: Kysely<Database>,
  value: NewParticipantClaim,
): Promise<void> {
  await trx.insertInto("participant_claim").values({
    id: value.id,
    activity_id: value.activityId,
    registration_id: value.registrationId,
    legacy_participant_id: value.legacyParticipantId,
    token_digest: value.tokenDigest,
    expires_at: value.expiresAt,
    revoked_at: value.revokedAt ?? null,
    consumed_at: value.consumedAt,
    consumed_by_actor_id: value.consumedByActorId,
    issued_by: value.issuedBy,
  }).execute();
}

export async function revokeUnconsumedParticipantClaims(
  trx: Kysely<Database>,
  input: { readonly registrationId: string; readonly revokedAt: string },
): Promise<void> {
  await trx.updateTable("participant_claim")
    .set({ revoked_at: input.revokedAt })
    .where("registration_id", "=", input.registrationId)
    .where("consumed_at", "is", null)
    .where("revoked_at", "is", null)
    .execute();
}

export async function getParticipantClaimByDigestForUpdate(
  trx: Kysely<Database>,
  digest: string,
): Promise<StoredParticipantClaim | null> {
  const row = await trx.selectFrom("participant_claim")
    .selectAll()
    .where("token_digest", "=", digest)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : participantClaim(row);
}

export async function getParticipantClaimByDigest(
  db: Kysely<Database>,
  digest: string,
): Promise<StoredParticipantClaim | null> {
  const row = await db.selectFrom("participant_claim")
    .selectAll()
    .where("token_digest", "=", digest)
    .executeTakeFirst();
  return row === undefined ? null : participantClaim(row);
}

export async function markParticipantClaimConsumed(
  trx: Kysely<Database>,
  id: string,
  consumedAt: string,
  actorId: string,
): Promise<void> {
  await trx.updateTable("participant_claim")
    .set({ consumed_at: consumedAt, consumed_by_actor_id: actorId })
    .where("id", "=", id)
    .execute();
}

export interface StoredParticipantIdentityLink {
  readonly legacyParticipantId: string;
  readonly actorId: string;
  readonly linkedAt: string;
  readonly linkedBy: string;
  readonly claimId: string;
}

export type NewParticipantIdentityLink = Omit<StoredParticipantIdentityLink, "linkedAt">;

function participantIdentityLink(
  row: Selectable<ParticipantIdentityLinkRow>,
): StoredParticipantIdentityLink {
  return {
    legacyParticipantId: row.legacy_participant_id,
    actorId: row.actor_id,
    linkedAt: iso(row.linked_at),
    linkedBy: row.linked_by,
    claimId: row.claim_id,
  };
}

export async function getParticipantIdentityLinkByLegacy(
  db: Kysely<Database>,
  legacyParticipantId: string,
): Promise<StoredParticipantIdentityLink | null> {
  const row = await db.selectFrom("participant_identity_link")
    .selectAll()
    .where("legacy_participant_id", "=", legacyParticipantId)
    .executeTakeFirst();
  return row === undefined ? null : participantIdentityLink(row);
}

export async function getParticipantIdentityLinkByLegacyForUpdate(
  trx: Kysely<Database>,
  legacyParticipantId: string,
): Promise<StoredParticipantIdentityLink | null> {
  const row = await trx.selectFrom("participant_identity_link")
    .selectAll()
    .where("legacy_participant_id", "=", legacyParticipantId)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : participantIdentityLink(row);
}

export async function getParticipantIdentityLinkByActor(
  db: Kysely<Database>,
  actorId: string,
): Promise<StoredParticipantIdentityLink | null> {
  const row = await db.selectFrom("participant_identity_link")
    .selectAll()
    .where("actor_id", "=", actorId)
    .executeTakeFirst();
  return row === undefined ? null : participantIdentityLink(row);
}

export async function insertParticipantIdentityLink(
  trx: Kysely<Database>,
  value: NewParticipantIdentityLink,
): Promise<void> {
  await trx.insertInto("participant_identity_link").values({
    legacy_participant_id: value.legacyParticipantId,
    actor_id: value.actorId,
    linked_at: new Date(),
    linked_by: value.linkedBy,
    claim_id: value.claimId,
  }).execute();
}
