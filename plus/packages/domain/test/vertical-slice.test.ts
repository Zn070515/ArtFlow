import assert from "node:assert/strict";
import test from "node:test";

import {
  activateActivity,
  closeExecutionRun,
  compileDefinition,
  createActivity,
  createDefinitionDraft,
  definitionHash,
  DomainError,
  releaseDefinition,
  startExecutionRun,
  updateDefinitionDraft,
} from "../src/index.js";
import type {
  Activity,
  CompiledPlan,
  DefinitionDocument,
  DomainErrorCode,
} from "../src/index.js";

const validDocument: DefinitionDocument = {
  schemaVersion: 1,
  nodes: [
    { key: "roster", type: "roster" },
    { key: "round1", type: "round", label: "第一轮" },
    { key: "final", type: "output", label: "最终结果" },
  ],
  edges: [
    { from: "roster", to: "round1" },
    { from: "round1", to: "final" },
  ],
};

function activeActivity(): Activity {
  const draft = createActivity({ id: "act-1", title: "2026 院十佳" });
  return activateActivity(draft, draft.revision);
}

function compiled(document: DefinitionDocument = validDocument): CompiledPlan {
  const result = compileDefinition(document);
  if (!result.ok) {
    assert.fail(`expected a valid definition, got ${JSON.stringify(result.issues)}`);
  }
  return result;
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

test("activity → draft → compile → release → run", () => {
  const activity = activeActivity();
  const draft = createDefinitionDraft(activity);
  const edited = updateDefinitionDraft(draft, 0, validDocument);
  const plan = compiled(edited.document);

  const released = releaseDefinition({
    activity,
    draft: edited,
    expectedDraftRevision: edited.revision,
    plan,
    releasedAt: "2026-10-19T10:00:00Z",
  });

  assert.equal(released.version.version, 1);
  assert.equal(released.version.contentHash, plan.contentHash);
  assert.equal(released.activity.definitionVersion, 1);
  assert.ok(Object.isFrozen(released.version));
  assert.ok(Object.isFrozen(released.version.plan));

  const run = startExecutionRun({
    activity: released.activity,
    version: released.version,
    existingRun: undefined,
    runId: "run-1",
  });
  assert.equal(run.status, "running");
  assert.equal(run.definitionVersion, 1);
  assert.equal(run.contentHash, plan.contentHash);
  assert.equal(closeExecutionRun(run, 0).status, "closed");
});

test("the content hash ignores node and edge input order", () => {
  const reversed: DefinitionDocument = {
    schemaVersion: 1,
    nodes: [...validDocument.nodes].reverse(),
    edges: [...validDocument.edges].reverse(),
  };
  assert.equal(definitionHash(validDocument), definitionHash(reversed));
});

test("the compiler refuses an empty definition", () => {
  const result = compileDefinition({ schemaVersion: 1, nodes: [], edges: [] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(
    result.issues.map((item) => item.code).sort(),
    ["EMPTY_DEFINITION", "NO_OUTPUT"],
  );
});

test("the compiler refuses a cycle", () => {
  const cyclic: DefinitionDocument = {
    schemaVersion: 1,
    nodes: [
      { key: "roster", type: "roster" },
      { key: "a", type: "round" },
      { key: "b", type: "round" },
      { key: "out", type: "output" },
    ],
    edges: [
      { from: "roster", to: "a" },
      { from: "a", to: "b" },
      { from: "b", to: "a" },
      { from: "b", to: "out" },
    ],
  };
  const result = compileDefinition(cyclic);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((item) => item.code === "CYCLE"));
});

test("a stale draft revision is refused", () => {
  const activity = activeActivity();
  const draft = createDefinitionDraft(activity);
  expectCode(() => updateDefinitionDraft(draft, 99, validDocument), "STALE_REVISION");
});

test("a plan from another document cannot be released", () => {
  const activity = activeActivity();
  const draft = createDefinitionDraft(activity);
  const edited = updateDefinitionDraft(draft, 0, validDocument);
  const stalePlan = compiled(edited.document);
  const otherDocument: DefinitionDocument = {
    ...validDocument,
    edges: [{ from: "roster", to: "final" }],
  };
  const changed = updateDefinitionDraft(edited, edited.revision, otherDocument);

  expectCode(
    () =>
      releaseDefinition({
        activity,
        draft: changed,
        expectedDraftRevision: changed.revision,
        plan: stalePlan,
        releasedAt: "2026-10-19T10:00:00Z",
      }),
    "DEFINITION_HASH_MISMATCH",
  );
});

test("release requires an active activity", () => {
  const draftActivity = createActivity({ id: "act-1", title: "2026" });
  const draft = createDefinitionDraft(
    activateActivity(draftActivity, draftActivity.revision),
  );
  const edited = updateDefinitionDraft(draft, 0, validDocument);
  const plan = compiled(edited.document);

  expectCode(
    () =>
      releaseDefinition({
        activity: draftActivity,
        draft: edited,
        expectedDraftRevision: edited.revision,
        plan,
        releasedAt: "2026-10-19T10:00:00Z",
      }),
    "ACTIVITY_NOT_ACTIVE",
  );
});

test("an execution run cannot bind a draft", () => {
  const activity = activeActivity();
  const draft = createDefinitionDraft(activity);
  expectCode(
    () =>
      startExecutionRun({
        activity,
        version: draft,
        existingRun: undefined,
        runId: "run-1",
      }),
    "VERSION_NOT_RELEASED",
  );
});

test("one activity cannot run two executions at once", () => {
  const activity = activeActivity();
  const draft = updateDefinitionDraft(createDefinitionDraft(activity), 0, validDocument);
  const released = releaseDefinition({
    activity,
    draft,
    expectedDraftRevision: draft.revision,
    plan: compiled(draft.document),
    releasedAt: "2026-10-19T10:00:00Z",
  });
  const run = startExecutionRun({
    activity: released.activity,
    version: released.version,
    existingRun: undefined,
    runId: "run-1",
  });

  expectCode(
    () =>
      startExecutionRun({
        activity: released.activity,
        version: released.version,
        existingRun: run,
        runId: "run-2",
      }),
    "RUN_ALREADY_ACTIVE",
  );
});

test("a version from another activity is refused", () => {
  const activity = activeActivity();
  const other = activateActivity(
    createActivity({ id: "act-2", title: "Other" }),
    0,
  );
  const draft = updateDefinitionDraft(createDefinitionDraft(activity), 0, validDocument);
  const released = releaseDefinition({
    activity,
    draft,
    expectedDraftRevision: draft.revision,
    plan: compiled(draft.document),
    releasedAt: "2026-10-19T10:00:00Z",
  });

  expectCode(
    () =>
      startExecutionRun({
        activity: other,
        version: released.version,
        existingRun: undefined,
        runId: "run-1",
      }),
    "CROSS_ACTIVITY",
  );
});
