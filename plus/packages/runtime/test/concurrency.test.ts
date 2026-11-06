import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  capabilityDefinitionHash,
  competitionCapability,
  createCapabilityRegistry,
  createEmptyCompetitionDefinition,
  DomainError,
} from "@artflow-plus/domain";
import type {
  CapabilityCompiler,
  CapabilityRegistration,
  CapabilityRegistry,
  ExecutionMode,
} from "@artflow-plus/domain";

import {
  activateActivity,
  compileDefinition,
  createActivity,
  getExecutionState,
  releaseDefinitionCommand,
  relayOutboxOnce,
  startExecution,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_concurrency_${Date.now()}_${process.pid}`;

let dbA: Kysely<Database>;
let dbB: Kysely<Database>;
let admin: Client;
let registry: CapabilityRegistry;
let clock = 0;

const deps: RuntimeDeps = {
  now: () => new Date(Date.UTC(2026, 9, 19, 9, 0, 0) + clock++ * 1000).toISOString(),
  newEventId: () => randomUUID(),
};

function probeCapability(): CapabilityRegistration {
  const compiler: CapabilityCompiler = {
    capabilityKey: "probe",
    compile: (definition) => ({
      ok: true,
      capabilityKey: "probe",
      contentHash: capabilityDefinitionHash(definition),
      artifact: definition.payload,
    }),
  };
  return {
    manifest: {
      identity: "probe",
      version: "1",
      dependencies: [],
      conflicts: [],
      definitionSchemaVersion: 1,
      commands: ["probe.record"],
      queries: ["probe.state"],
      events: ["ProbeRecorded"],
      permissions: ["probe.manage"],
      surfaces: ["ops"],
      scopes: ["stage", "rehearsal"],
    },
    compiler,
    emptyDefinition: () => ({ schemaVersion: 1, payload: { schemaVersion: 1 } }),
    scopeConflicts: { stage: ["rehearsal"] },
  };
}

async function releasedActivity(db: Kysely<Database>): Promise<string> {
  const created = await createActivity(db, registry, deps, {
    commandId: `create-${randomUUID()}`,
    title: "Concurrency",
    capabilities: ["competition", "probe"],
  });
  await activateActivity(db, deps, {
    commandId: `activate-${randomUUID()}`,
    activityId: created.body.id,
    expectedRevision: created.body.revision,
  });
  const compiled = await compileDefinition(db, registry, deps, {
    commandId: `compile-${randomUUID()}`,
    activityId: created.body.id,
    package: {
      schemaVersion: 1,
      manifest: { key: "pkg", title: "Concurrency" },
      capabilities: { competition: createEmptyCompetitionDefinition() },
      bindings: [],
    },
  });
  await releaseDefinitionCommand(db, registry, deps, {
    commandId: `release-${randomUUID()}`,
    activityId: created.body.id,
    expectedDraftRevision: compiled.body.draftRevision,
  });
  return created.body.id;
}

function startIn(
  db: Kysely<Database>,
  activityId: string,
  scope: string,
  mode: ExecutionMode,
  commandId = `start-${randomUUID()}`,
) {
  return startExecution(db, registry, deps, {
    commandId,
    activityId,
    scope,
    mode,
  });
}

function rejectionCode(results: PromiseSettledResult<unknown>[]): string | undefined {
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  const reason = rejected?.reason;
  return reason instanceof DomainError ? reason.code : undefined;
}

describe.skipIf(!connectionString)("execution concurrency on PostgreSQL", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    dbA = createDb({ connectionString, schema });
    dbB = createDb({ connectionString, schema });
    await migrate(dbA);
    const result = createCapabilityRegistry([
      competitionCapability,
      probeCapability(),
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    registry = result.registry;
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(dbA);
    await closeDb(dbB);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("lets exactly one of two concurrent starts in the same scope win", async () => {
    const activityId = await releasedActivity(dbA);
    const results = await Promise.allSettled([
      startIn(dbA, activityId, "stage", "formal"),
      startIn(dbB, activityId, "stage", "formal"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rejectionCode(results)).toBe("SCOPE_ALREADY_RUNNING");
  });

  it("lets exactly one of two concurrent conflicting scopes win", async () => {
    const activityId = await releasedActivity(dbA);
    const results = await Promise.allSettled([
      startIn(dbA, activityId, "stage", "formal"),
      startIn(dbB, activityId, "rehearsal", "formal"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rejectionCode(results)).toBe("SCOPE_CONFLICT");
  });

  it("replays a concurrently retried command instead of creating twice", async () => {
    const commandId = `create-${randomUUID()}`;
    const input = {
      commandId,
      title: "Concurrent create",
      capabilities: ["competition", "probe"] as string[],
    };
    const results = await Promise.allSettled([
      createActivity(dbA, registry, deps, input),
      createActivity(dbB, registry, deps, input),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const bodies = results
      .filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createActivity>>> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value);
    expect(new Set(bodies.map((body) => body.body.id)).size).toBe(1);
    expect(bodies.filter((body) => body.replayed)).toHaveLength(1);
    const rows = await dbA
      .selectFrom("activity")
      .selectAll()
      .where("id", "=", bodies[0]?.body.id ?? "")
      .execute();
    expect(rows).toHaveLength(1);
  });

  it("does not corrupt the projection when two relays run at once", async () => {
    const activityId = await releasedActivity(dbA);
    await startIn(dbA, activityId, "stage", "formal");
    await startIn(dbA, activityId, "checkin", "formal");
    await startIn(dbA, activityId, "judging", "formal");

    await Promise.all([relayOutboxOnce(dbA), relayOutboxOnce(dbB)]);
    // Drain any partition the concurrent pass skipped.
    await relayOutboxOnce(dbA);
    await relayOutboxOnce(dbB);

    const state = await getExecutionState(dbA, activityId, "formal");
    expect(state.status).toBe("running");
    expect(state.stale).toBe(false);
    expect(state.runningScopes).toEqual(["checkin", "judging", "stage"]);
    expect(Object.keys(state.sessions)).toHaveLength(3);
  });
});
