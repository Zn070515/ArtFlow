import { randomUUID } from "node:crypto";

import {
  CapabilityManifestSchema,
  JudgeEntryBodySchema,
  PackInstantiateBodySchema,
  SubmitBallotBodySchema,
} from "@artflow-plus/contracts";
import { closeDb, createDb, insertLocalAccount, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  capabilityDefinitionHash,
  createCapabilityRegistry,
  createCompetitionDefinition,
  createEmptyCompetitionDefinition,
  SINGER_COMPETITION_PACK,
} from "@artflow-plus/domain";
import type {
  CapabilityCompiler,
  CapabilityRegistration,
} from "@artflow-plus/domain";
import { hashPassword, relayOutboxOnce } from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let clock = 0;

const dbIt = connectionString ? it : it.skip;

const deps: RuntimeDeps = {
  now: () => new Date(Date.UTC(2026, 9, 19, 10, 0, 0) + clock++ * 1000).toISOString(),
  newEventId: () => randomUUID(),
};

const headers = (id = `cmd-${randomUUID()}`) => ({
  "idempotency-key": id,
  "content-type": "application/json",
});

let studioToken = "";

const studioHeaders = (id = `cmd-${randomUUID()}`) => ({
  ...headers(id),
  authorization: `Bearer ${studioToken}`,
});

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
      surfaces: ["studio"],
    },
    compiler,
    emptyDefinition: () => ({ schemaVersion: 1, payload: { schemaVersion: 1 } }),
  };
}

function competitionPackage() {
  return {
    schemaVersion: 1,
    manifest: { key: "pkg-2026", title: "2026 院十佳" },
    capabilities: {
      competition: createCompetitionDefinition(
        [
          { key: "roster", type: "roster" },
          { key: "round1", type: "round" },
          { key: "result", type: "output" },
        ],
        [
          { from: "roster", to: "round1" },
          { from: "round1", to: "result" },
        ],
      ),
    },
    bindings: [],
  };
}

