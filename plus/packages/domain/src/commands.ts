import { definitionHash } from "./compiler.js";
import { fail } from "./errors.js";
import type {
  Activity,
  CompiledPlan,
  DefinitionDocument,
  DefinitionDraft,
  DefinitionVersion,
  ExecutionRun,
  ReleasedDefinition,
} from "./model.js";
import { deepFreeze } from "./model.js";

function cloneDocument(document: DefinitionDocument): DefinitionDocument {
  return {
    schemaVersion: document.schemaVersion,
    nodes: document.nodes.map((node) => ({ ...node })),
    edges: document.edges.map((edge) => ({ ...edge })),
  };
}

export function createActivity(input: { id: string; title: string }): Activity {
  if (!input.id.trim()) fail("INVALID_INPUT", "Activity id cannot be empty.");
  if (!input.title.trim()) fail("INVALID_INPUT", "Activity title cannot be empty.");
  return deepFreeze({
    id: input.id,
    title: input.title,
    status: "draft" as const,
    revision: 0,
    definitionVersion: 0,
  });
}

export function activateActivity(activity: Activity, expectedRevision: number): Activity {
  if (activity.revision !== expectedRevision) {
    fail("STALE_REVISION", "The activity changed since it was read.");
  }
  if (activity.status !== "draft") {
    fail("INVALID_TRANSITION", "Only a draft activity can be activated.");
  }
  return deepFreeze({ ...activity, status: "active" as const, revision: activity.revision + 1 });
}

export function createDefinitionDraft(activity: Activity): DefinitionDraft {
  if (activity.status !== "active") {
    fail("ACTIVITY_NOT_ACTIVE", "A definition can only be drafted for an active activity.");
  }
  return deepFreeze({
    activityId: activity.id,
    revision: 0,
    status: "draft" as const,
    document: { schemaVersion: 1 as const, nodes: [], edges: [] },
  });
}

export function updateDefinitionDraft(
  draft: DefinitionDraft,
  expectedRevision: number,
  document: DefinitionDocument,
): DefinitionDraft {
  if (draft.revision !== expectedRevision) {
    fail("STALE_REVISION", "The definition draft changed since it was read.");
  }
  return deepFreeze({
    ...draft,
    revision: draft.revision + 1,
    document: cloneDocument(document),
  });
}

export interface ReleaseDefinitionInput {
  readonly activity: Activity;
  readonly draft: DefinitionDraft;
  readonly expectedDraftRevision: number;
  readonly plan: CompiledPlan;
  readonly releasedAt: string;
}

export interface ReleaseDefinitionResult {
  readonly activity: Activity;
  readonly version: ReleasedDefinition;
}

/**
 * Release is the authority transition: the compiled plan must be the plan for
 * this draft, the activity must be active, and the released version is frozen.
 */
export function releaseDefinition(input: ReleaseDefinitionInput): ReleaseDefinitionResult {
  const { activity, draft, expectedDraftRevision, plan, releasedAt } = input;
  if (activity.status !== "active") {
    fail("ACTIVITY_NOT_ACTIVE", "Only an active activity can release a definition.");
  }
  if (draft.activityId !== activity.id) {
    fail("CROSS_ACTIVITY", "The draft belongs to a different activity.");
  }
  if (draft.revision !== expectedDraftRevision) {
    fail("STALE_REVISION", "The definition draft changed since it was read.");
  }
  if (!plan.ok) {
    fail("DEFINITION_HASH_MISMATCH", "An invalid plan cannot be released.");
  }
  if (plan.contentHash !== definitionHash(draft.document)) {
    fail(
      "DEFINITION_HASH_MISMATCH",
      "The compiled plan does not describe the current draft document.",
    );
  }
  const versionNumber = activity.definitionVersion + 1;
  const version: ReleasedDefinition = deepFreeze({
    activityId: activity.id,
    version: versionNumber,
    status: "released" as const,
    contentHash: plan.contentHash,
    plan,
    releasedAt,
  });
  const nextActivity = deepFreeze({
    ...activity,
    revision: activity.revision + 1,
    definitionVersion: versionNumber,
  });
  return { activity: nextActivity, version };
}

export interface StartExecutionRunInput {
  readonly activity: Activity;
  readonly version: DefinitionVersion;
  readonly existingRun: ExecutionRun | undefined;
  readonly runId: string;
}

export function startExecutionRun(input: StartExecutionRunInput): ExecutionRun {
  const { activity, version, existingRun, runId } = input;
  if (activity.status !== "active") {
    fail("ACTIVITY_NOT_ACTIVE", "Only an active activity can start a run.");
  }
  if (version.status !== "released") {
    fail("VERSION_NOT_RELEASED", "An execution run must reference a released definition.");
  }
  if (version.activityId !== activity.id) {
    fail("CROSS_ACTIVITY", "The definition version belongs to a different activity.");
  }
  if (existingRun?.status === "running") {
    fail("RUN_ALREADY_ACTIVE", "This activity already has a running execution.");
  }
  return deepFreeze({
    id: runId,
    activityId: activity.id,
    definitionVersion: version.version,
    contentHash: version.contentHash,
    status: "running" as const,
    revision: 0,
  });
}

export function closeExecutionRun(run: ExecutionRun, expectedRevision: number): ExecutionRun {
  if (run.revision !== expectedRevision) {
    fail("STALE_REVISION", "The execution run changed since it was read.");
  }
  if (run.status !== "running") {
    fail("INVALID_TRANSITION", "Only a running execution can be closed.");
  }
  return deepFreeze({ ...run, status: "closed" as const, revision: run.revision + 1 });
}
