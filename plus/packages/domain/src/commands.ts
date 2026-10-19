import { activityDefinitionPackageHash } from "./compiler.js";
import { fail } from "./errors.js";
import type {
  Activity,
  ActivityDefinitionPackage,
  CapabilityBinding,
  CompiledActivityDefinition,
  DefinitionDraft,
  DefinitionVersion,
  ExecutionMode,
  ExecutionPolicy,
  ExecutionSession,
  ReleasedActivityDefinition,
  ScopeConflictPolicy,
} from "./model.js";
import { deepFreeze } from "./model.js";

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const cloned: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      cloned[key] = cloneJson(item);
    }
    return cloned as T;
  }
  return value;
}

function clonePackage(pkg: ActivityDefinitionPackage): ActivityDefinitionPackage {
  const capabilities: Record<string, ActivityDefinitionPackage["capabilities"][string]> = {};
  for (const [key, definition] of Object.entries(pkg.capabilities)) {
    // The Activity layer does not know what the payload means; it only copies it.
    capabilities[key] = {
      schemaVersion: definition.schemaVersion,
      payload: cloneJson(definition.payload),
    };
  }
  return {
    schemaVersion: pkg.schemaVersion,
    manifest: { ...pkg.manifest },
    capabilities,
    bindings: (pkg.bindings ?? []).map((binding) => ({ ...binding })),
  };
}