async function createActivity(capabilities: string[] = ["competition"]) {
  const response = await app.inject({
    method: "POST",
    url: "/api/activities",
    headers: studioHeaders(),
    payload: { title: "2026 院十佳", capabilities },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as {
    id: string;
    status: string;
    revision: number;
    enabledCapabilities: string[];
  };
}

async function createReleasedActivity(): Promise<string> {
  const created = await createActivity();
  const activated = await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/activate`,
    headers: studioHeaders(),
    payload: { expectedRevision: created.revision },
  });
  expect(activated.statusCode).toBe(200);

  const compiled = await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/definitions/compile`,
    headers: studioHeaders(),
    payload: {
      package: {
        schemaVersion: 1,
        manifest: { key: "pkg-2026", title: "2026 院十佳" },
        capabilities: { competition: createEmptyCompetitionDefinition() },
        bindings: [],
      },
    },
  });
  expect(compiled.statusCode).toBe(200);
  const released = await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/definitions/release`,
    headers: studioHeaders(),
    payload: { expectedDraftRevision: compiled.json().draftRevision },
  });
  expect(released.statusCode).toBe(201);
  return created.id;
}

async function startSession(
  activityId: string,
  scope: string,
  mode: "test" | "rehearsal" | "formal",
) {
  return app.inject({
    method: "POST",
    url: `/api/activities/${activityId}/executions`,
    headers: studioHeaders(),
    payload: { scope, mode },
  });
}

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
    username: "http-studio",
    passwordDigest: hashPassword("studio-password"),
    actor: {
      actorId: "http-studio",
      actorType: "user",
      roles: ["staff"],
      permissions: ["studio.manage"],
    },
    active: true,
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/token",
    headers: { "content-type": "application/json" },
    payload: { username: "http-studio", password: "studio-password" },
  });
  studioToken = login.json().token as string;
});

afterAll(async () => {
  if (!connectionString) return;
  await app.close();
  await closeDb(db);
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

dbIt("serves health and readiness", async () => {
  expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({
    status: "ok",
  });
  expect((await app.inject({ method: "GET", url: "/readyz" })).json()).toEqual({
    status: "ok",
  });
});

dbIt("requires an idempotency key", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/activities",
    payload: { title: "no key" },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: "INVALID_INPUT" });
});

dbIt("uses local bearer sessions for registration routes", async () => {
  const unauthenticated = await app.inject({
    method: "POST",
    url: "/api/activities/not-real/registrations",
    headers: { "content-type": "application/json", "idempotency-key": "m4-auth-missing" },
    payload: {},
  });
  expect(unauthenticated.statusCode).toBe(401);
  expect(unauthenticated.json()).toMatchObject({ code: "UNAUTHENTICATED" });

  const username = `m4-${randomUUID()}`;
  await insertLocalAccount(db, {
    username,
    passwordDigest: hashPassword("m4-password"),
    actor: {
      actorId: "http-student",
      actorType: "user",
      roles: ["participant"],
      permissions: [],
    },
    active: true,
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/token",
    headers: { "content-type": "application/json" },
    payload: { username, password: "m4-password" },
  });
  expect(login.statusCode).toBe(200);
  expect(login.json().token).toEqual(expect.any(String));

  const authenticated = await app.inject({
    method: "POST",
    url: "/api/activities/not-real/registrations",
    headers: {
      ...headers("m4-auth-present"),
      authorization: `Bearer ${login.json().token}`,
    },
    payload: {},
  });
  expect(authenticated.statusCode).toBe(404);
  expect(authenticated.json()).toMatchObject({ code: "NOT_FOUND" });
});

dbIt("creates, replays and activates an activity", async () => {
  const commandId = `cmd-${randomUUID()}`;
  const created = await app.inject({
    method: "POST",
    url: "/api/activities",
    headers: studioHeaders(commandId),
    payload: { title: "Replay", capabilities: ["competition"] },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ status: "draft", revision: 0 });

  const replay = await app.inject({
    method: "POST",
    url: "/api/activities",
    headers: studioHeaders(commandId),
    payload: { title: "Replay", capabilities: ["competition"] },
  });
  expect(replay.statusCode).toBe(201);
  expect(replay.json().id).toBe(created.json().id);

  const conflict = await app.inject({
    method: "POST",
    url: "/api/activities",
    headers: studioHeaders(commandId),
    payload: { title: "Different", capabilities: ["competition"] },
  });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json()).toMatchObject({ code: "COMMAND_ID_CONFLICT" });

  const activated = await app.inject({
    method: "POST",
    url: `/api/activities/${created.json().id}/activate`,
    headers: studioHeaders(),
    payload: { expectedRevision: created.json().revision },
  });
  expect(activated.statusCode).toBe(200);
  expect(activated.json()).toMatchObject({ status: "active", revision: 1 });

  const anonymousRead = await app.inject({
    method: "GET",
    url: `/api/activities/${created.json().id}`,
  });
  expect(anonymousRead.statusCode).toBe(401);
  const read = await app.inject({
    method: "GET",
    url: `/api/activities/${created.json().id}`,
    headers: studioHeaders(),
  });
  expect(read.json()).toMatchObject({ status: "active", revision: 1 });
});

dbIt("rejects an invalid definition package with stable diagnostics", async () => {
  const created = await createActivity();
  const invalid = {
    ...competitionPackage(),
    capabilities: {
      competition: createCompetitionDefinition(
        [
          { key: "roster", type: "roster" },
          { key: "a", type: "round" },
          { key: "b", type: "round" },
          { key: "out", type: "output" },
        ],
        [
          { from: "roster", to: "a" },
          { from: "a", to: "b" },
          { from: "b", to: "a" },
          { from: "b", to: "out" },
        ],
      ),
    },
  };
  const response = await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/definitions/compile`,
    headers: studioHeaders(),
    payload: { package: invalid },
  });
  expect(response.statusCode).toBe(422);
  const body = response.json();
  expect(body.code).toBe("DEFINITION_INVALID");
  expect(Array.isArray(body.details)).toBe(true);
  expect(body.details.some((item: { code: string }) => item.code === "CAPABILITY_CYCLE")).toBe(
    true,
  );
});

dbIt("compiles, rejects a stale release, then releases the current package", async () => {
  const created = await createActivity();
  await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/activate`,
    headers: studioHeaders(),
    payload: { expectedRevision: created.revision },
  });
  const compiled = await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/definitions/compile`,
    headers: studioHeaders(),
    payload: { package: competitionPackage() },
  });
  expect(compiled.statusCode).toBe(200);
  expect(compiled.json()).toMatchObject({ capabilities: ["competition"] });

  const stale = await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/definitions/release`,
    headers: studioHeaders(),
    payload: { expectedDraftRevision: 0 },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ code: "STALE_REVISION" });

  const released = await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/definitions/release`,
    headers: studioHeaders(),
    payload: { expectedDraftRevision: compiled.json().draftRevision },
  });
  expect(released.statusCode).toBe(201);
  expect(released.json()).toMatchObject({
    activityId: created.id,
    version: 1,
    contentHash: compiled.json().contentHash,
  });
});

