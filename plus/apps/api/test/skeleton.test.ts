import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  capabilityDefinitionHash,
  competitionCapability,
  createCapabilityRegistry,
  SINGER_COMPETITION_PACK,
} from "@artflow-plus/domain";
import type {
  ActivityDefinitionPackage,
  CapabilityCompiler,
  CapabilityRegistration,
} from "@artflow-plus/domain";
import {
  rebuildExecutionProjection,
  relayOutboxOnce,
} from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_skeleton_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let registry: ReturnType<typeof skeletonRegistry>;
let clock = 0;

const deps: RuntimeDeps = {
  now: () => new Date(Date.UTC(2026, 9, 19, 12, 0, 0) + clock++ * 1000).toISOString(),
  newEventId: () => randomUUID(),
};

const dbIt = connectionString ? it : it.skip;

function stubCapability(identity: string): CapabilityRegistration {
  const compiler: CapabilityCompiler = {
    capabilityKey: identity,
    compile: (definition) => ({
      ok: true,
      capabilityKey: identity,
      contentHash: capabilityDefinitionHash(definition),
      artifact: definition.payload,
    }),
  };
  return {
    manifest: {
      identity,
      version: "1",
      dependencies: [],
      conflicts: [],
      definitionSchemaVersion: 1,
      commands: [],
      queries: [],
      events: [],
      permissions: [],
      surfaces: ["studio", "ops"],
    },
    compiler,
    emptyDefinition: () => ({ schemaVersion: 1, payload: { schemaVersion: 1 } }),
  };
}

function probeCapability(): CapabilityRegistration {
  const base = stubCapability("probe");
  return {
    ...base,
    manifest: { ...base.manifest, scopes: ["stage", "rehearsal"] },
    scopeConflicts: { stage: ["rehearsal"] },
  };
}

function skeletonRegistry() {
  const registrations = [
    competitionCapability,
    probeCapability(),
    ...[
      "registration",
      "questionnaire",
      "materials",
      "evaluation",
      "voting",
      "publishing",
      "archive",
    ].map(stubCapability),
  ];
  const result = createCapabilityRegistry(registrations);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.registry;
}

function headers() {
  return {
    "idempotency-key": `cmd-${randomUUID()}`,
    "content-type": "application/json",
  };
}

async function post(path: string, payload: object) {
  return await app.inject({
    method: "POST",
    url: path,
    headers: headers(),
    payload,
  });
}

beforeAll(async () => {
  if (!connectionString) return;
  admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  db = createDb({ connectionString, schema });
  await migrate(db);
  registry = skeletonRegistry();
  app = await buildApp({ db, registry, deps, enableRuntimeFacts: true });
  await app.ready();
});

