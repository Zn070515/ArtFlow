import { capabilityDefinitionHash } from "../compiler.js";
import type {
  CapabilityCompileResult,
  CapabilityCompiler,
  CapabilityDefinition,
  CompileIssue,
  CompiledCapabilityPlan,
} from "../model.js";
import { deepFreeze } from "../model.js";
import type { CapabilityRegistration } from "../registry.js";

export type TeamsSource = "manual" | "grouping";
export type TeamStatus = "draft" | "frozen" | "withdrawn";
export type TeamMemberRole = "member" | "captain";

export interface TeamsDefinition {
  readonly schemaVersion: 1;
  readonly minSize: number;
  readonly maxSize: number;
  readonly requireCaptain: boolean;
  readonly source: TeamsSource;
}

export type CompiledTeamsArtifact = TeamsDefinition;

const SOURCES: readonly TeamsSource[] = ["manual", "grouping"];

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

export function createTeamsDefinition(
  options: Partial<Omit<TeamsDefinition, "schemaVersion">> = {},
): CapabilityDefinition {
  const payload: TeamsDefinition = {
    schemaVersion: 1,
    minSize: options.minSize ?? 1,
    maxSize: options.maxSize ?? 8,
    requireCaptain: options.requireCaptain ?? false,
    source: options.source ?? "manual",
  };
  return { schemaVersion: 1, payload };
}

export function createEmptyTeamsDefinition(): CapabilityDefinition {
  return createTeamsDefinition();
}

export function compileTeamsDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const payload = definition.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return deepFreeze({ ok: false, issues: [issue("PAYLOAD_INVALID", "Not a teams definition.", "payload")] });
  }
  const candidate = payload as Partial<TeamsDefinition>;
  const issues: CompileIssue[] = [];
  if (candidate.schemaVersion !== 1) {
    issues.push(issue("SCHEMA_VERSION", "Only schemaVersion 1 is supported.", "schemaVersion"));
  }
  if (
    !Number.isInteger(candidate.minSize) ||
    (candidate.minSize ?? 0) < 1 ||
    (candidate.minSize ?? 0) > 64
  ) {
    issues.push(issue("TEAM_MIN_SIZE_INVALID", "minSize must be an integer between 1 and 64.", "minSize"));
  }
  if (
    !Number.isInteger(candidate.maxSize) ||
    (candidate.maxSize ?? 0) < 1 ||
    (candidate.maxSize ?? 0) > 64
  ) {
    issues.push(issue("TEAM_MAX_SIZE_INVALID", "maxSize must be an integer between 1 and 64.", "maxSize"));
  }
  if (
    Number.isInteger(candidate.minSize) &&
    Number.isInteger(candidate.maxSize) &&
    (candidate.minSize ?? 0) > (candidate.maxSize ?? 0)
  ) {
    issues.push(issue("TEAM_SIZE_RANGE_INVALID", "minSize cannot exceed maxSize.", "minSize"));
  }
  if (typeof candidate.requireCaptain !== "boolean") {
    issues.push(issue("TEAM_CAPTAIN_FLAG_INVALID", "requireCaptain must be a boolean.", "requireCaptain"));
  }
  if (candidate.source === undefined || !SOURCES.includes(candidate.source)) {
    issues.push(issue("TEAM_SOURCE_INVALID", "source must be manual or grouping.", "source"));
  }
  if (issues.length > 0) return deepFreeze({ ok: false, issues });

  const artifact: CompiledTeamsArtifact = {
    schemaVersion: 1,
    minSize: candidate.minSize as number,
    maxSize: candidate.maxSize as number,
    requireCaptain: candidate.requireCaptain as boolean,
    source: candidate.source as TeamsSource,
  };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "teams",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export const teamsCompiler: CapabilityCompiler = {
  capabilityKey: "teams",
  compile: compileTeamsDefinition,
};

export const teamsCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "teams",
    version: "1.0.0",
    dependencies: ["registration"],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "teams.team.create",
      "teams.team.update",
      "teams.team.member.add",
      "teams.team.member.remove",
      "teams.team.withdraw",
      "teams.roster.freeze",
      "teams.roster.correct",
      "teams.roster.import_grouping",
    ],
    queries: ["teams.read"],
    events: [
      "TeamCreated",
      "TeamUpdated",
      "TeamMemberAdded",
      "TeamMemberRemoved",
      "TeamWithdrawn",
      "TeamRosterFrozen",
      "TeamRosterCorrected",
      "TeamRosterImportedFromGrouping",
    ],
    permissions: ["teams.manage", "teams.roster.correct"],
    surfaces: ["studio", "ops"],
    scopes: [],
  },
  compiler: teamsCompiler,
  emptyDefinition: createEmptyTeamsDefinition,
});
