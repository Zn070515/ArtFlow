import fc from "fast-check";
import { expect, it } from "vitest";

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

const RELEASE_SNAPSHOT = {
  executionPolicy: {
    declaredScopes: [] as string[],
    conflicts: {},
    runtimeContractVersion: 1,
  },
  capabilityVersions: { competition: "1", registration: "1" },
};

const COMPILERS: readonly CapabilityCompiler[] = [
  competitionCompiler,
  passthroughCompiler("registration"),
  passthroughCompiler("voting"),
  passthroughCompiler("archive"),
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
    throw new Error(`expected a valid package, got ${JSON.stringify(result.issues)}`);
  }
  return result;
}

function draftWith(activity: Activity, pkg: ActivityDefinitionPackage): DefinitionDraft {
  const draft = createDefinitionDraft(activity);
  return updateDefinitionDraft(draft, draft.revision, pkg);
}

function released(
  activity: Activity,
  pkg: ActivityDefinitionPackage = definitionPackage(),
): { activity: Activity; version: ReleasedActivityDefinition; draft: DefinitionDraft } {
  const draft = draftWith(activity, pkg);
  const result = releaseDefinition({
      ...RELEASE_SNAPSHOT,
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
  expect(caught).toBeInstanceOf(DomainError);
  if (!(caught instanceof DomainError)) return;
  expect(caught.code).toBe(code);
}

it("activity lifecycle: draft → active → closed → archived", () => {
  const draft = createActivity({ id: "act-1", title: "2026", capabilities: ["registration"] });
  const active = activateActivity(draft, draft.revision);
  const closed = closeActivity(active, active.revision, []);
  const archived = archiveActivity(closed, closed.revision);

  expect(active.status).toBe("active");
  expect(closed.status).toBe("closed");
  expect(archived.status).toBe("archived");
  expectCode(() => archiveActivity(active, active.revision), "INVALID_TRANSITION");
});

it("activity → package draft → compile → release → execution session", () => {
  const activity = activeActivity();
  const pkg = definitionPackage();
  const draft = draftWith(activity, pkg);
  const compiled = compiledPackage(pkg);

  const release = releaseDefinition({
      ...RELEASE_SNAPSHOT,
    activity,
    draft,
    expectedDraftRevision: draft.revision,
    compiled,
    releasedAt: "2026-10-19T10:00:00Z",
  });
  expect(release.version.version).toBe(1);
  expect(release.version.contentHash).toBe(compiled.contentHash);
  expect(Object.keys(release.version.capabilities).sort().join(",")).toBe(
    "competition,registration",
  );
  expect(release.activity.activeDefinitionVersion).toBe(1);
  expect(Object.isFrozen(release.version)).toBe(true);

  const run = session(release.activity, release.version, "stage", "formal", [], {});
  expect(run.status).toBe("running");
  expect(run.scope).toBe("stage");
  expect(run.mode).toBe("formal");
  expect(closeExecutionSession(run, 0).status).toBe("closed");
});

it("several execution scopes may run at the same time", () => {
  const activity = activeActivity();
  const release = released(activity);
  const judging = session(release.activity, release.version, "judging", "formal", [], {});
  const checkin = session(release.activity, release.version, "checkin", "formal", [judging], {});
  expect(judging.status).toBe("running");
  expect(checkin.status).toBe("running");
});

it("declared conflicting scopes cannot overlap", () => {
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

it("formal and non-formal execution cannot share a conflicting scope", () => {
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

it("a scope may only have one running session", () => {
  const activity = activeActivity();
  const release = released(activity);
  const first = session(release.activity, release.version, "stage", "formal", [], {});
  expectCode(
    () => session(release.activity, release.version, "stage", "formal", [first], {}, "second"),
    "SCOPE_ALREADY_RUNNING",
  );
});

it("closing an activity requires every execution session to be closed", () => {
  const activity = activeActivity();
  const release = released(activity);
  const running = session(release.activity, release.version, "stage", "formal", [], {});
  expectCode(
    () => closeActivity(release.activity, release.activity.revision, [running]),
    "ACTIVITY_HAS_RUNNING_SESSIONS",
  );
  const closedRun = closeExecutionSession(running, 0);
  const closedActivity = closeActivity(release.activity, release.activity.revision, [closedRun]);
  expect(closedActivity.status).toBe("closed");
});

it("the package compiler refuses a capability with a cycle", () => {
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
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.some((item) => item.code === "CAPABILITY_CYCLE")).toBe(true);
  expect(
    result.issues.some((item) => item.path.startsWith("capabilities.competition.")),
  ).toBe(true);
});

it("a capability without a registered compiler is refused", () => {
  const result = compileActivityDefinitionPackage(
    definitionPackage(["competition", "scheduling"], []),
    COMPILERS,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(
    result.issues.some(
      (item) =>
        item.code === "CAPABILITY_COMPILER_MISSING" && item.path === "capabilities.scheduling",
    ),
  ).toBe(true);
});

it("the package compiler requires at least one capability", () => {
  const result = compileActivityDefinitionPackage(definitionPackage([]), COMPILERS);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.some((item) => item.code === "NO_CAPABILITIES")).toBe(true);
});

it("a binding must name an existing capability", () => {
  const result = compileActivityDefinitionPackage(
    definitionPackage(
      ["competition"],
      [{ from: "registration", to: "competition", kind: "roster" }],
    ),
    COMPILERS,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.some((item) => item.code === "BINDING_UNKNOWN_CAPABILITY")).toBe(true);
});

it("the package hash ignores capability and binding input order", () => {
  const forward = definitionPackage(["registration", "competition"], [
    { from: "registration", to: "competition", kind: "roster" },
    { from: "competition", to: "registration", kind: "result" },
  ]);
  const reverse = {
    ...forward,
    capabilities: { competition: capabilityDefinition(), registration: capabilityDefinition() },
    bindings: [...(forward.bindings ?? [])].reverse(),
  };
  expect(activityDefinitionPackageHash(forward)).toBe(activityDefinitionPackageHash(reverse));
});

it("the competition compiler owns its language", () => {
  const result = competitionCompiler.compile(capabilityDefinition());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.capabilityKey).toBe("competition");
  const artifact = result.artifact as { order: readonly string[] };
  expect(artifact.order).toEqual(["roster", "round1", "result"]);
});

it("a stale draft revision is refused", () => {
  const activity = activeActivity();
  const draft = createDefinitionDraft(activity);
  expectCode(() => updateDefinitionDraft(draft, 99, definitionPackage()), "STALE_REVISION");
});

it("a compiled package from another draft cannot be released", () => {
  const activity = activeActivity();
  const firstPackage = definitionPackage();
  const draft = draftWith(activity, firstPackage);
  const staleCompiled = compiledPackage(firstPackage);
  const changedPackage = definitionPackage(["registration", "competition"], []);
  const changedDraft = updateDefinitionDraft(draft, draft.revision, changedPackage);

  expectCode(
    () =>
      releaseDefinition({
      ...RELEASE_SNAPSHOT,
        activity,
        draft: changedDraft,
        expectedDraftRevision: changedDraft.revision,
        compiled: staleCompiled,
        releasedAt: "2026-10-19T10:00:00Z",
      }),
    "DEFINITION_HASH_MISMATCH",
  );
});

it("release requires an active activity", () => {
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
      ...RELEASE_SNAPSHOT,
        activity: draftActivity,
        draft,
        expectedDraftRevision: draft.revision,
        compiled: compiledPackage(pkg),
        releasedAt: "2026-10-19T10:00:00Z",
      }),
    "ACTIVITY_NOT_ACTIVE",
  );
});

it("a package cannot include a capability the activity did not enable", () => {
  const activity = activeActivity(["competition"]);
  const pkg = definitionPackage(["registration", "competition"], []);
  const draft = draftWith(activity, pkg);
  expectCode(
    () =>
      releaseDefinition({
      ...RELEASE_SNAPSHOT,
        activity,
        draft,
        expectedDraftRevision: draft.revision,
        compiled: compiledPackage(pkg),
        releasedAt: "2026-10-19T10:00:00Z",
      }),
    "CAPABILITY_NOT_ENABLED",
  );
});

it("an execution session cannot bind a draft", () => {
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

it("a released package from another activity is refused", () => {
  const activity = activeActivity();
  const other = activateActivity(
    createActivity({
      id: "act-2",
      title: "Other",
      capabilities: ["registration", "competition"],
    }),
    0,
  );
  const release = released(activity);
  expectCode(() => session(other, release.version, "stage", "formal", [], {}, "session-1"), "CROSS_ACTIVITY");
});

// --- property tests (fast-check) ---

it("property: package hash is independent of capability and binding order", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.constantFrom("registration", "competition", "voting", "archive"), {
        minLength: 1,
        maxLength: 4,
      }),
      (keys) => {
        const capabilities = Object.fromEntries(
          keys.map((key) => [key, capabilityDefinition()]),
        ) as Record<string, CapabilityDefinition>;
        const bindings = keys.slice(1).map((key, index) => ({
          from: keys[index] ?? key,
          to: key,
          kind: "link",
        }));
        const forward: ActivityDefinitionPackage = {
          schemaVersion: 1,
          manifest: { key: "pkg", title: "property" },
          capabilities,
          bindings,
        };
        const reverse: ActivityDefinitionPackage = {
          ...forward,
          capabilities: Object.fromEntries(
            [...keys].reverse().map((key) => [key, capabilityDefinition()]),
          ) as Record<string, CapabilityDefinition>,
          bindings: [...bindings].reverse(),
        };
        expect(activityDefinitionPackageHash(forward)).toBe(
          activityDefinitionPackageHash(reverse),
        );
      },
    ),
  );
});

