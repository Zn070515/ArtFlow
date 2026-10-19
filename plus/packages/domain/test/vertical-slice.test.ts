import assert from "node:assert/strict";
import test from "node:test";

import {
  activateActivity,
  activityDefinitionPackageHash,
  archiveActivity,
  capabilityDefinitionHash,
  closeActivity,
  closeExecutionSession,
  competitionCompiler,
  compileActivityDefinitionPackage,
  createActivity,
  createCompetitionDefinition,
  createDefinitionDraft,
  DomainError,
  releaseDefinition,
  startExecutionSession,
  updateDefinitionDraft,
} from "../src/index.js";
import type {
  Activity,
  ActivityDefinitionPackage,
  CapabilityCompiler,
  CapabilityDefinition,
  CompiledActivityDefinition,
  DefinitionDraft,
  DomainErrorCode,
  ExecutionMode,
  ExecutionSession,
  ReleasedActivityDefinition,
  ScopeConflictPolicy,
} from "../src/index.js";

function capabilityDefinition(): CapabilityDefinition {
  return createCompetitionDefinition(
    [
      { key: "roster", type: "roster" },
      { key: "round1", type: "round", label: "第一轮" },
      { key: "result", type: "output", label: "结果" },
    ],
    [
      { from: "roster", to: "round1" },
      { from: "round1", to: "result" },
    ],
  );
}

function passthroughCompiler(capabilityKey: string): CapabilityCompiler {
  return {
    capabilityKey,
    compile: (definition) => ({
      ok: true,
      capabilityKey,
      contentHash: capabilityDefinitionHash(definition),
      artifact: definition.payload,
    }),
  };
}

const COMPILERS: readonly CapabilityCompiler[] = [
  competitionCompiler,
  passthroughCompiler("registration"),
  passthroughCompiler("voting"),
];

function definitionPackage(
  capabilityKeys: readonly string[] = ["registration", "competition"],
  bindings: ActivityDefinitionPackage["bindings"] = [
    { from: "registration", to: "competition", kind: "roster" },
  ],
): ActivityDefinitionPackage {
  const capabilities: Record<string, CapabilityDefinition> = {};
  for (const key of capabilityKeys) {
    capabilities[key] = capabilityDefinition();
  }
  return {
    schemaVersion: 1,
    manifest: { key: "pkg-2026", title: "2026 院十佳" },
    capabilities,
    bindings,
  };
}

function activeActivity(
  capabilities: readonly string[] = ["registration", "competition"],
): Activity {
  const draft = createActivity({ id: "act-1", title: "2026 院十佳", capabilities });
  return activateActivity(draft, draft.revision);
}

function compiledPackage(pkg: ActivityDefinitionPackage): CompiledActivityDefinition {
  const result = compileActivityDefinitionPackage(pkg, COMPILERS);
  if (!result.ok) {
    assert.fail(`expected a valid package, got ${JSON.stringify(result.issues)}`);
  }
  return result;
}

function draftWith(
  activity: Activity,
  pkg: ActivityDefinitionPackage,
): DefinitionDraft {
  const draft = createDefinitionDraft(activity);
  return updateDefinitionDraft(draft, draft.revision, pkg);
}

function released(
  activity: Activity,
  pkg: ActivityDefinitionPackage = definitionPackage(),
): { activity: Activity; version: ReleasedActivityDefinition; draft: DefinitionDraft } {
  const draft = draftWith(activity, pkg);
  const result = releaseDefinition({
    activity,
    draft,
    expectedDraftRevision: draft.revision,
    compiled: compiledPackage(pkg),
    releasedAt: "2026-10-19T10:00:00Z",
  });
  return { ...result, draft };
}

function session(
  activity: Activity,
  version: ReleasedActivityDefinition,
  scope: string,
  mode: ExecutionMode,
  existing: readonly ExecutionSession[],
  conflicts: ScopeConflictPolicy,
  id = `session-${scope}`,
): ExecutionSession {
  return startExecutionSession({
    activity,
    version,
    scope,
    mode,
    existingSessions: existing,
    conflicts,
    sessionId: id,
  });
}

function expectCode(action: () => unknown, code: DomainErrorCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof DomainError)) {
    assert.fail(`expected DomainError ${code}`);
  }
  assert.equal(caught.code, code);
}

