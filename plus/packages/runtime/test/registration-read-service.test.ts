import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertParticipantClaim,
  insertParticipantIdentityLink,
  insertRegistration,
  insertRelease,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getMyRegistration,
  getRegistrationDetail,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_registration_read_runtime_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const linkedActor: ActorContext = {
  actorId: `participant:${randomUUID()}`,
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};
const staff: ActorContext = {
  actorId: `staff:${randomUUID()}`,
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.review"],
};
const outsider: ActorContext = {
  actorId: `participant:${randomUUID()}`,
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

const deps = (actor: ActorContext): RuntimeDeps => ({
  actor,
  now: () => "2026-11-01T00:00:00.000Z",
  newEventId: () => `evt-${randomUUID()}`,
});

describe.skipIf(!connectionString)("registration read authorization on PostgreSQL", () => {
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

  it("lets a linked actor read the imported registration while an outsider cannot", async () => {
    const activityId = `act-${randomUUID()}`;
    const registrationId = `reg-${randomUUID()}`;
    const legacyParticipantId = `legacy-user:${randomUUID()}`;
    const claimId = `claim-${randomUUID()}`;
    await db.insertInto("activity").values({
      id: activityId,
      public_code: "LINKED-READ",
      title: "Linked registration read",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["registration", "questionnaire", "materials"]),
      active_definition_version: 1,
    }).execute();
    await insertRelease(db, {
      activityId,
      version: 1,
      contentHash: "release-hash",
      capabilities: {
        questionnaire: {
          ok: true,
          capabilityKey: "questionnaire",
          contentHash: "questionnaire-hash",
          artifact: {
            schemaVersion: 1,
            version: "v1",
            schemaHash: "questionnaire-hash",
            questions: [{ key: "name", label: "姓名", type: "text", required: true }],
            fileSlots: [],
          },
        },
        materials: {
          ok: true,
          capabilityKey: "materials",
          contentHash: "materials-hash",
          artifact: { schemaVersion: 1, maxBytes: 1000, allowedPurposes: [] },
        },
      },
      executionPolicy: { declaredScopes: [], conflicts: {}, runtimeContractVersion: 2, commandScopes: {} },
      capabilityVersions: {},
      bindings: [],
      releasedAt: "2026-11-01T00:00:00.000Z",
      sourceDraftRevision: 1,
    });
    await insertRegistration(db, {
      id: registrationId,
      activityId,
      participantId: legacyParticipantId,
      questionnaireVersion: "v1",
      questionnaireHash: "questionnaire-hash",
      status: "submitted",
      answers: { name: "Imported" },
      revision: 1,
    });
    await insertParticipantClaim(db, {
      id: claimId,
      activityId,
      registrationId,
      legacyParticipantId,
      tokenDigest: `digest-${randomUUID()}`,
      expiresAt: "2026-11-02T00:00:00.000Z",
      consumedAt: null,
      consumedByActorId: null,
      issuedBy: staff.actorId,
    });
    await insertParticipantIdentityLink(db, {
      legacyParticipantId,
      actorId: linkedActor.actorId,
      linkedBy: staff.actorId,
      claimId,
    });

    await expect(getMyRegistration(db, deps(linkedActor), activityId)).resolves.toMatchObject({
      id: registrationId,
      participantId: legacyParticipantId,
    });
    await expect(getRegistrationDetail(db, deps(linkedActor), activityId, registrationId))
      .resolves.toMatchObject({
        registration: { id: registrationId, participantId: legacyParticipantId, answers: { name: "Imported" } },
      });
    await expect(getMyRegistration(db, deps(outsider), activityId)).resolves.toBeNull();
    await expect(getRegistrationDetail(db, deps(outsider), activityId, registrationId))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getRegistrationDetail(db, deps(staff), activityId, registrationId)).resolves.toBeDefined();
  });
});
