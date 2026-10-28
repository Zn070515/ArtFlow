import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertParticipantClaim,
  insertParticipantIdentityLink,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  canActForParticipant,
  participantSubjectIds,
  requireParticipantOwnership,
} from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_participant_identity_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const participant: ActorContext = {
  actorId: `participant:${randomUUID()}`,
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};
const staff: ActorContext = {
  actorId: `staff:${randomUUID()}`,
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.manage"],
};

describe.skipIf(!connectionString)("participant identity resolution on PostgreSQL", () => {
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

  it("returns the local and linked legacy participant subjects", async () => {
    const activityId = `act-${randomUUID()}`;
    const registrationId = `reg-${randomUUID()}`;
    const claimId = `claim-${randomUUID()}`;
    const legacyParticipantId = `legacy-user:${randomUUID()}`;
    await db.insertInto("activity").values({
      id: activityId,
      title: "Participant identity test",
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
      answers: JSON.stringify({}),
      supplement_keys: JSON.stringify([]),
      revision: 1,
      review_note: "",
      reviewed_by: null,
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
    await insertParticipantClaim(db, {
      id: claimId,
      activityId,
      registrationId,
      legacyParticipantId,
      tokenDigest: `digest-${randomUUID()}`,
      expiresAt: "2026-11-01T00:00:00.000Z",
      consumedAt: null,
      consumedByActorId: null,
      issuedBy: staff.actorId,
    });
    await insertParticipantIdentityLink(db, {
      legacyParticipantId,
      actorId: participant.actorId,
      linkedBy: staff.actorId,
      claimId,
    });

    await expect(participantSubjectIds(db, participant)).resolves.toEqual([
      participant.actorId,
      legacyParticipantId,
    ]);
    await expect(participantSubjectIds(db, {
      ...participant,
      actorId: `participant:${randomUUID()}`,
    })).resolves.toHaveLength(1);
  });

  it("authorizes linked ownership and keeps staff permission short-circuiting", async () => {
    const legacyParticipantId = `legacy-user:${randomUUID()}`;
    const unrelatedParticipantId = `participant:${randomUUID()}`;
    const linkedParticipant: ActorContext = {
      ...participant,
      actorId: `participant:${randomUUID()}`,
    };
    const activityId = `act-${randomUUID()}`;
    const registrationId = `reg-${randomUUID()}`;
    const claimId = `claim-${randomUUID()}`;
    await db.insertInto("activity").values({
      id: activityId,
      title: "Participant identity authorization test",
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
      answers: JSON.stringify({}),
      supplement_keys: JSON.stringify([]),
      revision: 1,
      review_note: "",
      reviewed_by: null,
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
    await insertParticipantClaim(db, {
      id: claimId,
      activityId,
      registrationId,
      legacyParticipantId,
      tokenDigest: `digest-${randomUUID()}`,
      expiresAt: "2026-11-01T00:00:00.000Z",
      consumedAt: null,
      consumedByActorId: null,
      issuedBy: staff.actorId,
    });
    await insertParticipantIdentityLink(db, {
      legacyParticipantId,
      actorId: linkedParticipant.actorId,
      linkedBy: staff.actorId,
      claimId,
    });

    await expect(canActForParticipant(db, linkedParticipant, legacyParticipantId, "registration.manage"))
      .resolves.toBe(true);
    await expect(canActForParticipant(db, {
      ...participant,
      actorId: unrelatedParticipantId,
    }, legacyParticipantId, "registration.manage")).resolves.toBe(false);
    await expect(canActForParticipant(db, staff, legacyParticipantId, "registration.manage"))
      .resolves.toBe(true);
    await expect(requireParticipantOwnership(
      db,
      { ...participant, actorId: unrelatedParticipantId },
      legacyParticipantId,
      "registration.manage",
      "The actor cannot act for this participant.",
    )).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