test("activity lifecycle: draft → active → closed → archived", () => {
  const draft = createActivity({ id: "act-1", title: "2026", capabilities: ["registration"] });
  const active = activateActivity(draft, draft.revision);
  const closed = closeActivity(active, active.revision, []);
  const archived = archiveActivity(closed, closed.revision);

  assert.equal(active.status, "active");
  assert.equal(closed.status, "closed");
  assert.equal(archived.status, "archived");
  expectCode(() => archiveActivity(active, active.revision), "INVALID_TRANSITION");
});

test("activity → package draft → compile → release → execution session", () => {
  const activity = activeActivity();
  const pkg = definitionPackage();
  const draft = draftWith(activity, pkg);
  const compiled = compiledPackage(pkg);

  const release = releaseDefinition({
    activity,
    draft,
    expectedDraftRevision: draft.revision,
    compiled,
    releasedAt: "2026-10-19T10:00:00Z",
  });
  assert.equal(release.version.version, 1);
  assert.equal(release.version.contentHash, compiled.contentHash);
  assert.equal(Object.keys(release.version.capabilities).sort().join(","), "competition,registration");
  assert.equal(release.activity.activeDefinitionVersion, 1);
  assert.ok(Object.isFrozen(release.version));

  const run = session(release.activity, release.version, "stage", "formal", [], {});
  assert.equal(run.status, "running");
  assert.equal(run.scope, "stage");
  assert.equal(run.mode, "formal");
  assert.equal(closeExecutionSession(run, 0).status, "closed");
});

test("several execution scopes may run at the same time", () => {
  const activity = activeActivity();
  const release = released(activity);
  const judging = session(release.activity, release.version, "judging", "formal", [], {});
  const checkin = session(release.activity, release.version, "checkin", "formal", [judging], {});
  assert.equal(judging.status, "running");
  assert.equal(checkin.status, "running");
});

test("declared conflicting scopes cannot overlap", () => {
  const activity = activeActivity();
  const release = released(activity);
  const judging = session(release.activity, release.version, "judging", "formal", [], {
    judging: ["checkin"],
  });
  expectCode(
    () =>
      session(release.activity, release.version, "checkin", "formal", [judging], {
        judging: ["checkin"],
      }),
    "SCOPE_CONFLICT",
  );
});

test("formal and non-formal execution cannot share a conflicting scope", () => {
  const activity = activeActivity();
  const release = released(activity);
  const formal = session(release.activity, release.version, "stage", "formal", [], {
    stage: ["rehearsal"],
  });
  expectCode(
    () =>
      session(release.activity, release.version, "rehearsal", "rehearsal", [formal], {
        stage: ["rehearsal"],
      }),
    "TEST_FORMAL_CONFLICT",
  );
});

test("a scope may only have one running session", () => {
  const activity = activeActivity();
  const release = released(activity);
  const first = session(release.activity, release.version, "stage", "formal", [], {});
  expectCode(
    () => session(release.activity, release.version, "stage", "formal", [first], {}, "second"),
    "SCOPE_ALREADY_RUNNING",
  );
});

test("closing an activity requires every execution session to be closed", () => {
  const activity = activeActivity();
  const release = released(activity);
  const running = session(release.activity, release.version, "stage", "formal", [], {});
  expectCode(
    () => closeActivity(release.activity, release.activity.revision, [running]),
    "ACTIVITY_HAS_RUNNING_SESSIONS",
  );
  const closedRun = closeExecutionSession(running, 0);
  const closedActivity = closeActivity(release.activity, release.activity.revision, [closedRun]);
  assert.equal(closedActivity.status, "closed");
});

test("the package compiler refuses a capability with a cycle", () => {
  const broken = createCompetitionDefinition(
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
  );
  const result = compileActivityDefinitionPackage(
    {
      ...definitionPackage(["competition"], []),
      capabilities: { competition: broken },
    },
    COMPILERS,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((item) => item.code === "CAPABILITY_CYCLE"));
  assert.ok(result.issues.some((item) => item.path.startsWith("capabilities.competition.")));
});

test("a capability without a registered compiler is refused", () => {
  const result = compileActivityDefinitionPackage(
    definitionPackage(["competition", "scheduling"], []),
    COMPILERS,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.issues.some(
      (item) =>
        item.code === "CAPABILITY_COMPILER_MISSING" &&
        item.path === "capabilities.scheduling",
    ),
  );
});

