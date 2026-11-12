import { COMPETITION_COMMAND_SCOPES } from "@artflow-plus/domain";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeDb,
  createDb,
  insertRegistration,
  insertRelease,
  insertSession,
  listApprovedParticipantIds,
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
  attachMaterialContent,
  createLocalMaterialStorage,
  finalizeRoster,
  getMyRegistration,
  prepareCompetitionRound,
  reopenRoster,
  reviewMaterial,
  reviewRegistration,
  saveRegistrationAnswer,
  startRegistration,
  submitRegistration,
  uploadMaterial,
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
let materialRoot = "";

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
  permissions: ["registration.review", "registration.roster.finalize", "materials.review", "materials.read", "competition.round.prepare"],
};
const roundOperator: ActorContext = {
  actorId: "round-operator-1",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.round.prepare"],
};

function deps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 9, 19, 10, 0, tick++)).toISOString(),
    newEventId: () => `evt-${randomUUID()}`,
    materialStorage: createLocalMaterialStorage({ root: materialRoot }),
  };
}

function audioBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const header = [0x49, 0x44, 0x33, 0x04, 0x00, 0x00];
  bytes.set(header.slice(0, Math.min(length, header.length)), 0);
  return bytes;
}

async function uploadWithContent(
  actor: ActorContext,
  input: Parameters<typeof uploadMaterial>[2],
) {
  const uploaded = await uploadMaterial(db, deps(actor), input);
  return attachMaterialContent(db, deps(actor), {
    commandId: `${input.commandId}-content`,
    activityId: input.activityId,
    materialId: uploaded.body.id,
    bytes: audioBytes(input.byteLength),
  });
}

