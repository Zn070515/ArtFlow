import type { ActivityDefinitionPackage, CapabilityDefinition, CompiledActivityDefinition } from "./model.js";
import type { CapabilityRegistry, CompositionPlan, RegistryIssue } from "./registry.js";
import type { ActivityPack, PackInstantiationInput } from "./packs.js";
import { instantiateActivityPack } from "./packs.js";
import { compileActivityDefinitionPackage } from "./compiler.js";
import {
  createCompetitionDefinition,
  type CompetitionRubricCriterion,
} from "./capabilities/competition.js";
import { createGroupingDefinition } from "./capabilities/grouping.js";
import { createMaterialsDefinition } from "./capabilities/materials.js";
import { createPublishingDefinition } from "./capabilities/publishing.js";
import {
  createQuestionnaireDefinition,
  type QuestionnaireQuestion,
} from "./capabilities/questionnaire.js";
import {
  createRegistrationDefinition,
  type RegistrationLifecycle,
} from "./capabilities/registration.js";

/**
 * Operational adoption is a semantic translation, not a copy of rows into an
 * unrelated pack. The v1 bundle supplies the questionnaire, rounds, rubric and
 * grouping shape; the selected Pack supplies only the composition and the
 * capabilities that the bundle does not describe.
 */
export interface AdoptionBundleFacts {
  readonly title: string;
  readonly questionnaire: {
    readonly version: string;
    readonly questions: readonly {
      readonly key: string;
      readonly label: string;
      readonly type: string;
      readonly required: boolean;
    }[];
  };
  readonly rounds: readonly {
    readonly key: string;
    readonly judgeCount: number;
    readonly minimumJudges: number;
    readonly completion: "full_matrix" | "minimum_valid";
    readonly scoringMethod: "average" | "drop_high_low";
    readonly advanceCount: number;
  }[];
  readonly rubric: {
    readonly criteria: readonly CompetitionRubricCriterion[];
    readonly tiePolicy: string;
  };
  readonly grouping?: {
    readonly stageCount: number;
    readonly groupCount?: number;
  };
  readonly registrationLifecycle: RegistrationLifecycle;
  readonly hasRegistrations: boolean;
  readonly hasMaterials: boolean;
  readonly materialContentTypes: readonly string[];
}

export interface BuildAdoptionDefinitionInput extends PackInstantiationInput {
  readonly pack: ActivityPack;
  readonly registry: CapabilityRegistry;
  readonly facts: AdoptionBundleFacts;
}

export type AdoptionDefinitionResult =
  | {
      readonly ok: true;
      readonly capabilities: readonly string[];
      readonly definition: ActivityDefinitionPackage;
      readonly compiled: CompiledActivityDefinition;
      readonly composition: CompositionPlan;
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly issues: readonly RegistryIssue[] };

function issue(code: string, message: string, path: string): RegistryIssue {
  return { code, message, path };
}

function questionnaireQuestions(facts: AdoptionBundleFacts): QuestionnaireQuestion[] {
  return facts.questionnaire.questions.map((question) => {
    const isFile = question.type === "file" || question.type === "materials";
    return {
      key: question.key,
      label: question.label,
      type: isFile ? "file" : "text",
      required: question.required,
      ...(isFile
        ? {
            file: {
              slot: question.key,
              purpose: "document",
              accepts: ["*/*"],
            },
          }
        : {}),
    };
  });
}

function materialPurposes(facts: AdoptionBundleFacts): readonly string[] {
  const purposes = new Set<string>();
  for (const contentType of facts.materialContentTypes) {
    if (contentType.startsWith("audio/")) purposes.add("audio");
    else if (contentType.startsWith("video/")) purposes.add("video");
    else if (contentType.startsWith("image/")) purposes.add("image");
    else purposes.add("document");
  }
  return purposes.size === 0 ? ["audio", "video", "image", "document"] : [...purposes].sort();
}

function competitionDefinition(facts: AdoptionBundleFacts): CapabilityDefinition {
  const roundKeys = facts.rounds.map((round) => round.key);
  const nodes = [
    { key: "roster", type: "roster" as const },
    ...roundKeys.map((key) => ({ key, type: "round" as const })),
    { key: "result", type: "output" as const },
  ];
  const edges = [
    { from: "roster", to: roundKeys[0] ?? "result" },
    ...roundKeys.slice(1).map((key, index) => ({ from: roundKeys[index]!, to: key })),
    { from: roundKeys[roundKeys.length - 1] ?? "roster", to: "result" },
  ];
  return createCompetitionDefinition(nodes, edges, {
    rounds: facts.rounds.map((round) => ({
      key: round.key,
      judgeCount: round.judgeCount,
      minimumJudges: round.minimumJudges,
      completion: round.completion,
      advanceCount: round.advanceCount,
      scoringMethod: round.scoringMethod,
    })),
    rubric: { criteria: facts.rubric.criteria },
    tiePolicy: "review",
  });
}

