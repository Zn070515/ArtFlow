import {
  CapabilityManifestSchema,
  PackInstantiateBodySchema,
} from "@artflow-plus/contracts";
import {
  capabilityDefinitionHash,
  createCapabilityRegistry,
  createCompetitionDefinition,
  SINGER_COMPETITION_PACK,
} from "@artflow-plus/domain";
import type {
  CapabilityCompiler,
  CapabilityRegistration,
} from "@artflow-plus/domain";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

let app: FastifyInstance;

const headers = (id: string) => ({
  "idempotency-key": id,
  "content-type": "application/json",
});

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

async function createActivity(): Promise<{ id: string; revision: number }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/activities",
    headers: headers("create-1"),
    payload: { title: "2026 院十佳", capabilities: ["competition"] },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

beforeAll(async () => {
  app = await buildApp({ now: () => "2026-10-19T10:00:00Z" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

it("serves health and readiness", async () => {
  expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({
    status: "ok",
  });
  expect((await app.inject({ method: "GET", url: "/readyz" })).json()).toEqual({
    status: "ok",
  });
});

it("requires an idempotency key", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/activities",
    payload: { title: "no key" },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: "INVALID_INPUT" });
});

it("creates and activates an activity", async () => {
  const created = await createActivity();
  expect(created).toMatchObject({ status: "draft", revision: 0 });
  const activated = await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/activate`,
    headers: headers("activate-1"),
    payload: { expectedRevision: created.revision },
  });
  expect(activated.statusCode).toBe(200);
  expect(activated.json()).toMatchObject({ status: "active", revision: 1 });
});

it("rejects an invalid definition package with stable diagnostics", async () => {
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
    headers: headers("compile-invalid"),
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

it("compiles, rejects a stale release, then releases the current package", async () => {
  const created = await createActivity();
  await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/activate`,
    headers: headers("activate-2"),
    payload: { expectedRevision: created.revision },
  });
  const compiled = await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/definitions/compile`,
    headers: headers("compile-1"),
    payload: { package: competitionPackage() },
  });
  expect(compiled.statusCode).toBe(200);
  expect(compiled.json()).toMatchObject({ capabilities: ["competition"] });

  const stale = await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/definitions/release`,
    headers: headers("release-stale"),
    payload: { expectedDraftRevision: 0 },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ code: "STALE_REVISION" });

  const released = await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/definitions/release`,
    headers: headers("release-1"),
    payload: { expectedDraftRevision: 1 },
  });
  expect(released.statusCode).toBe(201);
  expect(released.json()).toMatchObject({
    activityId: created.id,
    version: 1,
    contentHash: compiled.json().contentHash,
  });
});

it("refuses to release before compilation", async () => {
  const created = await createActivity();
  const response = await app.inject({
    method: "POST",
    url: `/api/activities/${created.id}/definitions/release`,
    headers: headers("release-none"),
    payload: { expectedDraftRevision: 0 },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ code: "DEFINITION_NOT_COMPILED" });
});

it("publishes the OpenAPI document", async () => {
  const response = await app.inject({ method: "GET", url: "/openapi.json" });
  expect(response.statusCode).toBe(200);
  expect(response.json().openapi).toBeDefined();
});

it("lists the registered capabilities using the shared manifest contract", async () => {
  const response = await app.inject({ method: "GET", url: "/api/capabilities" });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { capabilities: unknown[] };
  expect(body.capabilities).toHaveLength(1);
  expect(Value.Check(CapabilityManifestSchema, body.capabilities[0])).toBe(true);
  expect(body.capabilities[0]).toMatchObject({ identity: "competition" });
});

it("lists activity packs", async () => {
  const response = await app.inject({ method: "GET", url: "/api/packs" });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { packs: { identity: string }[] };
  expect(body.packs.map((pack) => pack.identity)).toContain(SINGER_COMPETITION_PACK.identity);
});

it("explains which pack capabilities are not implemented yet", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/packs/singer-competition/instantiate",
    headers: { "content-type": "application/json" },
    payload: {},
  });
  expect(response.statusCode).toBe(422);
  const body = response.json();
  expect(body.code).toBe("PACK_COMPOSITION_INVALID");
  expect(body.details.some((item: { code: string }) => item.code === "CAPABILITY_UNKNOWN")).toBe(
    true,
  );
});

it("rejects an unknown pack", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/packs/not-a-pack/instantiate",
    headers: { "content-type": "application/json" },
    payload: {},
  });
  expect(response.statusCode).toBe(404);
  expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
});

it("instantiates a pack once every capability is registered", async () => {
  const identities = [
    "competition",
    "registration",
    "questionnaire",
    "materials",
    "evaluation",
    "voting",
    "publishing",
    "archive",
  ];
  const registry = createCapabilityRegistry(identities.map(stubCapability));
  expect(registry.ok).toBe(true);
  if (!registry.ok) return;
  const complete = await buildApp({ registry: registry.registry });
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
      definition: { manifest: { title: string }; capabilities: Record<string, unknown> };
    };
    expect(body.enabledCapabilities).toContain("voting");
    expect(body.definition.manifest.title).toBe("2026 院十佳");
    expect(Object.keys(body.definition.capabilities).sort()).toEqual(
      body.enabledCapabilities.slice().sort(),
    );
  } finally {
    await complete.close();
  }
});

it("keeps the pack instantiation body contract in sync with the API", () => {
  expect(
    Value.Check(PackInstantiateBodySchema, {
      answers: { "audience-voting": true },
      disable: ["materials"],
    }),
  ).toBe(true);
});
