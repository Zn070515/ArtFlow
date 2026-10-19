import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertRelease,
  insertSession,
  migrate,
  readEventsSince,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import type { ActorContext, ExecutionSession } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  finalizeRoster,
  prepareCompetitionRound,
  reviewRegistration,
  saveRegistrationAnswer,
  startRegistration,
  submitRegistration,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_registration_runtime_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const participant: ActorContext = {
  actorId: "student-1",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};
const staff: ActorContext = {
  actorId: "staff-1",
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.review", "registration.roster.finalize", "materials.review", "materials.read"],
};

function deps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 9, 19, 10, 0, tick++)).toISOString(),
    newEventId: () => `evt-${randomUUID()}`,
  };
}

const questionnaireArtifact = {
  schemaVersion: 1,
  version: "v1",
  schemaHash: "questionnaire-hash",
  questions: [
    { key: "name", label: "姓名", type: "text", required: true },
    {
      key: "audio",
      label: "伴奏",
      type: "file",
      required: true,
      file: { slot: "audio", purpose: "accompaniment", accepts: [".mp3"] },
    },
  ],
  fileSlots: [
    { key: "audio", slot: "audio", purpose: "accompaniment", accepts: [".mp3"] },
  ],
};

async function seedActivity(id = `act-${randomUUID()}`): Promise<string> {
  await db.insertInto("activity").values({
    id,
    title: "M4 runtime",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "questionnaire", "materials", "competition"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId: id,
    version: 1,
    contentHash: "release-hash",
    capabilities: {
      registration: { ok: true, capabilityKey: "registration", contentHash: "registration-hash", artifact: { schemaVersion: 1, lifecycleVersion: 1, rosterStatus: "unknown" } },
      questionnaire: { ok: true, capabilityKey: "questionnaire", contentHash: "questionnaire-content-hash", artifact: questionnaireArtifact },
      materials: { ok: true, capabilityKey: "materials", contentHash: "materials-hash", artifact: { schemaVersion: 1, maxBytes: 25_000_000, allowedPurposes: ["accompaniment"] } },
    },
    executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { registration: "1", questionnaire: "1", materials: "1", competition: "1" },
    bindings: [],
    releasedAt: "2026-10-19T09:00:00Z",
    sourceDraftRevision: 1,
  });
  return id;
}

async function seedJudgingSession(activityId: string): Promise<void> {
  const session: ExecutionSession = {
    id: `session-${randomUUID()}`,
    activityId,
    definitionVersion: 1,
    contentHash: "release-hash",
    scope: "judging",
    mode: "formal",
    status: "running",
    revision: 0,
  };
  await insertSession(db, session, "2026-10-19T09:30:00Z");
}

describe.skipIf(!connectionString)("registration commands on PostgreSQL", () => {
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

  it("starts from the released questionnaire snapshot and rejects an unknown question", async () => {
    const activityId = await seedActivity();
    const started = await startRegistration(db, deps(participant), {
      commandId: "start-registration-1",
      activityId,
      participantId: participant.actorId,
    });
    expect(started.body).toMatchObject({
      participantId: participant.actorId,
      questionnaireVersion: "v1",
      questionnaireHash: "questionnaire-hash",
      status: "draft",
    });
    const before = await readEventsSince(db, { activityId, after: 0, limit: 100 });
    await expect(saveRegistrationAnswer(db, deps(participant), {
      commandId: "answer-registration-unknown",
      activityId,
      registrationId: started.body.id,
      expectedRevision: 0,
      questionKey: "not-in-release",
      value: "forged",
    })).rejects.toMatchObject({ code: "QUESTION_UNKNOWN" });
    const after = await readEventsSince(db, { activityId, after: 0, limit: 100 });
    expect(after).toEqual(before);
  });

  it("runs draft, submit, staff review, and server-derived roster finalization", async () => {
    const activityId = await seedActivity();
    const started = await startRegistration(db, deps(participant), {
      commandId: "start-registration-2",
      activityId,
      participantId: participant.actorId,
    });
    const answered = await saveRegistrationAnswer(db, deps(participant), {
      commandId: "answer-registration-2",
      activityId,
      registrationId: started.body.id,
      expectedRevision: 0,
      questionKey: "name",
      value: "Alice",
    });
    const submitted = await submitRegistration(db, deps(participant), {
      commandId: "submit-registration-2",
      activityId,
      registrationId: started.body.id,
      expectedRevision: answered.body.revision,
    });
    const beforeUnauthorizedReview = await readEventsSince(db, { activityId, after: 0, limit: 100 });
    await expect(reviewRegistration(db, deps(participant), {
      commandId: "review-registration-forbidden",
      activityId,
      registrationId: started.body.id,
      expectedRevision: submitted.body.revision,
      status: "approved",
      note: "forged",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const afterUnauthorizedReview = await readEventsSince(db, { activityId, after: 0, limit: 100 });
    expect(afterUnauthorizedReview).toEqual(beforeUnauthorizedReview);
    const reviewed = await reviewRegistration(db, deps(staff), {
      commandId: "review-registration-2",
      activityId,
      registrationId: started.body.id,
      expectedRevision: submitted.body.revision,
      status: "approved",
      note: "complete",
    });
    expect(reviewed.body.status).toBe("approved");
    const roster = await finalizeRoster(db, deps(staff), {
      commandId: "finalize-roster-2",
      activityId,
      expectedRevision: 0,
    });
    expect(roster.body).toMatchObject({ status: "final", approvedCount: 1 });
    expect(roster.body.revision).toBe(1);
  });

  it("rejects the execution boundary while the roster is unknown and has no side effect", async () => {
    const activityId = await seedActivity();
    await seedJudgingSession(activityId);
    const before = await readEventsSince(db, { activityId, after: 0, limit: 100 });
    await expect(prepareCompetitionRound(db, deps(staff), {
      commandId: "prepare-round-unknown",
      activityId,
      roundKey: "round-1",
      scope: "judging",
    })).rejects.toMatchObject({ code: "ROSTER_UNKNOWN" });
    const after = await readEventsSince(db, { activityId, after: 0, limit: 100 });
    expect(after).toEqual(before);
  });

  it("does not allow a participant to read another participant's material", async () => {
    const activityId = await seedActivity();
    const started = await startRegistration(db, deps(participant), {
      commandId: "start-registration-3",
      activityId,
      participantId: participant.actorId,
    });
    const uploaded = await (await import("../src/index.js")).uploadMaterial(db, deps(participant), {
      commandId: "upload-material-3",
      activityId,
      registrationId: started.body.id,
      questionKey: "audio",
      originalName: "song.mp3",
      contentType: "audio/mpeg",
      byteLength: 100,
    });
    expect(uploaded.body.storageKey).toMatch(/^private\//);
    await expect((await import("../src/index.js")).readMaterialForActor(db, {
      activityId,
      materialId: uploaded.body.id,
      actor: { ...participant, actorId: "student-2" },
    })).rejects.toBeInstanceOf(DomainError);
    await expect((await import("../src/index.js")).readMaterialForActor(db, {
      activityId,
      materialId: uploaded.body.id,
      actor: staff,
    })).resolves.toMatchObject({ id: uploaded.body.id, storageKey: uploaded.body.storageKey });
  });
});
