import { randomUUID } from "node:crypto";

import { closeDb, createDb, getTicket, insertRelease, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  compileAttendanceDefinition,
  createDefaultCapabilityRegistry,
  createEmptyAttendanceDefinition,
} from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkIn,
  closeExecution,
  createAttendancePoint,
  issueTicket,
  listAttendance,
  resolveTicketCredentialForAttendance,
  startExecution,
  undoCheckIn,
  updateAttendancePointCommand,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_attendance_runtime_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const registry = createDefaultCapabilityRegistry();
const staff: ActorContext = {
  actorId: "attendance-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["attendance.manage"],
};
const studio: ActorContext = {
  actorId: "attendance-studio",
  actorType: "user",
  roles: ["staff"],
  permissions: ["studio.manage", "attendance.manage"],
};
const ticketManager: ActorContext = {
  actorId: "attendance-ticket-manager",
  actorType: "user",
  roles: ["staff"],
  permissions: ["ticket.manage", "attendance.manage"],
};

function deps(actor: ActorContext, now = "2026-11-10T10:00:00.000Z"): RuntimeDeps {
  return {
    actor,
    now: () => now,
    newEventId: () => `attendance-event-${randomUUID()}`,
    credentialSecret: "attendance-test-credential-secret",
  };
}

const releasePolicy = {
  declaredScopes: ["checkin"],
  conflicts: {},
  runtimeContractVersion: 2,
  commandScopes: {
    "attendance.checkin": ["checkin"],
    "attendance.undo": ["checkin"],
  },
} as const;

interface SeededActivity {
  readonly activityId: string;
  readonly registrationId: string;
}

