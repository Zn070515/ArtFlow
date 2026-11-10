import { randomUUID } from "node:crypto";

import { closeDb, createDb, getTicket, insertRelease, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  compileAttendanceDefinition,
  createEmptyAttendanceDefinition,
} from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import { issueTicket } from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_attendance_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let managerApp: FastifyInstance;
let readerApp: FastifyInstance;
let forbiddenApp: FastifyInstance;

const deps: RuntimeDeps = {
  now: () => "2026-11-10T10:00:00.000Z",
  newEventId: () => `api-attendance-event-${randomUUID()}`,
  credentialSecret: "api-attendance-credential-secret",
};
const manager: ActorContext = {
  actorId: "api-attendance-manager",
  actorType: "user",
  roles: ["staff"],
  permissions: ["attendance.manage", "studio.manage"],
};
const reader: ActorContext = {
  actorId: "api-attendance-reader",
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.review"],
};
const forbidden: ActorContext = {
  actorId: "api-attendance-forbidden",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};
const ticketManager: ActorContext = {
  actorId: "api-attendance-ticket-manager",
  actorType: "user",
  roles: ["staff"],
  permissions: ["ticket.manage"],
};

function headers(commandId: string) {
  return { "content-type": "application/json", "idempotency-key": commandId };
}

async function seedActivity(): Promise<{ activityId: string; registrationId: string }> {
  const artifact = compileAttendanceDefinition(createEmptyAttendanceDefinition());
  if (!artifact.ok) throw new Error(JSON.stringify(artifact));
  const activityId = `api-attendance-activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "API attendance",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["attendance", "registration", "ticketing"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "api-attendance-release",
    capabilities: { attendance: artifact },
    executionPolicy: {
      declaredScopes: ["checkin"],
      conflicts: {},
      runtimeContractVersion: 2,
      commandScopes: {
        "attendance.checkin": ["checkin"],
        "attendance.undo": ["checkin"],
      },
    },
    capabilityVersions: { attendance: "1" },
    bindings: [],
    releasedAt: "2026-11-10T09:00:00Z",
    sourceDraftRevision: 1,
  });
  const registrationId = `api-attendance-registration-${randomUUID()}`;
  await db.insertInto("registration").values({
    id: registrationId,
    activity_id: activityId,
    participant_id: `api-attendance-participant-${randomUUID()}`,
    questionnaire_version: "v1",
    questionnaire_hash: "hash",
    status: "approved",
    answers: JSON.stringify({ name: "选手甲" }),
    supplement_keys: JSON.stringify([]),
    revision: 0,
    review_note: "",
    reviewed_by: null,
  }).execute();
  return { activityId, registrationId };
}

async function startSession(activityId: string): Promise<void> {
  const response = await managerApp.inject({
    method: "POST",
    url: `/api/activities/${activityId}/executions`,
    headers: headers(`session-${randomUUID()}`),
    payload: { scope: "checkin", mode: "formal" },
  });
  expect(response.statusCode, response.body).toBe(201);
}

async function createPoint(activityId: string): Promise<void> {
  const response = await managerApp.inject({
    method: "POST",
    url: `/api/activities/${activityId}/attendance/points`,
    headers: headers(`point-${randomUUID()}`),
    payload: { key: "gate", name: "入口", subjectTypes: ["participant", "ticket", "staff"] },
  });
  expect(response.statusCode, response.body).toBe(201);
}

describe.skipIf(!connectionString)("attendance API", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    managerApp = await buildApp({ db, deps, actor: manager });
    readerApp = await buildApp({ db, deps, actor: reader });
    forbiddenApp = await buildApp({ db, deps, actor: forbidden });
    await Promise.all([managerApp.ready(), readerApp.ready(), forbiddenApp.ready()]);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await Promise.all([managerApp.close(), readerApp.close(), forbiddenApp.close()]);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("checks in a participant, rejects a duplicate, and undoes it", async () => {
    const { activityId, registrationId } = await seedActivity();
    await startSession(activityId);
    await createPoint(activityId);

    const first = await managerApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/attendance/checkin`,
      headers: headers(`checkin-${randomUUID()}`),
      payload: { pointKey: "gate", subjectType: "participant", subjectId: registrationId },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ subjectId: registrationId, status: "present" });

    const duplicate = await managerApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/attendance/checkin`,
      headers: headers(`checkin-${randomUUID()}`),
      payload: { pointKey: "gate", subjectType: "participant", subjectId: registrationId },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "ALREADY_CHECKED_IN" });

    const list = await readerApp.inject({
      method: "GET",
      url: `/api/activities/${activityId}/attendance?mode=formal`,
    });
    expect(list.statusCode, list.body).toBe(200);
    const listBody = list.json() as {
      readonly mode: string;
      readonly summary: readonly { readonly subjectType: string; readonly expected: number; readonly present: number; readonly undone: number }[];
    };
    expect(listBody.mode).toBe("formal");
    expect(listBody.summary.find((item) => item.subjectType === "participant")).toMatchObject({
      expected: 1,
      present: 1,
      undone: 0,
    });

    const undo = await managerApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/attendance/undo`,
      headers: headers(`undo-${randomUUID()}`),
      payload: { pointKey: "gate", subjectType: "participant", subjectId: registrationId },
    });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(undo.json()).toMatchObject({ status: "undone" });
  });

  it("checks in a ticket credential without consuming the ticket", async () => {
    const { activityId } = await seedActivity();
    await startSession(activityId);
    await createPoint(activityId);
    const issued = await issueTicket(db, { ...deps, actor: ticketManager }, {
      commandId: `ticket-${randomUUID()}`,
      activityId,
    });
    const credential = issued.body.credential;
    if (credential === undefined) throw new Error("ticket credential missing");

    const response = await managerApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/attendance/checkin`,
      headers: headers(`ticket-checkin-${randomUUID()}`),
      payload: { pointKey: "gate", subjectType: "ticket", credential },
    });
    expect(response.statusCode, response.body).toBe(200);
    const ticket = await getTicket(db, issued.body.ticket.id);
    expect(ticket?.state).toBe("issued");
    const sessions = await db.selectFrom("ticket_access_session").selectAll().execute();
    expect(sessions).toHaveLength(0);
  });

  it("rejects an unprivileged reader and a mixed ticket body", async () => {
    const { activityId } = await seedActivity();
    await startSession(activityId);
    await createPoint(activityId);

    const forbiddenList = await forbiddenApp.inject({
      method: "GET",
      url: `/api/activities/${activityId}/attendance`,
    });
    expect(forbiddenList.statusCode).toBe(403);

    const mixed = await managerApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/attendance/checkin`,
      headers: headers(`mixed-${randomUUID()}`),
      payload: {
        pointKey: "gate",
        subjectType: "ticket",
        ticketId: "ticket-1",
        credential: "T.abc",
      },
    });
    expect(mixed.statusCode).toBe(400);
  });
});