afterAll(async () => {
  if (!connectionString) return;
  await app.close();
  await closeDb(db);
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

dbIt("runs the full skeleton journey on the new architecture", async () => {
  // 1. A pack produces the enabled capability set and a compilable definition.
  const created = await post("/api/activities", {
    title: "2026 院十佳",
    packId: SINGER_COMPETITION_PACK.identity,
    enable: ["probe"],
    answers: { "audience-voting": true },
  });
  expect(created.statusCode).toBe(201);
  const activity = created.json() as {
    id: string;
    revision: number;
    enabledCapabilities: string[];
  };
  expect(activity.enabledCapabilities).toEqual(
    expect.arrayContaining([
      "competition",
      "registration",
      "questionnaire",
      "materials",
      "evaluation",
      "voting",
      "publishing",
      "archive",
      "probe",
    ]),
  );

  const activated = await post(`/api/activities/${activity.id}/activate`, {
    expectedRevision: activity.revision,
  });
  expect(activated.statusCode).toBe(200);

  // 2. The pack's empty definitions compile as-is; no placeholder capability.
  const instantiated = await app.inject({
    method: "POST",
    url: `/api/packs/${SINGER_COMPETITION_PACK.identity}/instantiate`,
    headers: { "content-type": "application/json" },
    payload: {
      title: "2026 院十佳",
      enable: ["probe"],
      answers: { "audience-voting": true },
    },
  });
  expect(instantiated.statusCode).toBe(200);
  const definition = instantiated.json().definition as ActivityDefinitionPackage;
  const compiled = await post(`/api/activities/${activity.id}/definitions/compile`, {
    package: definition,
  });
  expect(compiled.statusCode).toBe(200);
  const released = await post(`/api/activities/${activity.id}/definitions/release`, {
    expectedDraftRevision: compiled.json().draftRevision,
  });
  expect(released.statusCode).toBe(201);
  expect(released.json()).toMatchObject({ version: 1 });

  // 3. Parallel scopes; the probe contributes stage ↔ rehearsal conflict policy.
  const formal = await post(`/api/activities/${activity.id}/executions`, {
    scope: "checkin",
    mode: "formal",
  });
  const rehearsal = await post(`/api/activities/${activity.id}/executions`, {
    scope: "stage",
    mode: "rehearsal",
  });
  expect(formal.statusCode).toBe(201);
  expect(rehearsal.statusCode).toBe(201);
  const conflict = await post(`/api/activities/${activity.id}/executions`, {
    scope: "rehearsal",
    mode: "formal",
  });
  expect(conflict.statusCode).toBe(409);
  // stage(rehearsal) and rehearsal(formal) are declared conflicts; mixing modes
  // is refused with the stricter formal/test code.
  expect(conflict.json()).toMatchObject({ code: "TEST_FORMAL_CONFLICT" });

  // 4. Capability facts flow through the runtime seam with the session's mode.
  const formalFact = await post(`/api/activities/${activity.id}/runtime-facts`, {
    capability: "probe",
    scope: "checkin",
    type: "ProbeRecorded",
    payload: { where: "formal" },
  });
  const rehearsalFact = await post(`/api/activities/${activity.id}/runtime-facts`, {
    capability: "probe",
    scope: "stage",
    type: "ProbeRecorded",
    payload: { where: "rehearsal" },
  });
  expect(formalFact.statusCode).toBe(201);
  expect(rehearsalFact.statusCode).toBe(201);

  await relayOutboxOnce(db);
  const formalState = (
    await app.inject({
      method: "GET",
      url: `/api/activities/${activity.id}/execution-state?mode=formal`,
    })
  ).json() as { sessions: Record<string, { scope: string }> };
  const rehearsalState = (
    await app.inject({
      method: "GET",
      url: `/api/activities/${activity.id}/execution-state?mode=rehearsal`,
    })
  ).json() as { sessions: Record<string, { scope: string }> };
  expect(Object.values(formalState.sessions).map((session) => session.scope)).toEqual([
    "checkin",
  ]);
  expect(Object.values(rehearsalState.sessions).map((session) => session.scope)).toEqual([
    "stage",
  ]);

  const rehearsalEvents = (
    await app.inject({
      method: "GET",
      url: `/api/activities/${activity.id}/events?mode=rehearsal&limit=200`,
    })
  ).json().events as { type: string; mode?: string; payload: { where?: string } }[];
  expect(
    rehearsalEvents.some(
      (event) =>
        event.type === "ProbeRecorded" && event.payload.where === "rehearsal",
    ),
  ).toBe(true);
  expect(
    rehearsalEvents.some(
      (event) => event.type === "ProbeRecorded" && event.payload.where === "formal",
    ),
  ).toBe(false);

  // 5. Recovery: rebuild both projections from the event log and compare.
  await rebuildExecutionProjection(db, activity.id, "formal");
  await rebuildExecutionProjection(db, activity.id, "rehearsal");
  const rebuiltFormal = (
    await app.inject({
      method: "GET",
      url: `/api/activities/${activity.id}/execution-state?mode=formal`,
    })
  ).json();
  expect(rebuiltFormal).toEqual(formalState);

  // 6. Restart: a new app instance reads the same durable state.
  const restarted = await buildApp({
    db,
    registry,
    deps,
    enableRuntimeFacts: true,
  });
  try {
    const sessions = (
      await restarted.inject({
        method: "GET",
        url: `/api/activities/${activity.id}/executions`,
      })
    ).json().sessions as { scope: string; mode: string; status: string }[];
    expect(sessions.map((session) => `${session.scope}:${session.mode}`)).toEqual([
      "checkin:formal",
      "stage:rehearsal",
    ]);
    const recoveredActivity = (
      await restarted.inject({
        method: "GET",
        url: `/api/activities/${activity.id}`,
      })
    ).json();
    expect(recoveredActivity).toMatchObject({
      status: "active",
      activeDefinitionVersion: 1,
    });

    // A cursor-based client recovers from the same authoritative event log.
    const feed = (
      await restarted.inject({
        method: "GET",
        url: `/api/activities/${activity.id}/events?mode=formal&limit=200`,
      })
    ).json();
    expect(feed.nextCursor).toBeGreaterThan(0);
    const resumed = (
      await restarted.inject({
        method: "GET",
        url: `/api/activities/${activity.id}/events?mode=formal&after=${feed.nextCursor}`,
      })
    ).json();
    expect(resumed.events).toHaveLength(0);
  } finally {
    await restarted.close();
  }
});
