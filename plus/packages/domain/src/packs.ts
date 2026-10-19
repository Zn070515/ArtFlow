import { compileActivityDefinitionPackage } from "./compiler.js";
import type { ActivityDefinitionPackage, CompileIssue } from "./model.js";
import { deepFreeze } from "./model.js";
import type { CapabilityRegistry, RegistryIssue } from "./registry.js";

/**
 * One Guided Mode question. Answering yes enables the capability; the answer
 * is composition input, never a capability definition by itself.
 */
export interface ActivityPackQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly capability: string;
  readonly default: boolean;
}

/**
 * An opinionated capability composition with safe defaults. A Pack is data,
 * not an Activity subclass: it produces a Definition Package, then gets out of
 * the way.
 */
export interface ActivityPack {
  readonly identity: string;
  readonly version: string;
  readonly title: string;
  readonly baselineCapabilities: readonly string[];
  readonly questions: readonly ActivityPackQuestion[];
}

export interface PackInstantiationInput {
  readonly title?: string;
  readonly answers?: Readonly<Record<string, boolean>>;
  readonly enable?: readonly string[];
  readonly disable?: readonly string[];
}

export interface PackInstantiation {
  readonly pack: { readonly identity: string; readonly version: string };
  readonly enabledCapabilities: readonly string[];
  readonly definition: ActivityDefinitionPackage;
}

export type PackInstantiationResult =
  | { readonly ok: true; readonly instantiation: PackInstantiation }
  | { readonly ok: false; readonly issues: readonly RegistryIssue[] };

export const SINGER_COMPETITION_PACK: ActivityPack = deepFreeze({
  identity: "singer-competition",
  version: "1",
  title: "Singer Competition",
  baselineCapabilities: ["competition"],
  questions: [
    {
      id: "registration-required",
      prompt: "报名是否必需？",
      capability: "registration",
      default: true,
    },
    {
      id: "questionnaire",
      prompt: "报名时是否需要问卷？",
      capability: "questionnaire",
      default: true,
    },
    {
      id: "collect-materials",
      prompt: "节目是否需要提交材料？",
      capability: "materials",
      default: true,
    },
    {
      id: "audience-voting",
      prompt: "是否需要观众投票？",
      capability: "voting",
      default: false,
    },
    {
      id: "publish-results",
      prompt: "是否需要公开发布结果？",
      capability: "publishing",
      default: true,
    },
    {
      id: "archive",
      prompt: "结束后是否归档？",
      capability: "archive",
      default: true,
    },
  ],
});

function issue(code: string, message: string, path: string): RegistryIssue {
  return { code, message, path };
}

function definitionIssue(item: CompileIssue): RegistryIssue {
  return issue(
    "PACK_DEFINITION_INVALID",
    `${item.code}: ${item.message}`,
    item.path,
  );
}

/**
 * Resolves a Pack against a registry. Missing capabilities are diagnostics, not
 * partial success: a pack either produces one compilable Definition Package or
 * explains exactly what is absent or contradictory.
 */
export function instantiateActivityPack(
  pack: ActivityPack,
  registry: CapabilityRegistry,
  input: PackInstantiationInput = {},
): PackInstantiationResult {
  const issues: RegistryIssue[] = [];
  const questions = new Map(pack.questions.map((question) => [question.id, question]));
  for (const answerId of Object.keys(input.answers ?? {})) {
    if (!questions.has(answerId)) {
      issues.push(
        issue(
          "PACK_ANSWER_UNKNOWN",
          `Pack ${pack.identity} has no guided question ${answerId}.`,
          `answers.${answerId}`,
        ),
      );
    }
  }

  const enabled = new Set(pack.baselineCapabilities);
  for (const question of pack.questions) {
    const answer = input.answers?.[question.id] ?? question.default;
    if (answer) enabled.add(question.capability);
  }
  for (const identity of input.enable ?? []) enabled.add(identity);
  const disabled = [...new Set(input.disable ?? [])].sort();
  for (const identity of disabled) enabled.delete(identity);

  const composition = registry.validateComposition({
    enable: [...enabled].sort(),
    disable: disabled,
  });
  if (!composition.ok) {
    return deepFreeze({
      ok: false as const,
      issues: Object.freeze([...issues, ...composition.issues]),
    });
  }
  if (composition.plan.enabledCapabilities.length === 0) {
    issues.push(
      issue(
        "PACK_COMPOSITION_EMPTY",
        `Pack ${pack.identity} resolves to no capabilities.`,
        "capabilities",
      ),
    );
    return deepFreeze({ ok: false as const, issues: Object.freeze(issues) });
  }

  const capabilities: Record<string, ActivityDefinitionPackage["capabilities"][string]> = {};
  for (const identity of composition.plan.enabledCapabilities) {
    const registration = registry.get(identity);
    if (registration === undefined) continue;
    const definition = registration.emptyDefinition();
    if (definition.schemaVersion !== registration.manifest.definitionSchemaVersion) {
      issues.push(
        issue(
          "CAPABILITY_DEFINITION_VERSION",
          `Capability ${identity} produced schemaVersion ${definition.schemaVersion}, expected ${registration.manifest.definitionSchemaVersion}.`,
          `capabilities.${identity}`,
        ),
      );
      continue;
    }
    capabilities[identity] = definition;
  }
  if (issues.length > 0) {
    return deepFreeze({ ok: false as const, issues: Object.freeze(issues) });
  }

  const definition: ActivityDefinitionPackage = {
    schemaVersion: 1,
    manifest: {
      key: pack.identity,
      title: input.title ?? pack.title,
    },
    capabilities,
    bindings: [],
  };
  const compiled = compileActivityDefinitionPackage(definition, registry.compilers);
  if (!compiled.ok) {
    return deepFreeze({
      ok: false as const,
      issues: Object.freeze(compiled.issues.map(definitionIssue)),
    });
  }

  return deepFreeze({
    ok: true as const,
    instantiation: {
      pack: { identity: pack.identity, version: pack.version },
      enabledCapabilities: composition.plan.enabledCapabilities,
      definition,
    },
  });
}
