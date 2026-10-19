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
  ExecutionMode,
} from "@artflow-plus/domain";

import {
  activateActivity,
  appendRuntimeFact,
  closeExecution,
  compileDefinition,
  createActivity,
  defaultRuntimeDeps,
  getExecutionState,
  listEvents,
  listExecutions,
  rebuildExecutionProjection,
  releaseDefinitionCommand,
  relayOutboxOnce,
  startExecution,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_runtime_test_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let registry: ReturnType<typeof singerRegistry>;
let deps: RuntimeDeps;
let clock = 0;

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
    },
    compiler,
    emptyDefinition: () => ({ schemaVersion: 1, payload: { schemaVersion: 1 } }),
    scopeConflicts: { stage: ["rehearsal"] },
  };
}

function singerRegistry() {
  const result = createCapabilityRegistry([competitionCapability, probeCapability()]);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.registry;
}

async function createReleasedActivity(): Promise<string> {
  const created = await createActivity(db, registry, deps, {
    commandId: `create-${randomUUID()}`,
    title: "2026 院十佳",
    capabilities: ["competition", "probe"],
  });
  const activityId = created.body.id;
  await activateActivity(db, deps, {
    commandId: `activate-${randomUUID()}`,
    activityId,
    expectedRevision: created.body.revision,
  });
  const compiled = await compileDefinition(db, registry, deps, {
    commandId: `compile-${randomUUID()}`,
    activityId,
    package: {
      schemaVersion: 1,
      manifest: { key: "pkg", title: "2026 院十佳" },
      capabilities: { competition: createEmptyCompetitionDefinition() },
      bindings: [],
    },
  });
  await releaseDefinitionCommand(db, deps, {
    commandId: `release-${randomUUID()}`,
    activityId,
    expectedDraftRevision: compiled.body.draftRevision,
  });
  return activityId;
}

async function start(
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

describe.skipIf(!connectionString)("execution runtime on PostgreSQL", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    registry = singerRegistry();
    deps = {
      now: () => `2026-10-19T10:00:${String(clock++).padStart(2, "0")}Z`,
      newEventId: () => randomUUID(),
    };
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("runs draft → compile → release and replays an identical command", async () => {
    const commandId = `create-${randomUUID()}`;
    const first = await createActivity(db, registry, deps, {
      commandId,
      title: "Replay",
      capabilities: ["competition"],
    });
    const replay = await createActivity(db, registry, deps, {
      commandId,
      title: "Replay",
      capabilities: ["competition"],
    });
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe(201);

    await expect(
      createActivity(db, registry, deps, {
        commandId,
        title: "Different",
        capabilities: ["competition"],
      }),
    ).rejects.toMatchObject({ code: "COMMAND_ID_CONFLICT" });
  });

  it("rejects an uncompiled draft at release", async () => {
    const created = await createActivity(db, registry, deps, {
      commandId: `create-${randomUUID()}`,
      title: "Uncompiled",
      capabilities: ["competition"],
    });
    await activateActivity(db, deps, {
      commandId: `activate-${randomUUID()}`,
      activityId: created.body.id,
      expectedRevision: 0,
    });
    await expect(
      releaseDefinitionCommand(db, deps, {
        commandId: `release-${randomUUID()}`,
        activityId: created.body.id,
        expectedDraftRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "DEFINITION_NOT_COMPILED" });
  });

  it("starts non-conflicting scopes in parallel and closes with OCC", async () => {
    const activityId = await createReleasedActivity();
    const formal = await start(activityId, "checkin", "formal");
    const rehearsal = await start(activityId, "stage", "rehearsal");
    expect(formal.status).toBe(201);
    expect(rehearsal.status).toBe(201);
    expect(await listExecutions(db, activityId)).toHaveLength(2);

    const closed = await closeExecution(db, deps, {
      commandId: `close-${randomUUID()}`,
      activityId,
      sessionId: formal.body.id,
      expectedRevision: 0,
    });
    expect(closed.body.status).toBe("closed");
    expect(closed.body.revision).toBe(1);
    await expect(
      closeExecution(db, deps, {
        commandId: `close-${randomUUID()}`,
        activityId,
        sessionId: formal.body.id,
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("enforces declared scope conflicts and formal/test isolation", async () => {
    const activityId = await createReleasedActivity();
    await start(activityId, "stage", "formal");
    await expect(start(activityId, "rehearsal", "formal")).rejects.toMatchObject({
      code: "SCOPE_CONFLICT",
    });
    await expect(start(activityId, "rehearsal", "rehearsal")).rejects.toMatchObject({
      code: "TEST_FORMAL_CONFLICT",
    });
  });

  it("projects execution events and keeps test and formal feeds apart", async () => {
    const activityId = await createReleasedActivity();
    await start(activityId, "stage", "formal");
    await start(activityId, "checkin", "test");
    await appendRuntimeFact(db, registry, deps, {
      commandId: `fact-${randomUUID()}`,
      activityId,
      capability: "probe",
      scope: "stage",
      type: "ProbeRecorded",
      payload: { value: "formal" },
    });
    await appendRuntimeFact(db, registry, deps, {
      commandId: `fact-${randomUUID()}`,
      activityId,
      capability: "probe",
      scope: "checkin",
      type: "ProbeRecorded",
      payload: { value: "test" },
    });

    const relay = await relayOutboxOnce(db);
    expect(relay.failed).toBe(0);
    expect(relay.applied).toBeGreaterThan(0);

    const formalState = await getExecutionState(db, activityId, "formal");
    const testState = await getExecutionState(db, activityId, "test");
    expect(Object.values(formalState.sessions).map((session) => session.scope)).toEqual([
      "stage",
    ]);
    expect(Object.values(testState.sessions).map((session) => session.scope)).toEqual([
      "checkin",
    ]);
    expect(formalState.stale).toBe(false);

    const formalEvents = await listEvents(db, {
      activityId,
      after: 0,
      limit: 100,
      mode: "formal",
    });
    expect(
      formalEvents.events.some(
        (event) =>
          event.type === "ExecutionSessionStarted" && event.scope === "checkin",
      ),
    ).toBe(false);
    expect(
      formalEvents.events.some(
        (event) => event.type === "ProbeRecorded" && event.mode === "formal",
      ),
    ).toBe(true);
    expect(
      formalEvents.events.some(
        (event) => event.type === "ProbeRecorded" && event.mode === "test",
      ),
    ).toBe(false);
  });

  it("rebuilds a projection from the event log", async () => {
    const activityId = await createReleasedActivity();
    await start(activityId, "stage", "formal");
    await relayOutboxOnce(db);
    const before = await getExecutionState(db, activityId, "formal");
    const rebuilt = await rebuildExecutionProjection(db, activityId, "formal");
    const after = await getExecutionState(db, activityId, "formal");
    expect(after).toEqual(before);
    expect(rebuilt.lastSequence).toBe(before.lastSequence);
  });

  it("recovers from a cursor after a simulated disconnect", async () => {
    const activityId = await createReleasedActivity();
    await start(activityId, "stage", "formal");
    const firstPage = await listEvents(db, {
      activityId,
      after: 0,
      limit: 1,
      mode: "formal",
    });
    expect(firstPage.events).toHaveLength(1);
    const resumed = await listEvents(db, {
      activityId,
      after: firstPage.nextCursor,
      limit: 100,
      mode: "formal",
    });
    expect(resumed.events.every((event) => event.sequence > firstPage.nextCursor)).toBe(
      true,
    );
    expect(resumed.headCursor).toBeGreaterThanOrEqual(firstPage.nextCursor);
  });
});
