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

function probeCapability(
  options: {
    version?: string;
    stageConflicts?: readonly string[];
    compiler?: CapabilityCompiler;
  } = {},
): CapabilityRegistration {
  const compiler: CapabilityCompiler = options.compiler ?? {
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
      version: options.version ?? "1",
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
    scopeConflicts: { stage: options.stageConflicts ?? ["rehearsal"] },
  };
}

function singerRegistry(
  options: Parameters<typeof probeCapability>[0] = {},
): CapabilityRegistry {
  const result = createCapabilityRegistry([
    competitionCapability,
    probeCapability(options),
  ]);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.registry;
}

async function createReleasedActivity(
  sourceRegistry: CapabilityRegistry = registry,
): Promise<string> {
  const created = await createActivity(db, sourceRegistry, deps, {
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
  const compiled = await compileDefinition(db, sourceRegistry, deps, {
    commandId: `compile-${randomUUID()}`,
    activityId,
    package: {
      schemaVersion: 1,
      manifest: { key: "pkg", title: "2026 院十佳" },
      capabilities: { competition: createEmptyCompetitionDefinition() },
      bindings: [],
    },
  });
  await releaseDefinitionCommand(db, sourceRegistry, deps, {
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
  sourceRegistry: CapabilityRegistry = registry,
) {
  return startExecution(db, sourceRegistry, deps, {
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
      now: () =>
        new Date(Date.UTC(2026, 9, 19, 10, 0, 0) + clock++ * 1000).toISOString(),
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
      releaseDefinitionCommand(db, registry, deps, {
        commandId: `release-${randomUUID()}`,
        activityId: created.body.id,
        expectedDraftRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "DEFINITION_NOT_COMPILED" });
  });

  it("does not release a new definition while an execution session is running", async () => {
    const activityId = await createReleasedActivity();
    await start(activityId, "stage", "formal");
    const compiled = await compileDefinition(db, registry, deps, {
      commandId: `compile-running-${randomUUID()}`,
      activityId,
      expectedDraftRevision: 1,
      package: {
        schemaVersion: 1,
        manifest: { key: "pkg-running", title: "running" },
        capabilities: { competition: createEmptyCompetitionDefinition() },
        bindings: [],
      },
    });
    await expect(releaseDefinitionCommand(db, registry, deps, {
      commandId: `release-running-${randomUUID()}`,
      activityId,
      expectedDraftRevision: compiled.body.draftRevision,
    })).rejects.toMatchObject({ code: "ACTIVITY_HAS_RUNNING_SESSIONS" });
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

  it("uses the frozen release policy, not the current registry policy", async () => {
    const activityId = await createReleasedActivity();
    const changedPolicy = singerRegistry({ stageConflicts: ["checkin"] });
    await start(activityId, "stage", "formal", undefined, changedPolicy);
    // The release froze stage <-> rehearsal; the changed registry says
    // stage <-> checkin. The frozen policy wins.
    await expect(
      start(activityId, "rehearsal", "formal", undefined, changedPolicy),
    ).rejects.toMatchObject({ code: "SCOPE_CONFLICT" });

    const second = await createReleasedActivity();
    await start(second, "checkin", "formal", undefined, changedPolicy);
    const stage = await start(second, "stage", "formal", undefined, changedPolicy);
    expect(stage.status).toBe(201);
  });

  it("refuses a release whose capability versions do not match the runtime", async () => {
    const activityId = await createReleasedActivity();
    const newer = singerRegistry({ version: "2" });
    await expect(
      start(activityId, "stage", "formal", undefined, newer),
    ).rejects.toMatchObject({ code: "CAPABILITY_VERSION_MISMATCH" });
  });

  it("refuses a scope the release did not declare", async () => {
    const activityId = await createReleasedActivity();
    await expect(start(activityId, "backstage", "formal")).rejects.toMatchObject({
      code: "SCOPE_UNDECLARED",
    });
  });

  it("derives conflicts for a release backfilled by migration 0003", async () => {
    const activityId = await createReleasedActivity();
    // Simulate the empty snapshot migration 0003 backfills for older releases.
    await db
      .updateTable("definition_release")
      .set({
        execution_policy: JSON.stringify({
          declaredScopes: [],
          conflicts: {},
          runtimeContractVersion: 1,
        }),
        capability_versions: JSON.stringify({}),
      })
      .where("activity_id", "=", activityId)
      .execute();
    await start(activityId, "stage", "formal");
    await expect(start(activityId, "rehearsal", "formal")).rejects.toMatchObject({
      code: "SCOPE_CONFLICT",
    });
  });

  it("refuses to replay a command id claimed by another actor", async () => {
    const commandId = `create-${randomUUID()}`;
    await createActivity(db, registry, deps, {
      commandId,
      title: "Actor bound",
      capabilities: ["competition"],
    });
    const otherActor: RuntimeDeps = {
      ...deps,
      actor: {
        actorId: "mallory",
        actorType: "user",
        roles: [],
        permissions: [],
      },
    };
    await expect(
      createActivity(db, registry, otherActor, {
        commandId,
        title: "Actor bound",
        capabilities: ["competition"],
      }),
    ).rejects.toMatchObject({ code: "COMMAND_ID_CONFLICT" });
  });

  it("replays an accepted create even when the registry would now reject it", async () => {
    const commandId = `create-${randomUUID()}`;
    const first = await createActivity(db, registry, deps, {
      commandId,
      title: "Replay across registry change",
      capabilities: ["competition", "probe"],
    });
    const withoutCompetition = createCapabilityRegistry([probeCapability()]);
    if (!withoutCompetition.ok) throw new Error("registry rejected");
    const replay = await createActivity(db, withoutCompetition.registry, deps, {
      commandId,
      title: "Replay across registry change",
      capabilities: ["competition", "probe"],
    });
    expect(replay.replayed).toBe(true);
    expect(replay.body.id).toBe(first.body.id);
  });

  it("replays an accepted compile even when the compiler now fails", async () => {
    const created = await createActivity(db, registry, deps, {
      commandId: `create-${randomUUID()}`,
      title: "Compile replay",
      capabilities: ["competition"],
    });
    const packageValue = {
      schemaVersion: 1 as const,
      manifest: { key: "pkg", title: "Compile replay" },
      capabilities: { competition: createEmptyCompetitionDefinition() },
      bindings: [],
    };
    const compileCommand = `compile-${randomUUID()}`;
    const first = await compileDefinition(db, registry, deps, {
      commandId: compileCommand,
      activityId: created.body.id,
      package: packageValue,
    });
    const failingCompiler: CapabilityCompiler = {
      capabilityKey: "competition",
      compile: () => ({
        ok: false,
        issues: [{ code: "BROKEN", message: "compiler unavailable", path: "payload" }],
      }),
    };
    const failingRegistry = createCapabilityRegistry([
      { ...competitionCapability, compiler: failingCompiler },
    ]);
    if (!failingRegistry.ok) throw new Error("registry rejected");
    const replay = await compileDefinition(db, failingRegistry.registry, deps, {
      commandId: compileCommand,
      activityId: created.body.id,
      package: packageValue,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.body.contentHash).toBe(first.body.contentHash);
  });

  it("records the actor in the receipt, audit and event log", async () => {
    const actorDeps: RuntimeDeps = {
      ...deps,
      actor: {
        actorId: "alice",
        actorType: "user",
        roles: ["staff"],
        permissions: ["*"],
      },
    };
    const commandId = `create-${randomUUID()}`;
    const created = await createActivity(db, registry, actorDeps, {
      commandId,
      title: "Audited",
      capabilities: ["competition"],
    });
    const receipt = await db
      .selectFrom("command_receipt")
      .selectAll()
      .where("command_id", "=", commandId)
      .executeTakeFirstOrThrow();
    expect(receipt).toMatchObject({ actor_id: "alice", actor_type: "user" });

    const audits = await db
      .selectFrom("audit_entry")
      .selectAll()
      .where("command_id", "=", commandId)
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_id: "alice", capability: "engine" });

    const event = await db
      .selectFrom("outbox")
      .selectAll()
      .where("activity_id", "=", created.body.id)
      .where("event_type", "=", "ActivityCreated")
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({ actor_id: "alice", actor_type: "user" });

    await createActivity(db, registry, actorDeps, {
      commandId,
      title: "Audited",
      capabilities: ["competition"],
    });
    const auditsAfter = await db
      .selectFrom("audit_entry")
      .selectAll()
      .where("command_id", "=", commandId)
      .execute();
    expect(auditsAfter).toHaveLength(1);
  });
});
