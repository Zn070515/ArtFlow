/** The first ArtFlow-Plus vertical slice: thin activity, definition package, execution session. */

export type ActivityStatus = "draft" | "active" | "closed" | "archived";

/**
 * Activity is deliberately thin: identity, lifecycle, enabled capabilities and
 * the active definition release. Capability state lives in its own capability.
 */
export interface Activity {
  readonly id: string;
  readonly title: string;
  readonly status: ActivityStatus;
  /** Monotonic revision for activity-level commands (CONC-01). */
  readonly revision: number;
  readonly enabledCapabilities: readonly string[];
  /** Number of activity definition releases. */
  readonly activeDefinitionVersion: number;
}

/**
 * A capability owns its own definition language. The Activity compiler only
 * sees an opaque, versioned payload; it must never understand competition
 * nodes such as `round` or `roster`.
 */
export interface CapabilityDefinition {
  readonly schemaVersion: 1;
  readonly payload: unknown;
}

export interface CapabilityCompiler {
  readonly capabilityKey: string;
  compile(definition: CapabilityDefinition): CapabilityCompileResult;
}

export interface CapabilityBinding {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
}

/**
 * The Activity Definition Package coordinates capability definitions and the
 * bindings between them. It is not one universal workflow graph.
 */
export interface ActivityDefinitionPackage {
  readonly schemaVersion: 1;
  readonly manifest: {
    readonly key: string;
    readonly title: string;
  };
  readonly capabilities: Readonly<Record<string, CapabilityDefinition>>;
  readonly bindings?: readonly CapabilityBinding[];
}

/** A draft is the only editable definition surface. */
export interface DefinitionDraft {
  readonly activityId: string;
  readonly revision: number;
  readonly status: "draft";
  readonly package: ActivityDefinitionPackage;
}

export interface CompiledCapabilityPlan {
  readonly ok: true;
  readonly capabilityKey: string;
  readonly contentHash: string;
  /** Capability-owned compiled artifact; opaque to the Activity compiler. */
  readonly artifact: unknown;
}

export interface CompileIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface CompileFailure {
  readonly ok: false;
  readonly issues: readonly CompileIssue[];
}

export type CapabilityCompileResult = CompiledCapabilityPlan | CompileFailure;

export interface CompiledActivityDefinition {
  readonly ok: true;
  readonly contentHash: string;
  readonly capabilities: Readonly<Record<string, CompiledCapabilityPlan>>;
}

export type PackageCompileResult = CompiledActivityDefinition | CompileFailure;

/**
 * The execution semantics frozen with a release. A later code deployment may
 * not redefine what an already-released definition means: starting a session
 * reads this snapshot, never the current registry policy.
 */
export interface ExecutionPolicy {
  readonly declaredScopes: readonly string[];
  readonly conflicts: ScopeConflictPolicy;
  readonly runtimeContractVersion: number;
}

export const RUNTIME_CONTRACT_VERSION = 1;

/** A released definition package is immutable; corrections release a new version. */
export interface ReleasedActivityDefinition {
  readonly activityId: string;
  readonly version: number;
  readonly status: "released";
  readonly contentHash: string;
  readonly capabilities: Readonly<Record<string, CompiledCapabilityPlan>>;
  /** Capability implementation versions captured at release time. */
  readonly capabilityVersions: Readonly<Record<string, string>>;
  readonly executionPolicy: ExecutionPolicy;
  readonly bindings: readonly CapabilityBinding[];
  readonly releasedAt: string;
}

export type DefinitionVersion = DefinitionDraft | ReleasedActivityDefinition;

export type ExecutionMode = "test" | "rehearsal" | "formal";

export interface ExecutionSession {
  readonly id: string;
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly contentHash: string;
  readonly scope: string;
  readonly mode: ExecutionMode;
  readonly status: "running" | "closed";
  readonly revision: number;
}

/**
 * Which execution scopes cannot run at the same time. The plan is supplied by
 * the capability composition; the kernel does not hard-code scope names.
 */
export type ScopeConflictPolicy = Readonly<Record<string, readonly string[]>>;

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