test("the package compiler requires at least one capability", () => {
  const result = compileActivityDefinitionPackage(definitionPackage([]), COMPILERS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((item) => item.code === "NO_CAPABILITIES"));
});

test("a binding must name an existing capability", () => {
  const result = compileActivityDefinitionPackage(
    definitionPackage(["competition"], [{ from: "registration", to: "competition", kind: "roster" }]),
    COMPILERS,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((item) => item.code === "BINDING_UNKNOWN_CAPABILITY"));
});

test("the package hash ignores capability and binding input order", () => {
  const forward = definitionPackage(["registration", "competition"], [
    { from: "registration", to: "competition", kind: "roster" },
    { from: "competition", to: "registration", kind: "result" },
  ]);
  const reverse = {
    ...forward,
    capabilities: { competition: capabilityDefinition(), registration: capabilityDefinition() },
    bindings: [...(forward.bindings ?? [])].reverse(),
  };
  assert.equal(activityDefinitionPackageHash(forward), activityDefinitionPackageHash(reverse));
});

test("the competition compiler owns its language", () => {
  const result = competitionCompiler.compile(capabilityDefinition());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.capabilityKey, "competition");
  const artifact = result.artifact as { order: readonly string[] };
  assert.deepEqual(artifact.order, ["roster", "round1", "result"]);
});

test("a stale draft revision is refused", () => {
  const activity = activeActivity();
  const draft = createDefinitionDraft(activity);
  expectCode(() => updateDefinitionDraft(draft, 99, definitionPackage()), "STALE_REVISION");
});

test("a compiled package from another draft cannot be released", () => {
  const activity = activeActivity();
  const firstPackage = definitionPackage();
  const draft = draftWith(activity, firstPackage);
  const staleCompiled = compiledPackage(firstPackage);
  const changedPackage = definitionPackage(["registration", "competition"], []);
  const changedDraft = updateDefinitionDraft(draft, draft.revision, changedPackage);

  expectCode(
    () =>
      releaseDefinition({
        activity,
        draft: changedDraft,
        expectedDraftRevision: changedDraft.revision,
        compiled: staleCompiled,
        releasedAt: "2026-10-19T10:00:00Z",
      }),
    "DEFINITION_HASH_MISMATCH",
  );
});

test("release requires an active activity", () => {
  const draftActivity = createActivity({
    id: "act-1",
    title: "2026",
    capabilities: ["registration", "competition"],
  });
  const pkg = definitionPackage();
  const draft = draftWith(draftActivity, pkg);
  expectCode(
    () =>
      releaseDefinition({
        activity: draftActivity,
        draft,
        expectedDraftRevision: draft.revision,
        compiled: compiledPackage(pkg),
        releasedAt: "2026-10-19T10:00:00Z",
      }),
    "ACTIVITY_NOT_ACTIVE",
  );
});

test("a package cannot include a capability the activity did not enable", () => {
  const activity = activeActivity(["competition"]);
  const pkg = definitionPackage(["registration", "competition"], []);
  const draft = draftWith(activity, pkg);
  expectCode(
    () =>
      releaseDefinition({
        activity,
        draft,
        expectedDraftRevision: draft.revision,
        compiled: compiledPackage(pkg),
        releasedAt: "2026-10-19T10:00:00Z",
      }),
    "CAPABILITY_NOT_ENABLED",
  );
});

test("an execution session cannot bind a draft", () => {
  const activity = activeActivity();
  const draft = createDefinitionDraft(activity);
  expectCode(
    () =>
      startExecutionSession({
        activity,
        version: draft,
        scope: "stage",
        mode: "formal",
        existingSessions: [],
        conflicts: {},
        sessionId: "session-1",
      }),
    "VERSION_NOT_RELEASED",
  );
});

test("a released package from another activity is refused", () => {
  const activity = activeActivity();
  const other = activateActivity(
    createActivity({ id: "act-2", title: "Other", capabilities: ["registration", "competition"] }),
    0,
  );
  const release = released(activity);
  expectCode(
    () =>
      session(other, release.version, "stage", "formal", [], {}, "session-1"),
    "CROSS_ACTIVITY",
  );
});
