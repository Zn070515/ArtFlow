import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeDb,
  createDb,
  insertMaterial,
  insertParticipantClaim,
  insertParticipantIdentityLink,
  insertRegistration,
  insertRelease,
  migrate,
} from "@artflow-plus/db";
import type { Database, StoredMaterial } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  attachMaterialContent,
  createLocalMaterialStorage,
  readMaterialForActor,
  uploadMaterial,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_participant_material_auth_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let materialRoot = "";

const linkedActor: ActorContext = {
  actorId: `participant:${randomUUID()}`,
  actorType: "user",
  roles: ["participant"],
  permissions: [],
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
  materialStorage: createLocalMaterialStorage({ root: materialRoot }),
});

describe.skipIf(!connectionString)("linked participant material authorization on PostgreSQL", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    materialRoot = await mkdtemp(join(tmpdir(), "artflow-participant-material-auth-"));
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("authorizes linked actors for metadata, imported content, and reads", async () => {
    const activityId = `act-${randomUUID()}`;
    const registrationId = `reg-${randomUUID()}`;
    const legacyParticipantId = `legacy-user:${randomUUID()}`;
    const claimId = `claim-${randomUUID()}`;
    await db.insertInto("activity").values({
      id: activityId,
      public_code: "LINKED-MATERIAL",
      title: "Linked material authorization",
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
            questions: [{
              key: "audio",
              label: "音频",
              type: "file",
              required: true,
              file: { slot: "audio", purpose: "audio", accepts: [".mp3"], maxBytes: 1000 },
            }],
            fileSlots: [{ key: "audio", slot: "audio", purpose: "audio", accepts: [".mp3"], maxBytes: 1000 }],
          },
        },
        materials: {
          ok: true,
          capabilityKey: "materials",
          contentHash: "materials-hash",
          artifact: { schemaVersion: 1, maxBytes: 1000, allowedPurposes: ["audio"] },
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
      status: "draft",
      answers: {},
      revision: 0,
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
      issuedBy: "staff-material",
    });
    await insertParticipantIdentityLink(db, {
      legacyParticipantId,
      actorId: linkedActor.actorId,
      linkedBy: "staff-material",
      claimId,
    });

    const uploaded = await uploadMaterial(db, deps(linkedActor), {
      commandId: `linked-material-upload-${randomUUID()}`,
      activityId,
      registrationId,
      questionKey: "audio",
      originalName: "linked.mp3",
      contentType: "audio/mpeg",
      byteLength: 3,
    });
    await attachMaterialContent(db, deps(linkedActor), {
      commandId: `linked-material-content-${randomUUID()}`,
      activityId,
      materialId: uploaded.body.id,
      bytes: new Uint8Array([1, 2, 3]),
    });
    await expect(uploadMaterial(db, deps(outsider), {
      commandId: `outsider-material-upload-${randomUUID()}`,
      activityId,
      registrationId,
      questionKey: "audio",
      originalName: "outsider.mp3",
      contentType: "audio/mpeg",
      byteLength: 3,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const importedMaterial: StoredMaterial = {
      id: `material-imported-${randomUUID()}`,
      activityId,
      registrationId,
      questionKey: "audio",
      storageKey: `private/imported/${randomUUID()}`,
      originalName: "imported.mp3",
      contentType: "audio/mpeg",
      byteLength: 3,
      ownerActorId: legacyParticipantId,
      status: "uploaded",
      reviewNote: "",
      reviewedBy: null,
      reviewedAt: null,
      revision: 0,
      current: false,
      contentReady: false,
    };
    await insertMaterial(db, importedMaterial);
    await attachMaterialContent(db, deps(linkedActor), {
      commandId: `linked-imported-content-${randomUUID()}`,
      activityId,
      materialId: importedMaterial.id,
      bytes: new Uint8Array([4, 5, 6]),
    });
    await expect(readMaterialForActor(db, {
      activityId,
      materialId: importedMaterial.id,
      actor: linkedActor,
    })).resolves.toMatchObject({ id: importedMaterial.id, ownerActorId: legacyParticipantId });
    await expect(readMaterialForActor(db, {
      activityId,
      materialId: importedMaterial.id,
      actor: outsider,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
