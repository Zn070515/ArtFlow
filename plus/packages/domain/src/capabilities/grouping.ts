import { capabilityDefinitionHash } from "../compiler.js";
import { fail } from "../errors.js";
import type {
  CapabilityCompileResult,
  CapabilityCompiler,
  CapabilityDefinition,
  CompileIssue,
  CompiledCapabilityPlan,
} from "../model.js";
import { deepFreeze } from "../model.js";
import type { CapabilityRegistration } from "../registry.js";

export type GroupingRosterSource = "all_approved" | "round_advanced";
export type GroupingStageStatus = "draft" | "confirmed" | "frozen" | "cancelled";
export type GroupingMaterialWindow = "closed" | "open" | "supplement_only";

export interface GroupingDefinition {
  readonly schemaVersion: 1;
  readonly groupCount?: number;
}

export interface CompiledGroupingArtifact {
  readonly schemaVersion: 1;
  readonly groupCount?: number;
}

export interface GroupingGroupSpec {
  readonly name?: string;
  readonly participantIds: readonly string[];
}

export interface NormalizedGroupingGroup {
  readonly name: string;
  readonly participantIds: readonly string[];
}

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

export function createGroupingDefinition(groupCount?: number): CapabilityDefinition {
  const payload: GroupingDefinition =
    groupCount === undefined ? { schemaVersion: 1 } : { schemaVersion: 1, groupCount };
  return { schemaVersion: 1, payload };
}

export function createEmptyGroupingDefinition(): CapabilityDefinition {
  return createGroupingDefinition();
}

export function compileGroupingDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const payload = definition.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return deepFreeze({
      ok: false,
      issues: [issue("PAYLOAD_INVALID", "Not a grouping definition.", "payload")],
    });
  }
  const candidate = payload as Partial<GroupingDefinition>;
  const issues: CompileIssue[] = [];
  if (candidate.schemaVersion !== 1) {
    issues.push(issue("SCHEMA_VERSION", "Only schemaVersion 1 is supported.", "schemaVersion"));
  }
  if (
    candidate.groupCount !== undefined &&
    (!Number.isInteger(candidate.groupCount) || candidate.groupCount < 1)
  ) {
    issues.push(issue("GROUP_COUNT_INVALID", "groupCount must be a positive integer.", "groupCount"));
  }
  if (issues.length > 0) return deepFreeze({ ok: false, issues });

  const artifact: CompiledGroupingArtifact =
    candidate.groupCount === undefined
      ? { schemaVersion: 1 }
      : { schemaVersion: 1, groupCount: candidate.groupCount };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "grouping",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export const groupingCompiler: CapabilityCompiler = {
  capabilityKey: "grouping",
  compile: compileGroupingDefinition,
};

/**
 * The single authority for turning external group specs into a stage partition.
 * Drafts may be incomplete; confirm/freeze/correct must cover the source roster.
 */
export function normalizeGroupingGroups(
  specs: readonly GroupingGroupSpec[],
  allowedParticipantIds: ReadonlySet<string>,
  options: { readonly complete: boolean; readonly groupCount?: number },
): readonly NormalizedGroupingGroup[] {
  if (!Array.isArray(specs) || specs.length === 0) {
    fail("INVALID_INPUT", "A grouping stage needs at least one group.");
  }
  const names = new Set<string>();
  const seen = new Set<string>();
  const normalized: NormalizedGroupingGroup[] = [];

  specs.forEach((spec, index) => {
    const name = (spec.name ?? "").trim() || `第 ${index + 1} 组`;
    if (names.has(name)) fail("INVALID_INPUT", `Group name ${name} is duplicated.`);
    names.add(name);
    if (!Array.isArray(spec.participantIds) || spec.participantIds.length === 0) {
      fail("INVALID_INPUT", `Group ${name} must contain at least one participant.`);
    }
    const members: string[] = [];
    for (const rawId of spec.participantIds) {
      const participantId = String(rawId).trim();
      if (!allowedParticipantIds.has(participantId)) {
        fail("GROUPING_SOURCE_UNKNOWN", "A group member is not in the source roster.");
      }
      if (seen.has(participantId)) {
        fail("INVALID_INPUT", "A participant cannot belong to two groups.");
      }
      seen.add(participantId);
      members.push(participantId);
    }
    normalized.push({ name, participantIds: members });
  });

  if (options.complete) {
    const missing = [...allowedParticipantIds].filter((id) => !seen.has(id)).sort();
    if (missing.length > 0) {
      fail("GROUPING_INCOMPLETE", `The partition is missing participants: ${missing.join(",")}.`);
    }
    if (seen.size !== allowedParticipantIds.size) {
      fail("GROUPING_INCOMPLETE", "The partition does not exactly cover the source roster.");
    }
  }
  if (options.groupCount !== undefined && normalized.length !== options.groupCount) {
    fail(
      "GROUPING_GROUP_COUNT",
      `The stage needs exactly ${options.groupCount} groups, received ${normalized.length}.`,
    );
  }
  return deepFreeze(normalized);
}

export const groupingCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "grouping",
    version: "1",
    dependencies: ["registration", "competition"],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "grouping.stage.create",
      "grouping.groups.record",
      "grouping.stage.confirm",
      "grouping.stage.freeze",
      "grouping.stage.correct",
      "grouping.stage.cancel",
      "grouping.window.set",
    ],
    queries: ["grouping.describe"],
    events: [
      "GroupingStageCreated",
      "GroupingGroupsRecorded",
      "GroupingStageConfirmed",
      "GroupingStageFrozen",
      "GroupingStageCorrected",
      "GroupingStageCancelled",
      "GroupingMaterialWindowChanged",
    ],
    permissions: ["grouping.manage"],
    surfaces: ["ops"],
    scopes: [],
  },
  compiler: groupingCompiler,
  emptyDefinition: createEmptyGroupingDefinition,
});
