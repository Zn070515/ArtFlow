import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JourneySpecSchema } from "@artflow-plus/contracts";
import type { JourneySpec } from "@artflow-plus/contracts";
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
const journeysDirectory = join(process.cwd(), "..", "..", "tools", "contracts", "journeys");

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let clock = 0;
let organizerToken = "";

const deps: RuntimeDeps = {
  now: () => new Date(Date.UTC(2026, 11, 11, 10, 0, 0) + clock++ * 1000).toISOString(),
  newEventId: () => randomUUID(),
  credentialSecret: "journey-credential-secret",
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

interface JourneyState {
  readonly activityId: string;
  readonly publicCode: string;
  readonly registrationId: string;
  readonly participantId: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly judgeCookie: string;
}

function loadJourney(specFile: string): JourneySpec {
  const spec = JSON.parse(readFileSync(join(journeysDirectory, specFile), "utf8")) as unknown;
  expect(Value.Check(JourneySpecSchema, spec), `${specFile} does not match the journey schema`).toBe(true);
  if (!Value.Check(JourneySpecSchema, spec)) throw new Error(`${specFile} is not a journey spec.`);
  return spec;
}

/** Keep the failing step's response body in the assertion message: a bare 400
 *  is unactionable, and a journey step is exactly where the code+details matter. */
function expectCommandOk(response: { statusCode: number; body: string }, step: string): void {
  expect(response.statusCode, `${step}: ${response.body}`).toBeLessThan(400);
}

describe.skipIf(!connectionString)("singer journeys", () => {
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
    if (app !== undefined) await app.close();
    if (db !== undefined) await closeDb(db);
    if (admin !== undefined) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });

  async function runJourney(specFile: string): Promise<JourneyState> {
    const spec = loadJourney(specFile);
    const participantUsername = `journey-${spec.id}`;
    const participantPassword = `${spec.id}-pass`;

    let activityId = "";
    let activityRevision = 0;
    let publicCode = "";
    let registrationId = "";
    let registrationRevision = 0;
    let participantId = "";
    let draftRevision = 0;
    let participantToken = "";
    let judgeCapability = "";
    let judgeCookie = "";
    const answers: Record<string, string> = {};

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
        expectCommandOk(response, step.action);
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
        const state = studio.json() as {
          activity: { publicCode: string };
          draft: { package: unknown } | null;
        };
        expect(state.draft).not.toBeNull();
        publicCode = state.activity.publicCode;
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
          payload: { username: participantUsername, password: participantPassword },
        });
        expect(registered.statusCode).toBe(201);
        participantToken = await tokenFor(participantUsername, participantPassword);
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/registrations`,
          headers: participant(),
          payload: {},
        });
        expectCommandOk(response, step.action);
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
        expectCommandOk(response, step.action);
        if (step.key !== undefined && step.value !== undefined) {
          answers[step.key] = step.value;
        }
        registrationRevision = (response.json() as { revision: number }).revision;
      } else if (step.action === "submit-registration") {
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/registrations/${registrationId}/submit`,
          headers: participant(),
          payload: { expectedRevision: registrationRevision },
        });
        expectCommandOk(response, step.action);
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
        expectCommandOk(response, step.action);
        registrationRevision = (response.json() as { revision: number }).revision;
      } else if (step.action === "finalize-roster") {
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/roster/finalize`,
          headers: staff(),
          payload: { expectedRevision: 0 },
        });
        expectCommandOk(response, step.action);
        expect(response.json()).toMatchObject({ status: "final", approvedCount: 1 });
      } else if (step.action === "start-judging-session") {
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/executions`,
          headers: staff(),
          payload: { scope: "judging", mode: "rehearsal" },
        });
        expectCommandOk(response, step.action);
      } else if (step.action === "prepare-round") {
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/competition/rounds/final/prepare`,
          headers: staff(),
          payload: { scope: "judging" },
        });
        expectCommandOk(response, step.action);
      } else if (step.action === "activate-panel") {
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/competition/rounds/final/panel`,
          headers: staff(),
          payload: {
            scope: "judging",
            judges: [
              { judgeId: "judge-1", seatKey: "seat-1" },
              { judgeId: "judge-2", seatKey: "seat-2" },
              { judgeId: "judge-3", seatKey: "seat-3" },
            ],
          },
        });
        expectCommandOk(response, step.action);
      } else if (step.action === "open-performance") {
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/competition/rounds/final/performances/perf-1/open`,
          headers: staff(),
          payload: { scope: "judging", contestantId: participantId, sequence: 1 },
        });
        expectCommandOk(response, step.action);
      } else if (step.action === "reissue-judge-entry") {
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/judge-entry/reissue`,
          headers: staff(),
          payload: { reason: "journey judge entry" },
        });
        expectCommandOk(response, step.action);
        judgeCapability = (response.json() as { capability: string }).capability;
        expect(judgeCapability.length).toBeGreaterThan(0);
      } else if (step.action === "claim-judge-seat") {
        const response = await app.inject({
          method: "POST",
          url: "/api/judge-entry/claim",
          headers: {
            "idempotency-key": `cmd-${randomUUID()}`,
            "content-type": "application/json",
          },
          payload: { publicCode, capability: judgeCapability },
        });
        expectCommandOk(response, step.action);
        const cookie = response.headers["set-cookie"];
        judgeCookie = Array.isArray(cookie) ? cookie.join("; ") : String(cookie ?? "");
        expect(judgeCookie).toContain("artflow_judge_session=");
      } else if (step.action === "submit-judge-score") {
        const context = await app.inject({
          method: "GET",
          url: "/api/judge/context",
          headers: { cookie: judgeCookie },
        });
        expect(context.statusCode).toBe(200);
        const judgeContext = context.json() as {
          scoring: {
            roundKey: string;
            performanceId: string;
            panelSnapshotId: string;
            seatId: string;
            contextVersion: number;
          } | null;
          rubric: { criteria: readonly { key: string }[] };
        };
        expect(judgeContext.scoring).not.toBeNull();
        if (judgeContext.scoring === null) throw new Error("The judge context has no scoring target.");
        const criteria = Object.fromEntries(
          judgeContext.rubric.criteria.map((criterion) => [criterion.key, 90]),
        );
        const response = await app.inject({
          method: "POST",
          url: `/api/activities/${activityId}/competition/rounds/${judgeContext.scoring.roundKey}/scores`,
          headers: {
            "idempotency-key": `cmd-${randomUUID()}`,
            "content-type": "application/json",
            cookie: judgeCookie,
          },
          payload: {
            scope: "judging",
            source: "direct_judge",
            performanceId: judgeContext.scoring.performanceId,
            panelSnapshotId: judgeContext.scoring.panelSnapshotId,
            seatId: judgeContext.scoring.seatId,
            contextVersion: judgeContext.scoring.contextVersion,
            criteria,
            notes: "journey",
          },
        });
        expectCommandOk(response, step.action);
      } else {
        // JOURNEY_ACTIONS can grow in @artflow-plus/contracts without this
        // runner growing with it; fail loudly instead of silently skipping the
        // step and leaving the journey green.
        throw new Error(`The journey runner does not implement action ${String(step.action)}.`);
      }
    }

    return { activityId, publicCode, registrationId, participantId, answers, judgeCookie };
  }

  /** Read-model differential: the authoritative registration, the Ops list and
   *  the Live display names must agree with the spec on identity and answers,
   *  not just IDs. Expectations come from the spec fixture, not the API. */
  async function assertRegistrationReadModels(journey: JourneyState): Promise<void> {
    const roster = await app.inject({
      method: "GET",
      url: `/api/activities/${journey.activityId}/roster`,
      headers: commandHeaders(organizerToken),
    });
    expect(roster.json()).toMatchObject({ roster: { status: "final", approvedCount: 1 } });

    const registrations = await app.inject({
      method: "GET",
      url: `/api/activities/${journey.activityId}/registrations`,
      headers: commandHeaders(organizerToken),
    });
    expect(registrations.json()).toMatchObject({
      registrations: [
        {
          id: journey.registrationId,
          participantId: journey.participantId,
          status: "approved",
          answers: journey.answers,
        },
      ],
    });
    const live = await app.inject({
      method: "GET",
      url: `/api/activities/${journey.activityId}/live`,
      headers: commandHeaders(organizerToken),
    });
    expect(live.statusCode).toBe(200);
    const liveState = live.json() as { participantNames: Readonly<Record<string, string>> };
    expect(liveState.participantNames[journey.participantId]).toBe(journey.answers.name);
  }

  it("runs the organizer registration journey with consistent read models", async () => {
    await assertRegistrationReadModels(await runJourney("singer-registration-roster.json"));
  }, 60_000);

  it("runs the judge entry to score journey", async () => {
    const journey = await runJourney("singer-judge-score.json");
    await assertRegistrationReadModels(journey);
    expect(journey.judgeCookie).toContain("artflow_judge_session=");

    // The score fact the judge just submitted must be visible through the same
    // context read model the judge page loads, in the running rehearsal mode.
    const context = await app.inject({
      method: "GET",
      url: "/api/judge/context",
      headers: { cookie: journey.judgeCookie },
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      mode: "rehearsal",
      activity: { id: journey.activityId, publicCode: journey.publicCode },
      scoring: { roundKey: "final" },
      existingScore: { total: "270.00" },
    });
  }, 60_000);
});