export function createActivity(input: {
  id: string;
  title: string;
  capabilities?: readonly string[];
}): Activity {
  if (!input.id.trim()) fail("INVALID_INPUT", "Activity id cannot be empty.");
  if (!input.title.trim()) fail("INVALID_INPUT", "Activity title cannot be empty.");
  const capabilities = [...new Set(input.capabilities ?? [])];
  if (capabilities.some((key) => !key.trim())) {
    fail("INVALID_INPUT", "Capability keys cannot be empty.");
  }
  return deepFreeze({
    id: input.id,
    title: input.title,
    status: "draft" as const,
    revision: 0,
    enabledCapabilities: capabilities,
    activeDefinitionVersion: 0,
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

export function closeActivity(
  activity: Activity,
  expectedRevision: number,
  sessions: readonly ExecutionSession[],
): Activity {
  if (activity.revision !== expectedRevision) {
    fail("STALE_REVISION", "The activity changed since it was read.");
  }
  if (activity.status !== "active") {
    fail("INVALID_TRANSITION", "Only an active activity can be closed.");
  }
  if (sessions.some((session) => session.status === "running")) {
    fail(
      "ACTIVITY_HAS_RUNNING_SESSIONS",
      "Close every running execution session before closing the activity.",
    );
  }
  return deepFreeze({ ...activity, status: "closed" as const, revision: activity.revision + 1 });
}

export function archiveActivity(activity: Activity, expectedRevision: number): Activity {
  if (activity.revision !== expectedRevision) {
    fail("STALE_REVISION", "The activity changed since it was read.");
  }
  if (activity.status !== "closed") {
    fail("INVALID_TRANSITION", "Only a closed activity can be archived.");
  }
  return deepFreeze({ ...activity, status: "archived" as const, revision: activity.revision + 1 });
}

export function createDefinitionDraft(activity: Activity): DefinitionDraft {
  if (activity.status !== "draft" && activity.status !== "active") {
    fail("ACTIVITY_NOT_ACTIVE", "A definition can only be drafted while the activity is editable.");
  }
  return deepFreeze({
    activityId: activity.id,
    revision: 0,
    status: "draft" as const,
    package: {
      schemaVersion: 1 as const,
      manifest: { key: activity.id, title: activity.title },
      capabilities: {},
    },
  });
}

export function updateDefinitionDraft(
  draft: DefinitionDraft,
  expectedRevision: number,
  pkg: ActivityDefinitionPackage,
): DefinitionDraft {
  if (draft.revision !== expectedRevision) {
    fail("STALE_REVISION", "The definition draft changed since it was read.");
  }
  return deepFreeze({
    ...draft,
    revision: draft.revision + 1,
    package: clonePackage(pkg),
  });
}

export interface ReleaseDefinitionInput {
  readonly activity: Activity;
  readonly draft: DefinitionDraft;
  readonly expectedDraftRevision: number;
  readonly compiled: CompiledActivityDefinition;
  readonly releasedAt: string;
  /** Frozen at release from the registry composition; never re-derived later. */
  readonly executionPolicy: ExecutionPolicy;
  readonly capabilityVersions: Readonly<Record<string, string>>;
  readonly bindings?: readonly CapabilityBinding[];
}

export interface ReleaseDefinitionResult {
  readonly activity: Activity;
  readonly version: ReleasedActivityDefinition;
}

/**
 * Release is the authority transition: the compiled package must describe this
 * draft, every capability must be enabled on the activity, and the released
 * package is frozen. Corrigenda release a new version.
 */
export function releaseDefinition(input: ReleaseDefinitionInput): ReleaseDefinitionResult {
  const {
    activity,
    draft,
    expectedDraftRevision,
    compiled,
    releasedAt,
    executionPolicy,
    capabilityVersions,
    bindings,
  } = input;
  if (activity.status !== "active") {
    fail("ACTIVITY_NOT_ACTIVE", "Only an active activity can release a definition.");
  }
  if (draft.activityId !== activity.id) {
    fail("CROSS_ACTIVITY", "The draft belongs to a different activity.");
  }
  if (draft.revision !== expectedDraftRevision) {
    fail("STALE_REVISION", "The definition draft changed since it was read.");
  }
  if (!compiled.ok) {
    fail("DEFINITION_HASH_MISMATCH", "An invalid package cannot be released.");
  }
  if (compiled.contentHash !== activityDefinitionPackageHash(draft.package)) {
    fail(
      "DEFINITION_HASH_MISMATCH",
      "The compiled package does not describe the current draft.",
    );
  }
  const disabled = Object.keys(compiled.capabilities).filter(
    (key) => !activity.enabledCapabilities.includes(key),
  );
  if (disabled.length > 0) {
    fail(
      "CAPABILITY_NOT_ENABLED",
      `The package includes capabilities that are not enabled: ${disabled.join(", ")}.`,
    );
  }
  const missingVersions = Object.keys(compiled.capabilities).filter(
    (key) => capabilityVersions[key] === undefined,
  );
  if (missingVersions.length > 0) {
    fail(
      "RELEASE_SNAPSHOT_INCOMPLETE",
      `The release snapshot has no capability version for: ${missingVersions.join(", ")}.`,
    );
  }
  if (
    !Number.isInteger(executionPolicy.runtimeContractVersion) ||
    executionPolicy.runtimeContractVersion < 1
  ) {
    fail(
      "RELEASE_SNAPSHOT_INCOMPLETE",
      "The release snapshot needs a runtime contract version.",
    );
  }

  const frozenPolicy: ExecutionPolicy = {
    declaredScopes: [...executionPolicy.declaredScopes],
    conflicts: Object.fromEntries(
      Object.entries(executionPolicy.conflicts).map(([scope, conflicts]) => [
        scope,
        [...conflicts],
      ]),
    ),
    runtimeContractVersion: executionPolicy.runtimeContractVersion,
  };
  const frozenBindings = [...(bindings ?? draft.package.bindings ?? [])].map(
    (binding) => ({ ...binding }),
  );
  const versionNumber = activity.activeDefinitionVersion + 1;
  const version: ReleasedActivityDefinition = deepFreeze({
    activityId: activity.id,
    version: versionNumber,
    status: "released" as const,
    contentHash: compiled.contentHash,
    capabilities: compiled.capabilities,
    capabilityVersions: { ...capabilityVersions },
    executionPolicy: frozenPolicy,
    bindings: frozenBindings,
    releasedAt,
  });
  const nextActivity = deepFreeze({
    ...activity,
    revision: activity.revision + 1,
    activeDefinitionVersion: versionNumber,
  });
  return { activity: nextActivity, version };
}

export interface StartExecutionSessionInput {
  readonly activity: Activity;
  readonly version: DefinitionVersion;
  readonly scope: string;
  readonly mode: ExecutionMode;
  readonly existingSessions: readonly ExecutionSession[];
  readonly conflicts: ScopeConflictPolicy;
  readonly sessionId: string;
}

/**
 * An activity may run several execution scopes at once (rehearsal, judging,
 * check-in, voting...). The policy, not the kernel, declares which scopes
 * conflict. TEST/REHEARSAL can never share a conflicting scope with FORMAL.
 */
export function startExecutionSession(input: StartExecutionSessionInput): ExecutionSession {
  const { activity, version, scope, mode, existingSessions, conflicts, sessionId } = input;
  if (activity.status !== "active") {
    fail("ACTIVITY_NOT_ACTIVE", "Only an active activity can start an execution session.");
  }
  if (version.status !== "released") {
    fail("VERSION_NOT_RELEASED", "An execution session must reference a released definition.");
  }
  if (version.activityId !== activity.id) {
    fail("CROSS_ACTIVITY", "The definition version belongs to a different activity.");
  }
  if (!scope.trim()) {
    fail("INVALID_INPUT", "An execution scope cannot be empty.");
  }
  if (!sessionId.trim()) {
    fail("INVALID_INPUT", "An execution session id cannot be empty.");
  }
  if (!["test", "rehearsal", "formal"].includes(mode)) {
    fail("INVALID_INPUT", "Execution mode must be test, rehearsal or formal.");
  }

  const running = existingSessions.filter((session) => session.status === "running");
  if (running.some((session) => session.scope === scope)) {
    fail("SCOPE_ALREADY_RUNNING", `Scope ${scope} already has a running execution.`);
  }
  for (const other of running) {
    const declared =
      (conflicts[scope] ?? []).includes(other.scope) ||
      (conflicts[other.scope] ?? []).includes(scope);
    if (!declared) continue;
    if ((mode === "formal") !== (other.mode === "formal")) {
      fail(
        "TEST_FORMAL_CONFLICT",
        `Formal and non-formal execution cannot overlap in ${scope} / ${other.scope}.`,
      );
    }
    fail("SCOPE_CONFLICT", `Scopes ${scope} and ${other.scope} cannot run at the same time.`);
  }

  return deepFreeze({
    id: sessionId,
    activityId: activity.id,
    definitionVersion: version.version,
    contentHash: version.contentHash,
    scope,
    mode,
    status: "running" as const,
    revision: 0,
  });
}

export function closeExecutionSession(
  session: ExecutionSession,
  expectedRevision: number,
): ExecutionSession {
  if (session.revision !== expectedRevision) {
    fail("STALE_REVISION", "The execution session changed since it was read.");
  }
  if (session.status !== "running") {
    fail("INVALID_TRANSITION", "Only a running execution session can be closed.");
  }
  return deepFreeze({ ...session, status: "closed" as const, revision: session.revision + 1 });
}