it("property: any mismatched revision is refused", () => {
  const activity = activeActivity();
  const draft = createDefinitionDraft(activity);
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 10_000 }), (revision) => {
      fc.pre(revision !== draft.revision);
      expectCode(
        () => updateDefinitionDraft(draft, revision, definitionPackage()),
        "STALE_REVISION",
      );
    }),
  );
});

it("property: closed or archived activities never start an execution", () => {
  fc.assert(
    fc.property(fc.constantFrom("closed", "archived"), (state) => {
      const activity = activeActivity();
      const release = released(activity);
      const closed = closeActivity(release.activity, release.activity.revision, []);
      const final =
        state === "closed" ? closed : archiveActivity(closed, closed.revision);
      expectCode(
        () => session(final, release.version, "stage", "formal", [], {}),
        "ACTIVITY_NOT_ACTIVE",
      );
    }),
  );
});

it("property: two running sessions never share a scope", () => {
  fc.assert(
    fc.property(fc.constantFrom<ExecutionMode>("test", "rehearsal", "formal"), (mode) => {
      const activity = activeActivity();
      const release = released(activity);
      const first = session(release.activity, release.version, "stage", mode, [], {});
      expectCode(
        () =>
          session(release.activity, release.version, "stage", mode, [first], {}, "second"),
        "SCOPE_ALREADY_RUNNING",
      );
    }),
  );
});

it("property: declared conflicts reject or isolate the second scope", () => {
  fc.assert(
    fc.property(
      fc.constantFrom<ExecutionMode>("test", "rehearsal", "formal"),
      fc.constantFrom<ExecutionMode>("test", "rehearsal", "formal"),
      (firstMode, secondMode) => {
        const activity = activeActivity();
        const release = released(activity);
        const conflicts = { a: ["b"] };
        const first = session(release.activity, release.version, "a", firstMode, [], conflicts);
        const expected =
          (firstMode === "formal") !== (secondMode === "formal")
            ? "TEST_FORMAL_CONFLICT"
            : "SCOPE_CONFLICT";
        expectCode(
          () =>
            session(release.activity, release.version, "b", secondMode, [first], conflicts, "second"),
          expected,
        );
      },
    ),
  );
});
