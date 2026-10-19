/** The first ArtFlow-Plus vertical slice: activity → definition → execution. */

export type ActivityStatus = "draft" | "active" | "archived";

export interface Activity {
  readonly id: string;
  readonly title: string;
  readonly status: ActivityStatus;
  /** Monotonic revision for activity-level commands (CONC-01). */
  readonly revision: number;
  /** Number of definitions released for this activity. */
  readonly definitionVersion: number;
}

export type NodeType = "roster" | "round" | "aggregate" | "output";

export interface DefinitionNode {
  readonly key: string;
  readonly type: NodeType;
  readonly label?: string;
}

export interface DefinitionEdge {
  readonly from: string;
  readonly to: string;
}

export interface DefinitionDocument {
  readonly schemaVersion: 1;
  readonly nodes: readonly DefinitionNode[];
  readonly edges: readonly DefinitionEdge[];
}

/** A draft is the only editable definition surface. */
export interface DefinitionDraft {
  readonly activityId: string;
  readonly revision: number;
  readonly status: "draft";
  readonly document: DefinitionDocument;
}

export type DefinitionVersion = DefinitionDraft | ReleasedDefinition;

export interface CompiledPlan {
  readonly ok: true;
  readonly order: readonly string[];
  readonly contentHash: string;
  readonly nodes: readonly DefinitionNode[];
  readonly edges: readonly DefinitionEdge[];
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

export type CompileResult = CompiledPlan | CompileFailure;

/** A released definition is immutable; corrections release a new version. */
export interface ReleasedDefinition {
  readonly activityId: string;
  readonly version: number;
  readonly status: "released";
  readonly contentHash: string;
  readonly plan: CompiledPlan;
  readonly releasedAt: string;
}

export type ExecutionRunStatus = "running" | "closed";

export interface ExecutionRun {
  readonly id: string;
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly contentHash: string;
  readonly status: ExecutionRunStatus;
  readonly revision: number;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