function publishingDefinition(enabled: ReadonlySet<string>): CapabilityDefinition {
  const stages: { key: string; label: string }[] = [];
  if (enabled.has("competition")) stages.push({ key: "final_podium", label: "正式赛果" });
  if (enabled.has("voting")) stages.push({ key: "vote_result", label: "投票结果" });
  return createPublishingDefinition(stages);
}

/**
 * Builds an adoption definition whose frozen artifacts describe the same rules
 * as the imported facts. Every override is conditional on the capability being
 * part of the selected pack composition.
 */
export function buildAdoptionDefinition(
  input: BuildAdoptionDefinitionInput,
): AdoptionDefinitionResult {
  const instantiated = instantiateActivityPack(input.pack, input.registry, {
    title: input.facts.title,
    ...(input.answers === undefined ? {} : { answers: input.answers }),
    ...(input.enable === undefined ? {} : { enable: input.enable }),
    ...(input.disable === undefined ? {} : { disable: input.disable }),
  });
  if (!instantiated.ok) {
    return { ok: false, issues: instantiated.issues };
  }
  const composition = input.registry.validateComposition({
    enable: instantiated.instantiation.enabledCapabilities,
  });
  if (!composition.ok) {
    return { ok: false, issues: composition.issues };
  }
  const enabled = new Set(composition.plan.enabledCapabilities);
  const issues: RegistryIssue[] = [];
  if (input.facts.hasRegistrations && !enabled.has("registration")) {
    issues.push(issue("ADOPTION_CAPABILITY_MISSING", "The bundle has registrations but registration is not enabled.", "capabilities.registration"));
  }
  if (input.facts.hasRegistrations && !enabled.has("questionnaire")) {
    issues.push(issue("ADOPTION_CAPABILITY_MISSING", "The bundle has questionnaire answers but questionnaire is not enabled.", "capabilities.questionnaire"));
  }
  if (input.facts.hasMaterials && !enabled.has("materials")) {
    issues.push(issue("ADOPTION_CAPABILITY_MISSING", "The bundle has materials but materials is not enabled.", "capabilities.materials"));
  }
  if (input.facts.rounds.length > 0 && !enabled.has("competition")) {
    issues.push(issue("ADOPTION_CAPABILITY_MISSING", "The bundle has competition rounds but competition is not enabled.", "capabilities.competition"));
  }
  if (input.facts.grouping !== undefined && !enabled.has("grouping")) {
    issues.push(issue("ADOPTION_CAPABILITY_MISSING", "The bundle has grouping facts but grouping is not enabled.", "capabilities.grouping"));
  }
  if (input.facts.rubric.tiePolicy !== "review") {
    issues.push(issue("ADOPTION_RUBRIC_INCOMPATIBLE", "Only explicit review tie handling can be adopted.", "rubric.tiePolicy"));
  }
  if (issues.length > 0) return { ok: false, issues };

  const warnings: string[] = [];
  const capabilities: Record<string, CapabilityDefinition> = {
    ...instantiated.instantiation.definition.capabilities,
  };
  if (enabled.has("questionnaire")) {
    capabilities.questionnaire = createQuestionnaireDefinition(
      input.facts.questionnaire.version,
      questionnaireQuestions(input.facts),
    );
  }
  if (enabled.has("registration")) {
    capabilities.registration = createRegistrationDefinition(input.facts.registrationLifecycle);
  }
  if (enabled.has("competition")) {
    capabilities.competition = competitionDefinition(input.facts);
  }
  if (enabled.has("materials")) {
    capabilities.materials = createMaterialsDefinition(25 * 1024 * 1024, materialPurposes(input.facts));
  }
  if (enabled.has("grouping") && input.facts.grouping !== undefined) {
    if (input.facts.grouping.stageCount > 1) {
      warnings.push("Multiple grouping stages share one groupCount; the release leaves groupCount unconstrained.");
    }
    capabilities.grouping = createGroupingDefinition(
      input.facts.grouping.stageCount === 1 ? input.facts.grouping.groupCount : undefined,
    );
  }
  if (enabled.has("publishing")) {
    capabilities.publishing = publishingDefinition(enabled);
  }

  const definition: ActivityDefinitionPackage = {
    ...instantiated.instantiation.definition,
    capabilities,
  };
  const compiled = compileActivityDefinitionPackage(definition, input.registry.compilers);
  if (!compiled.ok) {
    return {
      ok: false,
      issues: compiled.issues.map((item) =>
        issue("ADOPTION_DEFINITION_INVALID", `${item.code}: ${item.message}`, item.path),
      ),
    };
  }
  return {
    ok: true,
    capabilities: composition.plan.enabledCapabilities,
    definition,
    compiled,
    composition: composition.plan,
    warnings,
  };
}
