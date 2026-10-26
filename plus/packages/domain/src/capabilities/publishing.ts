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

export interface PublishingStageDefinition {
  readonly key: string;
  readonly label: string;
}

export interface CompiledPublishingArtifact {
  readonly version: 1;
  readonly schemaVersion: 1;
  readonly stages: readonly PublishingStageDefinition[];
}

export interface ResultDecision {
  readonly rank: number;
  readonly contestantId: string;
  readonly score: string;
}

export interface ResultAward {
  readonly award: string;
  readonly contestantId: string;
}

export interface ResultSnapshot {
  readonly activityTitle: string;
  readonly publicTitle: string;
  readonly stageKey: string;
  readonly decisions: readonly ResultDecision[];
  readonly awards: readonly ResultAward[];
}

const DEFAULT_STAGE: PublishingStageDefinition = { key: "final_podium", label: "正式赛果" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStages(value: unknown): PublishingStageDefinition[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const stages: PublishingStageDefinition[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    if (typeof raw.key !== "string" || !raw.key.trim()) return null;
    if (typeof raw.label !== "string" || !raw.label.trim()) return null;
    stages.push({ key: raw.key.trim(), label: raw.label.trim() });
  }
  if (new Set(stages.map((stage) => stage.key)).size !== stages.length) return null;
  return stages;
}

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

export function createPublishingDefinition(
  stages: readonly PublishingStageDefinition[],
): CapabilityDefinition {
  return {
    schemaVersion: 1,
    payload: {
      version: 1,
      schemaVersion: 1,
      stages: stages.map((stage) => ({ key: stage.key, label: stage.label })),
    },
  };
}

export function createEmptyPublishingDefinition(): CapabilityDefinition {
  return createPublishingDefinition([DEFAULT_STAGE]);
}

export function compilePublishingDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  if (definition.schemaVersion !== 1 || !isRecord(definition.payload)) {
    return deepFreeze({
      ok: false,
      issues: [issue("PAYLOAD_INVALID", "Not a publishing definition.", "payload")],
    });
  }
  const payload = definition.payload;
  if (payload.version !== 1 || payload.schemaVersion !== 1) {
    return deepFreeze({
      ok: false,
      issues: [issue("PAYLOAD_INVALID", "Unsupported publishing definition version.", "payload")],
    });
  }
  const stages = parseStages(payload.stages);
  if (stages === null) {
    return deepFreeze({
      ok: false,
      issues: [
        issue(
          "STAGES_INVALID",
          "Publishing stages must be non-empty, unique, and have a key and label.",
          "payload.stages",
        ),
      ],
    });
  }
  const artifact: CompiledPublishingArtifact = { version: 1, schemaVersion: 1, stages };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "publishing",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export function decodePublishingArtifact(value: unknown): CompiledPublishingArtifact {
  if (!isRecord(value) || value.version !== 1 || value.schemaVersion !== 1) {
    fail("RELEASE_SNAPSHOT_INCOMPLETE", "The publishing release artifact version is unsupported.");
  }
  const stages = parseStages(value.stages);
  if (stages === null) {
    fail("RELEASE_SNAPSHOT_INCOMPLETE", "The publishing release artifact has no valid stages.");
  }
  return deepFreeze({ version: 1, schemaVersion: 1, stages });
}

export function validateAwards(
  decisions: readonly ResultDecision[],
  awards: readonly ResultAward[],
): void {
  const contestants = new Set(decisions.map((decision) => decision.contestantId));
  const labels = new Set<string>();
  for (const award of awards) {
    const label = award.award.trim();
    if (!label) fail("AWARD_INVALID", "An award label is required.");
    if (labels.has(label)) fail("AWARD_INVALID", `Award ${label} is duplicated.`);
    labels.add(label);
    if (!contestants.has(award.contestantId)) {
      fail("AWARD_INVALID", `Award ${label} names a contestant outside the confirmed decisions.`);
    }
  }
}

export function buildResultSnapshot(input: {
  readonly activityTitle: string;
  readonly stageKey: string;
  readonly stageLabel: string;
  readonly decisions: readonly ResultDecision[];
  readonly awards: readonly ResultAward[];
}): ResultSnapshot {
  const decisions = input.decisions.map((decision) => ({ ...decision }));
  const awards = input.awards.map((award) => ({ ...award }));
  return deepFreeze({
    activityTitle: input.activityTitle,
    publicTitle: `${input.activityTitle} · ${input.stageLabel}`,
    stageKey: input.stageKey,
    decisions,
    awards,
  });
}

export const publishingCompiler: CapabilityCompiler = {
  capabilityKey: "publishing",
  compile: compilePublishingDefinition,
};

export const publishingCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "publishing",
    version: "1",
    dependencies: ["competition"],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "publishing.stage_result.confirm",
      "publishing.stage_result.unlock",
      "publishing.result.release",
      "publishing.result.revoke",
      "publishing.publication.edit",
    ],
    queries: ["publishing.state.read", "publishing.public_results.read"],
    events: [
      "StageResultConfirmed",
      "StageResultUnlocked",
      "ResultReleased",
      "ResultReleaseRevoked",
      "ResultReleaseSuperseded",
      "ResultPublicationEdited",
    ],
    permissions: ["result.manage"],
    surfaces: ["studio", "ops", "portal"],
    scopes: ["publishing"],
  },
  compiler: publishingCompiler,
  emptyDefinition: createEmptyPublishingDefinition,
});