async function seedActivity(): Promise<SeededActivity> {
  const artifact = compileAttendanceDefinition(createEmptyAttendanceDefinition());
  if (!artifact.ok) throw new Error(JSON.stringify(artifact));
  const activityId = `attendance-activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    title: "Attendance runtime",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["attendance", "registration", "ticketing"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "attendance-release",
    capabilities: { attendance: artifact },
    executionPolicy: releasePolicy,
    capabilityVersions: { attendance: "1" },
    bindings: [],
    releasedAt: "2026-11-10T09:00:00Z",
    sourceDraftRevision: 1,
  });
  const registrationId = `registration-${randomUUID()}`;
  await db.insertInto("registration").values({
    id: registrationId,
    activity_id: activityId,
    participant_id: `participant-${randomUUID()}`,
    questionnaire_version: "v1",
    questionnaire_hash: "hash",
    status: "approved",
    answers: JSON.stringify({ name: "选手甲" }),
    supplement_keys: JSON.stringify([]),
    revision: 0,
    review_note: "",
    reviewed_by: null,
  }).execute();
  await createAttendancePoint(db, deps(staff), {
    commandId: `point-${randomUUID()}`,
    activityId,
    actor: staff,
    key: "gate",
    name: "入口",
    subjectTypes: ["participant", "ticket", "staff"],
  });
  return { activityId, registrationId };
}

async function startCheckinSession(activityId: string, mode: "formal" | "test") {
  const started = await startExecution(db, registry, deps(studio), {
    commandId: `start-${randomUUID()}`,
    activityId,
    scope: "checkin",
    mode,
  });
  return started.body;
}

describe.skipIf(!connectionString)("attendance runtime on PostgreSQL", () => {
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

  it("checks in, rejects a duplicate, undoes, and rechecks", async () => {
    const { activityId, registrationId } = await seedActivity();
    await startCheckinSession(activityId, "formal");
    const first = await checkIn(db, deps(staff), {
      commandId: `checkin-${randomUUID()}`,
      activityId,
      actor: staff,
      pointKey: "gate",
      subjectType: "participant",
      subjectId: registrationId,
    });
    expect(first.body.status).toBe("present");
    await expect(checkIn(db, deps(staff), {
      commandId: `checkin-${randomUUID()}`,
      activityId,
      actor: staff,
      pointKey: "gate",
      subjectType: "participant",
      subjectId: registrationId,
    })).rejects.toMatchObject({ code: "ALREADY_CHECKED_IN" });
    const undone = await undoCheckIn(db, deps(staff), {
      commandId: `undo-${randomUUID()}`,
      activityId,
      actor: staff,
      pointKey: "gate",
      subjectType: "participant",
      subjectId: registrationId,
    });
    expect(undone.body.status).toBe("undone");
    const recheck = await checkIn(db, deps(staff), {
      commandId: `checkin-${randomUUID()}`,
      activityId,
      actor: staff,
      pointKey: "gate",
      subjectType: "participant",
      subjectId: registrationId,
    });
    expect(recheck.body.revision).toBe(3);
  });

  it("rejects a check-in without a running session", async () => {
    const { activityId, registrationId } = await seedActivity();
    await expect(checkIn(db, deps(staff), {
      commandId: `checkin-${randomUUID()}`,
      activityId,
      actor: staff,
      pointKey: "gate",
      subjectType: "participant",
      subjectId: registrationId,
    })).rejects.toMatchObject({ code: "SESSION_NOT_RUNNING" });
  });

  it("keeps formal and test check-ins apart", async () => {
    const { activityId, registrationId } = await seedActivity();
    const formal = await startCheckinSession(activityId, "formal");
    await checkIn(db, deps(staff), {
      commandId: `checkin-${randomUUID()}`,
      activityId,
      actor: staff,
      pointKey: "gate",
      subjectType: "participant",
      subjectId: registrationId,
    });
    await closeExecution(db, deps(studio), {
      commandId: `close-${randomUUID()}`,
      activityId,
      sessionId: formal.id,
      expectedRevision: formal.revision,
    });
    await startCheckinSession(activityId, "test");
    await checkIn(db, deps(staff), {
      commandId: `checkin-${randomUUID()}`,
      activityId,
      actor: staff,
      pointKey: "gate",
      subjectType: "participant",
      subjectId: registrationId,
    });
    const formalView = await listAttendance(db, deps(staff), { activityId, mode: "formal" });
    const testView = await listAttendance(db, deps(staff), { activityId, mode: "test" });
    expect(formalView.rows.find((row) => row.subjectId === registrationId)?.status).toBe("present");
    expect(testView.rows.find((row) => row.subjectId === registrationId)?.status).toBe("present");
  });

  it("resolves and checks in a ticket without changing its state", async () => {
    const { activityId } = await seedActivity();
    await startCheckinSession(activityId, "formal");
    const issued = await issueTicket(db, deps(ticketManager), {
      commandId: `ticket-${randomUUID()}`,
      activityId,
    });
    const credential = issued.body.credential;
    if (credential === undefined) throw new Error("ticket credential missing");
    const resolved = await resolveTicketCredentialForAttendance(db, deps(ticketManager), credential);
    const checked = await checkIn(db, deps(staff), {
      commandId: `checkin-${randomUUID()}`,
      activityId,
      actor: staff,
      pointKey: "gate",
      subjectType: "ticket",
      subjectId: resolved.ticketId,
    });
    expect(checked.body.status).toBe("present");
    const ticket = await getTicket(db, resolved.ticketId);
    expect(ticket?.state).toBe("issued");
    const sessions = await db.selectFrom("ticket_access_session").selectAll().execute();
    expect(sessions).toHaveLength(0);
  });

  it("keeps a checked-in subject visible after it becomes ineligible", async () => {
    const { activityId, registrationId } = await seedActivity();
    await startCheckinSession(activityId, "formal");
    await checkIn(db, deps(staff), {
      commandId: `checkin-${randomUUID()}`,
      activityId,
      actor: staff,
      pointKey: "gate",
      subjectType: "participant",
      subjectId: registrationId,
    });
    await db.updateTable("registration").set({ status: "rejected" }).where("id", "=", registrationId).execute();
    const view = await listAttendance(db, deps(staff), { activityId, mode: "formal" });
    const row = view.rows.find((item) => item.subjectId === registrationId);
    expect(row?.eligible).toBe(false);
    expect(row?.status).toBe("present");
    expect(view.summary.find((item) => item.subjectType === "participant")?.present).toBe(0);
  });

  it("refuses to remove a subject type that already has attendance", async () => {
    const { activityId, registrationId } = await seedActivity();
    await startCheckinSession(activityId, "formal");
    await checkIn(db, deps(staff), {
      commandId: `checkin-${randomUUID()}`,
      activityId,
      actor: staff,
      pointKey: "gate",
      subjectType: "participant",
      subjectId: registrationId,
    });
    await expect(updateAttendancePointCommand(db, deps(staff), {
      commandId: `point-update-${randomUUID()}`,
      activityId,
      actor: staff,
      pointKey: "gate",
      expectedRevision: 0,
      name: "入口",
      subjectTypes: ["ticket", "staff"],
      active: true,
    })).rejects.toMatchObject({ code: "POINT_TYPE_IN_USE" });
  });
});