dbIt("refuses to release before compilation", async () => {
  const created = await createActivity();
  const response = await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/definitions/release`,
    headers: studioHeaders(),
    payload: { expectedDraftRevision: 0 },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ code: "DEFINITION_NOT_COMPILED" });
});

dbIt("lists the registered capabilities using the shared manifest contract", async () => {
  const response = await app.inject({ method: "GET", url: "/api/capabilities" });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { capabilities: unknown[] };
  expect(body.capabilities).toHaveLength(9);
  expect(Value.Check(CapabilityManifestSchema, body.capabilities[0])).toBe(true);
  expect((body.capabilities as { identity: string }[]).map((item) => item.identity)).toEqual([
    "archive",
    "competition",
    "grouping",
    "materials",
    "publishing",
    "questionnaire",
    "registration",
    "ticketing",
    "voting",
  ]);
});

dbIt("lists activity packs and explains missing capabilities", async () => {
  const packs = await app.inject({ method: "GET", url: "/api/packs" });
  const identities = (packs.json() as { packs: { identity: string }[] }).packs.map(
    (pack) => pack.identity,
  );
  expect(identities).toContain(SINGER_COMPETITION_PACK.identity);

  const response = await app.inject({
    method: "POST",
    url: "/api/packs/singer-competition/instantiate",
    headers: { "content-type": "application/json" },
    payload: { enable: ["not-a-capability"] },
  });
  expect(response.statusCode).toBe(422);
  expect(response.json().code).toBe("PACK_COMPOSITION_INVALID");
  expect(
    response
      .json()
      .details.some((item: { code: string }) => item.code === "CAPABILITY_UNKNOWN"),
  ).toBe(true);
});

dbIt("instantiates a pack once every capability is registered", async () => {
  const identities = [
    "competition",
    "grouping",
    "registration",
    "questionnaire",
    "materials",
    "voting",
    "publishing",
    "archive",
  ];
  const registry = createCapabilityRegistry(identities.map(stubCapability));
  expect(registry.ok).toBe(true);
  if (!registry.ok) return;
  const complete = await buildApp({ db, registry: registry.registry, deps });
  try {
    const response = await complete.inject({
      method: "POST",
      url: "/api/packs/singer-competition/instantiate",
      headers: { "content-type": "application/json" },
      payload: {
        title: "2026 院十佳",
        answers: { "audience-voting": true },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      enabledCapabilities: string[];
      definition: { manifest: { title: string } };
    };
    expect(body.enabledCapabilities).toContain("voting");
    expect(body.definition.manifest.title).toBe("2026 院十佳");
  } finally {
    await complete.close();
  }
});

dbIt("keeps the pack instantiation body contract in sync with the API", () => {
  expect(
    Value.Check(PackInstantiateBodySchema, {
      answers: { "audience-voting": true },
      disable: ["materials"],
    }),
  ).toBe(true);
  expect(Value.Check(JudgeEntryBodySchema, { publicCode: "ABC123", capability: null })).toBe(true);
  expect(Value.Check(SubmitBallotBodySchema, {
    scope: "voting",
    optionIds: ["option-1"],
    identity: { type: "browser" },
  })).toBe(true);
  expect(Value.Check(SubmitBallotBodySchema, {
    scope: "voting",
    optionIds: ["option-1"],
    identity: { type: "browser", fingerprint: "raw-client-id" },
  })).toBe(false);
  expect(Value.Check(SubmitBallotBodySchema, {
    scope: "voting",
    optionIds: ["option-1"],
    identity: { type: "ticket" },
  })).toBe(true);
  expect(Value.Check(SubmitBallotBodySchema, {
    scope: "voting",
    optionIds: ["option-1"],
    identity: { type: "ticket", credential: "raw-ticket" },
  })).toBe(false);
});

dbIt("uses a process-local judge-entry rate-limit bucket keyed by IP", async () => {
  const keys: string[] = [];
  const limited = await buildApp({
    db,
    deps,
    rateLimiter: { allow: ({ key }) => { keys.push(key); return true; } },
  });
  try {
    for (const [index, publicCode] of ["guess-a", "guess-b"].entries()) {
      const response = await limited.inject({
        method: "POST",
        url: "/api/judge-entry/claim",
        headers: headers(`judge-rate-${index}`),
        payload: { publicCode, capability: null },
      });
      expect(response.statusCode).toBeLessThan(500);
    }
    expect(keys).toEqual(["judge-entry:127.0.0.1", "judge-entry:127.0.0.1"]);
  } finally {
    await limited.close();
  }
});

dbIt("starts parallel scopes, lists them and closes with OCC", async () => {
  const activityId = await createReleasedActivity();
  const rehearsal = await startSession(activityId, "stage", "rehearsal");
  expect(rehearsal.statusCode).toBe(201);
  const formal = await startSession(activityId, "checkin", "formal");
  expect(formal.statusCode).toBe(201);
  expect(formal.json()).toMatchObject({ status: "running", revision: 0 });

  const list = await app.inject({
    method: "GET",
    url: `/api/activities/${activityId}/executions`,
    headers: studioHeaders(),
  });
  expect(list.json().sessions).toHaveLength(2);

  const closed = await app.inject({
    method: "POST",
    url: `/api/activities/${activityId}/executions/${rehearsal.json().id}/close`,
    headers: studioHeaders(),
    payload: { expectedRevision: 0 },
  });
  expect(closed.statusCode).toBe(200);
  expect(closed.json()).toMatchObject({ status: "closed", revision: 1 });
});

dbIt("enforces scope conflicts at the HTTP edge", async () => {
  const activityId = await createReleasedActivity();
  await startSession(activityId, "stage", "formal");
  const conflict = await startSession(activityId, "stage", "rehearsal");
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json()).toMatchObject({ code: "SCOPE_ALREADY_RUNNING" });
});

dbIt("projects execution state and serves the event cursor", async () => {
  const activityId = await createReleasedActivity();
  await startSession(activityId, "stage", "formal");
  await relayOutboxOnce(db);

  const state = await app.inject({
    method: "GET",
    url: `/api/activities/${activityId}/execution-state?mode=formal`,
    headers: studioHeaders(),
  });
  expect(state.statusCode).toBe(200);
  expect(state.json()).toMatchObject({ mode: "formal", stale: false });
  expect(Object.values(state.json().sessions)).toHaveLength(1);

  const feed = await app.inject({
    method: "GET",
    url: `/api/activities/${activityId}/events?mode=formal&limit=100`,
    headers: studioHeaders(),
  });
  expect(feed.statusCode).toBe(200);
  expect(
    feed
      .json()
      .events.some(
        (event: { type: string }) => event.type === "ExecutionSessionStarted",
      ),
  ).toBe(true);

  const resumed = await app.inject({
    method: "GET",
    url: `/api/activities/${activityId}/events?mode=formal&after=${feed.json().nextCursor}`,
    headers: studioHeaders(),
  });
  expect(resumed.json().events).toHaveLength(0);
});

dbIt("accepts capability facts through the runtime seam", async () => {
  const activityId = await createReleasedActivity();
  await startSession(activityId, "stage", "formal");
  const fact = await app.inject({
    method: "POST",
    url: `/api/activities/${activityId}/runtime-facts`,
    headers: headers(),
    payload: {
      capability: "competition",
      scope: "stage",
      type: "ProbeRecorded",
      payload: { value: 1 },
    },
  });
  expect(fact.statusCode).toBe(201);
  await relayOutboxOnce(db);
  const feed = await app.inject({
    method: "GET",
    url: `/api/activities/${activityId}/events?mode=formal`,
    headers: studioHeaders(),
  });
  expect(
    feed.json().events.some((event: { type: string }) => event.type === "ProbeRecorded"),
  ).toBe(true);
});

dbIt("reports not-ready when PostgreSQL is unreachable", async () => {
  const broken = createDb({
    connectionString: "postgresql://artflow:artflow_dev@127.0.0.1:5499/artflow_plus",
    connectionTimeoutMillis: 500,
  });
  const brokenApp = await buildApp({ db: broken });
  try {
    const response = await brokenApp.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
  } finally {
    await brokenApp.close();
    await closeDb(broken);
  }
});

dbIt("records the injected actor in the receipt and audit log", async () => {
  const audited = await buildApp({
    db,
    deps,
    actor: {
      actorId: "alice",
      actorType: "user",
      roles: ["staff"],
      permissions: ["*"],
    },
  });
  try {
    const commandId = `cmd-${randomUUID()}`;
    const response = await audited.inject({
      method: "POST",
      url: "/api/activities",
      headers: headers(commandId),
      payload: { title: "Audited", capabilities: ["competition"] },
    });
    expect(response.statusCode).toBe(201);
    const receipt = await db
      .selectFrom("command_receipt")
      .selectAll()
      .where("command_id", "=", commandId)
      .executeTakeFirstOrThrow();
    expect(receipt).toMatchObject({ actor_id: "alice", actor_type: "user" });
    const audit = await db
      .selectFrom("audit_entry")
      .selectAll()
      .where("command_id", "=", commandId)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: "alice", capability: "engine" });
  } finally {
    await audited.close();
  }
});

dbIt("publishes the OpenAPI document", async () => {
  const response = await app.inject({ method: "GET", url: "/openapi.json" });
  expect(response.statusCode).toBe(200);
  expect(response.json().openapi).toBeDefined();
});
