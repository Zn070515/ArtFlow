import { randomUUID } from "node:crypto";

import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  getParticipantClaimByDigestForUpdate,
  getParticipantIdentityLinkByActor,
  getParticipantIdentityLinkByLegacy,
  insertParticipantClaim,
  insertParticipantIdentityLink,
  migrate,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_participant_account_repo_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

async function seedActivityAndRegistration(): Promise<{
  readonly activityId: string;
  readonly registrationId: string;
  readonly legacyParticipantId: string;
}> {
  const activityId = `act-${randomUUID()}`;
  const registrationId = `reg-${randomUUID()}`;
  const legacyParticipantId = `legacy-user:${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    title: "Participant account claim repository test",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration"]),
    active_definition_version: 1,
  }).execute();
  await db.insertInto("registration").values({
    id: registrationId,
    activity_id: activityId,
    participant_id: legacyParticipantId,
    questionnaire_version: "v1",
    questionnaire_hash: "qhash",
    status: "submitted",
    answers: JSON.stringify({ name: "Legacy participant" }),
    supplement_keys: JSON.stringify([]),
    revision: 1,
    review_note: "",
    reviewed_by: null,
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
  return { activityId, registrationId, legacyParticipantId };
}

describe.skipIf(!connectionString)("participant account repositories on PostgreSQL", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("maps a digest-only claim and identity link through the repositories", async () => {
    const { activityId, registrationId, legacyParticipantId } = await seedActivityAndRegistration();
    const claimId = `claim-${randomUUID()}`;
    await insertParticipantClaim(db, {
      id: claimId,
      activityId,
      registrationId,
      legacyParticipantId,
      tokenDigest: "digest-1",
      expiresAt: "2026-11-01T00:00:00.000Z",
      consumedAt: null,
      consumedByActorId: null,
      issuedBy: "staff:1",
    });

    const claim = await getParticipantClaimByDigestForUpdate(db, "digest-1");
    expect(claim).toMatchObject({
      id: claimId,
      activityId,
      registrationId,
      legacyParticipantId,
      tokenDigest: "digest-1",
      expiresAt: "2026-11-01T00:00:00.000Z",
      consumedAt: null,
      consumedByActorId: null,
      issuedBy: "staff:1",
    });
    expect(claim?.createdAt).toEqual(expect.any(String));

    const actorId = `participant:${randomUUID()}`;
    await insertParticipantIdentityLink(db, {
      legacyParticipantId,
      actorId,
      linkedBy: "staff:1",
      claimId,
    });

    await expect(getParticipantIdentityLinkByLegacy(db, legacyParticipantId)).resolves.toMatchObject({
      legacyParticipantId,
      actorId,
      linkedBy: "staff:1",
      claimId,
      linkedAt: expect.any(String),
    });
    await expect(getParticipantIdentityLinkByActor(db, actorId)).resolves.toMatchObject({
      legacyParticipantId,
      actorId,
    });
  });

  it("rejects duplicate token digests and duplicate identity-link sides", async () => {
    const { activityId, registrationId, legacyParticipantId } = await seedActivityAndRegistration();
    const firstClaimId = `claim-${randomUUID()}`;
    const secondClaimId = `claim-${randomUUID()}`;
    const firstActorId = `participant:${randomUUID()}`;
    await insertParticipantClaim(db, {
      id: firstClaimId,
      activityId,
      registrationId,
      legacyParticipantId,
      tokenDigest: `digest-${randomUUID()}`,
      expiresAt: "2026-11-01T00:00:00.000Z",
      consumedAt: null,
      consumedByActorId: null,
      issuedBy: "staff:1",
    });
    const digest = `duplicate-${randomUUID()}`;
    await insertParticipantClaim(db, {
      id: secondClaimId,
      activityId,
      registrationId,
      legacyParticipantId,
      tokenDigest: digest,
      expiresAt: "2026-11-01T00:00:00.000Z",
      revokedAt: "2026-10-31T00:00:00.000Z",
      consumedAt: null,
      consumedByActorId: null,
      issuedBy: "staff:1",
    });
    await expect(insertParticipantClaim(db, {
      id: `claim-${randomUUID()}`,
      activityId,
      registrationId,
      legacyParticipantId,
      tokenDigest: digest,
      expiresAt: "2026-11-01T00:00:00.000Z",
      consumedAt: null,
      consumedByActorId: null,
      issuedBy: "staff:1",
    })).rejects.toThrow();

    await insertParticipantIdentityLink(db, {
      legacyParticipantId,
      actorId: firstActorId,
      linkedBy: "staff:1",
      claimId: firstClaimId,
    });
    await expect(insertParticipantIdentityLink(db, {
      legacyParticipantId,
      actorId: "participant:2",
      linkedBy: "staff:1",
      claimId: secondClaimId,
    })).rejects.toThrow();
    await expect(insertParticipantIdentityLink(db, {
      legacyParticipantId: `legacy-user:${randomUUID()}`,
      actorId: firstActorId,
      linkedBy: "staff:1",
      claimId: secondClaimId,
    })).rejects.toThrow();
  });
});