async function submitForReview(
  activityId: string,
  actor: ActorContext,
  suffix: string,
): Promise<string> {
  const started = await startRegistration(db, deps(actor), {
    commandId: `start-${suffix}`,
    activityId,
    participantId: actor.actorId,
  });
  const answered = await saveRegistrationAnswer(db, deps(actor), {
    commandId: `answer-${suffix}`,
    activityId,
    registrationId: started.body.id,
    expectedRevision: 0,
    questionKey: "name",
    value: `name-${suffix}`,
  });
  await uploadWithContent(actor, {
    commandId: `upload-${suffix}`,
    activityId,
    registrationId: started.body.id,
    questionKey: "audio",
    originalName: "song.mp3",
    contentType: "audio/mpeg",
    byteLength: 100,
  });
  await submitRegistration(db, deps(actor), {
    commandId: `submit-${suffix}`,
    activityId,
    registrationId: started.body.id,
    expectedRevision: answered.body.revision,
  });
  return started.body.id;
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
    executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 2, commandScopes: COMPETITION_COMMAND_SCOPES },
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
    materialRoot = await mkdtemp(join(tmpdir(), "artflow-registration-material-"));
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

  it("rejects a material whose extension is not accepted", async () => {
    const activityId = await seedActivity();
    const started = await startRegistration(db, deps(participant), {
      commandId: "start-registration-wrong-extension",
      activityId,
      participantId: participant.actorId,
    });
    await expect(uploadMaterial(db, deps(participant), {
      commandId: "upload-wrong-extension",
      activityId,
      registrationId: started.body.id,
      questionKey: "audio",
      originalName: "song.txt",
      contentType: "text/plain",
      byteLength: 10,
    })).rejects.toMatchObject({ code: "MATERIAL_NOT_ALLOWED" });
  });

  it("rejects bytes that do not match the declared audio purpose", async () => {
    const activityId = await seedActivity();
    const started = await startRegistration(db, deps(participant), {
      commandId: "start-registration-wrong-content",
      activityId,
      participantId: participant.actorId,
    });
    const material = await uploadMaterial(db, deps(participant), {
      commandId: "upload-wrong-content",
      activityId,
      registrationId: started.body.id,
      questionKey: "audio",
      originalName: "song.mp3",
      contentType: "audio/mpeg",
      byteLength: 10,
    });
    await expect(attachMaterialContent(db, deps(participant), {
      commandId: "attach-wrong-content",
      activityId,
      materialId: material.body.id,
      bytes: new Uint8Array(10).fill(1),
    })).rejects.toMatchObject({ code: "MATERIAL_NOT_ALLOWED" });
  });

  it("keeps the previous current material when replacement content fails", async () => {
    // LIFE-10: a failed replacement must not retire the current material.
    const activityId = await seedActivity();
    const started = await startRegistration(db, deps(participant), {
      commandId: "start-registration-life10",
      activityId,
      participantId: participant.actorId,
    });
    const first = await uploadWithContent(participant, {
      commandId: "upload-life10-a",
      activityId,
      registrationId: started.body.id,
      questionKey: "audio",
      originalName: "first.mp3",
      contentType: "audio/mpeg",
      byteLength: 100,
    });
    const replacement = await uploadMaterial(db, deps(participant), {
      commandId: "upload-life10-b",
      activityId,
      registrationId: started.body.id,
      questionKey: "audio",
      originalName: "second.mp3",
      contentType: "audio/mpeg",
      byteLength: 20,
    });
    await expect(attachMaterialContent(db, deps(participant), {
      commandId: "attach-life10-b",
      activityId,
      materialId: replacement.body.id,
      bytes: new Uint8Array(19).fill(1),
    })).rejects.toMatchObject({ code: "MATERIAL_NOT_ALLOWED" });

    const rows = await db
      .selectFrom("material")
      .select(["id", "current", "content_ready"])
      .where("registration_id", "=", started.body.id)
      .where("question_key", "=", "audio")
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(first.body.id)).toMatchObject({ current: true, content_ready: true });
    expect(byId.get(replacement.body.id)).toMatchObject({
      current: false,
      content_ready: false,
    });

    // Simulate the corrupt shape the invariant forbids: a current row without
    // bytes. Review must refuse it even though the row is current.
    await db.updateTable("material").set({ current: false })
      .where("id", "=", first.body.id).execute();
    await db.updateTable("material").set({ current: true, content_ready: false })
      .where("id", "=", replacement.body.id).execute();
    await expect(reviewMaterial(db, deps(staff), {
      commandId: "review-life10-staging",
      activityId,
      materialId: replacement.body.id,
      expectedRevision: replacement.body.revision,
      status: "approved",
      note: "",
    })).rejects.toMatchObject({ code: "MATERIAL_CONTENT_UNAVAILABLE" });
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
    const uploadedMaterial = await uploadWithContent(participant, {
      commandId: "upload-material-2",
      activityId,
      registrationId: started.body.id,
      questionKey: "audio",
      originalName: "song.mp3",
      contentType: "audio/mpeg",
      byteLength: 100,
    });
    const reviewedMaterial = await reviewMaterial(db, deps(staff), {
      commandId: "review-material-2",
      activityId,
      materialId: uploadedMaterial.body.id,
      expectedRevision: uploadedMaterial.body.revision,
      status: "approved",
      note: "clear",
    });
    expect(reviewedMaterial.body).toMatchObject({
      status: "approved",
      reviewNote: "clear",
      reviewedBy: staff.actorId,
      revision: uploadedMaterial.body.revision + 1,
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
    const events = await readEventsSince(db, { activityId, after: 0, limit: 100 });
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "MaterialReviewed",
      "RegistrationReviewed",
      "RosterFinalized",
    ]));
  });

  it("refuses to review registrations after the roster is final", async () => {
    const activityId = await seedActivity();
    const submitFor = async (actor: ActorContext, suffix: string): Promise<string> => {
      const started = await startRegistration(db, deps(actor), {
        commandId: `start-${suffix}`,
        activityId,
        participantId: actor.actorId,
      });
      const answered = await saveRegistrationAnswer(db, deps(actor), {
        commandId: `answer-${suffix}`,
        activityId,
        registrationId: started.body.id,
        expectedRevision: 0,
        questionKey: "name",
        value: `name-${suffix}`,
      });
      await uploadWithContent(actor, {
        commandId: `upload-${suffix}`,
        activityId,
        registrationId: started.body.id,
        questionKey: "audio",
        originalName: "song.mp3",
        contentType: "audio/mpeg",
        byteLength: 100,
      });
      return (await submitRegistration(db, deps(actor), {
        commandId: `submit-${suffix}`,
        activityId,
        registrationId: started.body.id,
        expectedRevision: answered.body.revision,
      })).body.id;
    };

    const firstRegistration = await submitFor(participant, "roster-first");
    await reviewRegistration(db, deps(staff), {
      commandId: "review-roster-first",
      activityId,
      registrationId: firstRegistration,
      expectedRevision: 2,
      status: "approved",
      note: "ok",
    });
    const second: ActorContext = { ...participant, actorId: "student-2" };
    const secondRegistration = await submitFor(second, "roster-second");
    // Every submission must have a decision before the roster can be frozen.
    const rejected = await reviewRegistration(db, deps(staff), {
      commandId: "reject-roster-second",
      activityId,
      registrationId: secondRegistration,
      expectedRevision: 2,
      status: "rejected",
      note: "not selected",
    });
    const roster = await finalizeRoster(db, deps(staff), {
      commandId: "finalize-roster-lock",
      activityId,
      expectedRevision: 0,
    });
    expect(roster.body).toMatchObject({ status: "final", approvedCount: 1 });

    const before = await readEventsSince(db, { activityId, after: 0, limit: 100 });
    await expect(reviewRegistration(db, deps(staff), {
      commandId: "review-after-final",
      activityId,
      registrationId: secondRegistration,
      expectedRevision: rejected.body.revision,
      status: "approved",
      note: "late",
    })).rejects.toMatchObject({ code: "ROSTER_FINAL" });
    expect(await readEventsSince(db, { activityId, after: 0, limit: 100 })).toEqual(before);
    expect(await listApprovedParticipantIds(db, activityId)).toEqual([participant.actorId]);
  });

  it("refuses to finalize an empty roster", async () => {
    const activityId = await seedActivity();

    await expect(finalizeRoster(db, deps(staff), {
      commandId: "finalize-empty",
      activityId,
      expectedRevision: 0,
    })).rejects.toMatchObject({ code: "ROSTER_EMPTY" });
  });

  it("refuses to finalize while a submission still awaits review", async () => {
    const activityId = await seedActivity();
    const started = await startRegistration(db, deps(participant), {
      commandId: "start-pending",
      activityId,
      participantId: participant.actorId,
    });
    const answered = await saveRegistrationAnswer(db, deps(participant), {
      commandId: "answer-pending",
      activityId,
      registrationId: started.body.id,
      expectedRevision: 0,
      questionKey: "name",
      value: "Pending",
    });
    await uploadWithContent(participant, {
      commandId: "upload-pending",
      activityId,
      registrationId: started.body.id,
      questionKey: "audio",
      originalName: "song.mp3",
      contentType: "audio/mpeg",
      byteLength: 100,
    });
    await submitRegistration(db, deps(participant), {
      commandId: "submit-pending",
      activityId,
      registrationId: started.body.id,
      expectedRevision: answered.body.revision,
    });

    await expect(finalizeRoster(db, deps(staff), {
      commandId: "finalize-pending",
      activityId,
      expectedRevision: 0,
    })).rejects.toMatchObject({ code: "ROSTER_HAS_PENDING", details: { pendingCount: 1 } });
  });

  it("reopens a final roster and re-enables review", async () => {
    const activityId = await seedActivity();
    const first: ActorContext = { ...participant, actorId: "student-first" };
    const submitted = await submitForReview(activityId, first, "reopen-first");
    await reviewRegistration(db, deps(staff), {
      commandId: "review-reopen-first",
      activityId,
      registrationId: submitted,
      expectedRevision: 2,
      status: "approved",
      note: "ok",
    });
    const finalized = await finalizeRoster(db, deps(staff), {
      commandId: "finalize-reopen",
      activityId,
      expectedRevision: 0,
    });

    await expect(reopenRoster(db, deps(staff), {
      commandId: "reopen-requires-reason",
      activityId,
      expectedRevision: finalized.body.revision,
      reason: "   ",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const reopened = await reopenRoster(db, deps(staff), {
      commandId: "reopen-roster",
      activityId,
      expectedRevision: finalized.body.revision,
      reason: "roster finalized before a late submission",
    });
    expect(reopened.body).toMatchObject({ status: "unknown", revision: finalized.body.revision + 1 });

    const late: ActorContext = { ...participant, actorId: "student-late" };
    const lateRegistration = await submitForReview(activityId, late, "reopen-late");
    const approved = await reviewRegistration(db, deps(staff), {
      commandId: "review-after-reopen",
      activityId,
      registrationId: lateRegistration,
      expectedRevision: 2,
      status: "approved",
      note: "late but valid",
    });
    expect(approved.body.status).toBe("approved");
    const events = await readEventsSince(db, { activityId, after: 0, limit: 200 });
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "RosterFinalized",
      "RosterReopened",
      "RegistrationReviewed",
    ]));
  });

  it("refuses to start, answer, or submit after the roster is final", async () => {
    const activityId = await seedActivity();
    const draft = await startRegistration(db, deps(participant), {
      commandId: "start-before-final",
      activityId,
      participantId: participant.actorId,
    });
    // A final roster must contain at least one approved participant, so the
    // freeze is tested with a real approved registration rather than an empty
    // roster (which the domain now refuses outright).
    const winner: ActorContext = { ...participant, actorId: "student-winner" };
    const started = await startRegistration(db, deps(winner), {
      commandId: "start-winner",
      activityId,
      participantId: winner.actorId,
    });
    const answered = await saveRegistrationAnswer(db, deps(winner), {
      commandId: "answer-winner",
      activityId,
      registrationId: started.body.id,
      expectedRevision: 0,
      questionKey: "name",
      value: "Winner",
    });
    await uploadWithContent(winner, {
      commandId: "upload-winner",
      activityId,
      registrationId: started.body.id,
      questionKey: "audio",
      originalName: "song.mp3",
      contentType: "audio/mpeg",
      byteLength: 100,
    });
    const submitted = await submitRegistration(db, deps(winner), {
      commandId: "submit-winner",
      activityId,
      registrationId: started.body.id,
      expectedRevision: answered.body.revision,
    });
    await reviewRegistration(db, deps(staff), {
      commandId: "review-winner",
      activityId,
      registrationId: started.body.id,
      expectedRevision: submitted.body.revision,
      status: "approved",
      note: "ok",
    });
    await finalizeRoster(db, deps(staff), {
      commandId: "finalize-roster-with-winner",
      activityId,
      expectedRevision: 0,
    });
    const before = await readEventsSince(db, { activityId, after: 0, limit: 100 });
    const late: ActorContext = { ...participant, actorId: "student-late" };

    await expect(startRegistration(db, deps(late), {
      commandId: "start-after-final",
      activityId,
      participantId: late.actorId,
    })).rejects.toMatchObject({ code: "ROSTER_FINAL" });
    await expect(saveRegistrationAnswer(db, deps(participant), {
      commandId: "answer-after-final",
      activityId,
      registrationId: draft.body.id,
      expectedRevision: draft.body.revision,
      questionKey: "name",
      value: "late answer",
    })).rejects.toMatchObject({ code: "ROSTER_FINAL" });
    await expect(submitRegistration(db, deps(participant), {
      commandId: "submit-after-final",
      activityId,
      registrationId: draft.body.id,
      expectedRevision: draft.body.revision,
    })).rejects.toMatchObject({ code: "ROSTER_FINAL" });
    expect(await readEventsSince(db, { activityId, after: 0, limit: 100 })).toEqual(before);
  });

  it("requires every required released question before submission", async () => {
    const activityId = await seedActivity();
    const started = await startRegistration(db, deps(participant), {
      commandId: "start-registration-required",
      activityId,
      participantId: participant.actorId,
    });
    const answered = await saveRegistrationAnswer(db, deps(participant), {
      commandId: "answer-registration-required",
      activityId,
      registrationId: started.body.id,
      expectedRevision: started.body.revision,
      questionKey: "name",
      value: "Alice",
    });
    await expect(submitRegistration(db, deps(participant), {
      commandId: "submit-registration-required",
      activityId,
      registrationId: started.body.id,
      expectedRevision: answered.body.revision,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("keeps an existing registration on its released questionnaire snapshot", async () => {
    const activityId = await seedActivity();
    const started = await startRegistration(db, deps(participant), {
      commandId: "start-registration-snapshot",
      activityId,
      participantId: participant.actorId,
    });
    await db.insertInto("definition_release").values({
      activity_id: activityId,
      version: 2,
      content_hash: "release-hash-v2",
      capabilities: JSON.stringify({
        registration: { ok: true, capabilityKey: "registration", contentHash: "registration-hash-v2", artifact: { schemaVersion: 1, lifecycleVersion: 1, rosterStatus: "unknown" } },
        questionnaire: { ok: true, capabilityKey: "questionnaire", contentHash: "questionnaire-content-hash-v2", artifact: {
          ...questionnaireArtifact,
          version: "v2",
          schemaHash: "questionnaire-hash-v2",
          questions: [{ key: "alias", label: "别名", type: "text", required: true }],
          fileSlots: [],
        } },
        materials: { ok: true, capabilityKey: "materials", contentHash: "materials-hash-v2", artifact: { schemaVersion: 1, maxBytes: 25_000_000, allowedPurposes: [] } },
      }),
      execution_policy: JSON.stringify({ declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 2, commandScopes: COMPETITION_COMMAND_SCOPES }),
      capability_versions: JSON.stringify({ registration: "1", questionnaire: "1", materials: "1", competition: "1" }),
      bindings: JSON.stringify([]),
      released_at: "2026-10-19T09:15:00Z",
      source_draft_revision: 2,
    }).execute();
    await db.updateTable("activity")
      .set({ active_definition_version: 2, revision: 2 })
      .where("id", "=", activityId)
      .execute();

    const answered = await saveRegistrationAnswer(db, deps(participant), {
      commandId: "answer-registration-snapshot",
      activityId,
      registrationId: started.body.id,
      expectedRevision: started.body.revision,
      questionKey: "name",
      value: "Alice",
    });
    expect(answered.body.answers).toMatchObject({ name: "Alice" });
    const uploaded = await uploadWithContent(participant, {
      commandId: "upload-material-snapshot",
      activityId,
      registrationId: started.body.id,
      questionKey: "audio",
      originalName: "song.mp3",
      contentType: "audio/mpeg",
      byteLength: 100,
    });
    expect(uploaded.body.questionKey).toBe("audio");
    const submitted = await submitRegistration(db, deps(participant), {
      commandId: "submit-registration-snapshot",
      activityId,
      registrationId: started.body.id,
      expectedRevision: answered.body.revision,
    });
    expect(submitted.body.status).toBe("submitted");
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

  it("uses a competition execution permission at the round boundary", async () => {
    const activityId = await seedActivity();
    await seedJudgingSession(activityId);
    await expect(prepareCompetitionRound(db, deps(roundOperator), {
      commandId: "prepare-round-permission",
      activityId,
      roundKey: "round-1",
      scope: "judging",
    })).rejects.toMatchObject({ code: "ROSTER_UNKNOWN" });
  });

  it("does not allow a participant to read another participant's material", async () => {
    const activityId = await seedActivity();
    const started = await startRegistration(db, deps(participant), {
      commandId: "start-registration-3",
      activityId,
      participantId: participant.actorId,
    });
    const uploaded = await uploadWithContent(participant, {
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

  it("returns domain refusals, never driver errors, for generated command payloads", async () => {
    const activityId = await seedActivity();
    const started = await startRegistration(db, deps(participant), {
      commandId: "start-fuzz",
      activityId,
      participantId: participant.actorId,
    });
    const registrationId = started.body.id;
    const operation = fc.record({
      kind: fc.constantFrom("answer", "submit", "review"),
      revision: fc.integer({ min: -1, max: 5 }),
      key: fc.constantFrom("name", "audio", "missing-question", ""),
      value: fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.dictionary(fc.string(), fc.string())),
      status: fc.constantFrom("approved", "rejected", "need_supplement"),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(operation, { maxLength: 6 }), async (operations) => {
        for (const op of operations) {
          try {
            if (op.kind === "answer") {
              await saveRegistrationAnswer(db, deps(participant), {
                commandId: `fuzz-${randomUUID()}`,
                activityId,
                registrationId,
                expectedRevision: op.revision,
                questionKey: op.key,
                value: op.value,
              });
            } else if (op.kind === "submit") {
              await submitRegistration(db, deps(participant), {
                commandId: `fuzz-${randomUUID()}`,
                activityId,
                registrationId,
                expectedRevision: op.revision,
              });
            } else {
              await reviewRegistration(db, deps(staff), {
                commandId: `fuzz-${randomUUID()}`,
                activityId,
                registrationId,
                expectedRevision: op.revision,
                status: op.status,
                note: "fuzz",
              });
            }
          } catch (error) {
            // A refused command is a domain decision. A raw pg error here would
            // mean an API boundary could leak SQLSTATE or table structure.
            expect(error).toBeInstanceOf(DomainError);
            expect(error instanceof Error ? error.message : "").not.toMatch(
              /SQLSTATE|duplicate key|violates|relation "|column "/i,
            );
          }
        }
      }),
      { numRuns: 20 },
    );
  }, 60_000);

});
