import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JourneySpecSchema } from "@artflow-plus/contracts";
import { closeDb, createDb, insertLocalAccount, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { hashPassword } from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { buildApp } from "../src/app.js";

/**
 * L4 journey runner. The spec is data; this file only maps each declared
 * action to the public HTTP surface, so a broken product path fails here the
 * same way it would fail a browser journey, without a browser.
 */
const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_journey_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let clock = 0;
let organizerToken = "";

const deps: RuntimeDeps = {
  now: () => new Date(Date.UTC(2026, 11, 11, 10, 0, 0) + clock++ * 1000).toISOString(),
  newEventId: () => randomUUID(),
};

function commandHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "idempotency-key": `cmd-${randomUUID()}`,
    "content-type": "application/json",
  };
}

async function tokenFor(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/token",
    headers: { "content-type": "application/json" },
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { token: string }).token;
}

describe.skipIf(!connectionString)("singer registration journey", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps, enableRuntimeFacts: true });
    await app.ready();
    await insertLocalAccount(db, {
      username: "journey-organizer",
      passwordDigest: hashPassword("journey-organizer-pass"),
      actor: {
        actorId: "journey-organizer",
        actorType: "user",
        roles: ["admin"],
        permissions: [
          "studio.manage",
          "registration.manage",
          "registration.review",
          "registration.roster.finalize",
          "competition.manage",
          "judge.manage",
          "result.manage",
        ],
      },
      active: true,
    });
    organizerToken = await tokenFor("journey-organizer", "journey-organizer-pass");
  });

  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("runs the data-driven organizer journey", async () => {
    const specPath = join(process.cwd(), "..", "..", "tools", "contracts", "journeys", "singer-registration-roster.json");
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as unknown;
    expect(Value.Check(JourneySpecSchema, spec)).toBe(true);
    if (!Value.Check(JourneySpecSchema, spec)) return;

    let activityId = "";
    let activityRevision = 0;
    let registrationId = "";
    let registrationRevision = 0;
    let participantId = "";
    let draftRevision = 0;
    let participantToken = "";

    const staff = () => commandHeaders(organizerToken);
    const participant = () => commandHeaders(participantToken);

    for (const step of spec.steps) {
      if (step.action === "create-activity") {
        const response = await app.inject({
          method: "POST",
          url: "/api/activities",
          headers: staff(),
          payload: { title: step.title ?? "Journey", packId: "singer-competition" },
        });
        expect(response.statusCode).toBeLessThan(400);
        const body = response.json() as { id: string; revision: number };
        activityId = body.id;
        activityRevision = body.revision;
      } else if (step.action === "activate-activity") {
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/activate`,
          headers: staff(),
          payload: { expectedRevision: activityRevision },
        });
        expect(response.statusCode).toBe(200);
      } else if (step.action === "compile-definition") {
        const studio = await app.inject({
          method: "GET",
          url: `/api/activities/${activityId}/studio`,
          headers: staff(),
        });
        expect(studio.statusCode).toBe(200);
        const state = studio.json() as { draft: { package: unknown } | null };
        expect(state.draft).not.toBeNull();
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/definitions/compile`,
          headers: staff(),
          payload: { package: state.draft?.package },
        });
        expect(response.statusCode).toBe(200);
        draftRevision = (response.json() as { draftRevision: number }).draftRevision;
      } else if (step.action === "release-definition") {
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/definitions/release`,
          headers: staff(),
          payload: { expectedDraftRevision: draftRevision },
        });
        expect(response.statusCode).toBe(201);
      } else if (step.action === "start-registration") {
        const registered = await app.inject({
          method: "POST",
          url: "/api/auth/register",
          headers: { "content-type": "application/json" },
          payload: { username: "journey-participant", password: "journey-participant-pass" },
        });
        expect(registered.statusCode).toBe(201);
        participantToken = await tokenFor("journey-participant", "journey-participant-pass");
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/registrations`,
          headers: participant(),
          payload: {},
        });
        expect(response.statusCode).toBeLessThan(400);
        const body = response.json() as { id: string; revision: number; participantId: string };
        registrationId = body.id;
        registrationRevision = body.revision;
        participantId = body.participantId;
      } else if (step.action === "answer-question") {
        const response = await app.inject({
          method: "PATCH",
          url: `/api/activities/${activityId}/registrations/${registrationId}/answers`,
          headers: participant(),
          payload: {
            expectedRevision: registrationRevision,
            questionKey: step.key,
            value: step.value,
          },
        });
        expect(response.statusCode).toBeLessThan(400);
        registrationRevision = (response.json() as { revision: number }).revision;
      } else if (step.action === "submit-registration") {
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/registrations/${registrationId}/submit`,
          headers: participant(),
          payload: { expectedRevision: registrationRevision },
        });
        expect(response.statusCode).toBeLessThan(400);
        registrationRevision = (response.json() as { revision: number }).revision;
      } else if (step.action === "review-registration") {
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/registrations/${registrationId}/review`,
          headers: staff(),
          payload: {
            expectedRevision: registrationRevision,
            status: step.status ?? "approved",
            note: "journey",
          },
        });
        expect(response.statusCode).toBeLessThan(400);
        registrationRevision = (response.json() as { revision: number }).revision;
      } else if (step.action === "finalize-roster") {
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/roster/finalize`,
          headers: staff(),
          payload: { expectedRevision: 0 },
        });
        expect(response.statusCode).toBeLessThan(400);
        expect(response.json()).toMatchObject({ status: "final", approvedCount: 1 });
      } else {
        // JOURNEY_ACTIONS can grow in @artflow-plus/contracts without this
        // runner growing with it; fail loudly instead of silently skipping the
        // step and leaving the journey green.
        throw new Error(`The journey runner does not implement action ${String(step.action)}.`);
      }
    }

    const roster = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/roster`,
      headers: staff(),
    });
    expect(roster.json()).toMatchObject({ roster: { status: "final", approvedCount: 1 } });

    // Read-model differential: the authoritative registration, the Ops list and
    // the Live display names must agree on identity and answers, not just IDs.
    const registrations = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/registrations`,
      headers: staff(),
    });
    expect(registrations.json()).toMatchObject({
      registrations: [
        {
          id: registrationId,
          participantId,
          status: "approved",
          answers: {
            name: "Journey Participant",
            student_id: "20260001",
            song: "Journey Song",
          },
        },
      ],
    });
    const live = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/live`,
      headers: staff(),
    });
    expect(live.statusCode).toBe(200);
    const liveState = live.json() as { participantNames: Readonly<Record<string, string>> };
    expect(liveState.participantNames[participantId]).toBe("Journey Participant");
  }, 60_000);
});
