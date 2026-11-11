import { compileActivityDefinitionPackage } from "./compiler.js";
import type { ActivityDefinitionPackage, CapabilityDefinition, CompileIssue } from "./model.js";
import { deepFreeze } from "./model.js";
import type { CapabilityRegistry, RegistryIssue } from "./registry.js";

/**
 * One Guided Mode question. Answering yes enables the capability unless
 * `enables` is false. A non-enabling question only selects a definition
 * choice. Either way the answer is composition input, never a capability
 * definition by itself.
 */
export interface ActivityPackQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly capability: string;
  readonly default: boolean;
  /** When false, the answer does not add `capability`. Default true. */
  readonly enables?: boolean;
}

/**
 * Replaces one capability definition when a guided answer is true.
 * A false answer keeps `definitions[capability]` (or the empty definition)
 * and may enable the capabilities listed in `enableWhenFalse`.
 */
export interface ActivityPackDefinitionChoice {
  readonly questionId: string;
  readonly whenTrue: CapabilityDefinition;
  readonly enableWhenTrue?: readonly string[];
  readonly enableWhenFalse?: readonly string[];
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
  /** Optional capability definitions that replace emptyDefinition(). */
  readonly definitions?: Readonly<Record<string, CapabilityDefinition>>;
  /**
   * Applied only when that capability is already enabled. A true answer
   * selects `whenTrue`; a false answer keeps the pack or empty definition.
   */
  readonly definitionChoices?: Readonly<Record<string, ActivityPackDefinitionChoice>>;
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
    if (question.enables === false) continue;
    const answer = input.answers?.[question.id] ?? question.default;
    if (answer) enabled.add(question.capability);
  }
  for (const identity of input.enable ?? []) enabled.add(identity);
  const disabled = [...new Set(input.disable ?? [])].sort();
  for (const identity of disabled) enabled.delete(identity);
  const disabledSet = new Set(disabled);
  for (const [capability, choice] of Object.entries(pack.definitionChoices ?? {})) {
    if (!enabled.has(capability)) continue;
    const question = questions.get(choice.questionId);
    if (question === undefined) {
      issues.push(
        issue(
          "PACK_DEFINITION_CHOICE_UNKNOWN",
          `Pack ${pack.identity} chooses ${capability} with unknown question ${choice.questionId}.`,
          `definitionChoices.${capability}`,
        ),
      );
      continue;
    }
    const selected = input.answers?.[choice.questionId] ?? question.default;
    const extras = selected ? choice.enableWhenTrue : choice.enableWhenFalse;
    for (const extra of extras ?? []) {
      if (!disabledSet.has(extra)) enabled.add(extra);
    }
  }

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
    const fallback = pack.definitions?.[identity] ?? registration.emptyDefinition();
    const choice = pack.definitionChoices?.[identity];
    const choiceQuestion = choice === undefined ? undefined : questions.get(choice.questionId);
    const definition = choice !== undefined &&
      choiceQuestion !== undefined &&
      (input.answers?.[choice.questionId] ?? choiceQuestion.default)
      ? choice.whenTrue
      : fallback;
    // The CapabilityDefinition envelope is always schemaVersion 1; the
    // capability's own definition language is versioned on its payload.
    const payload = definition.payload;
    const payloadSchemaVersion =
      typeof payload === "object" && payload !== null && "schemaVersion" in payload
        ? (payload as { schemaVersion: unknown }).schemaVersion
        : undefined;
    if (payloadSchemaVersion !== registration.manifest.definitionSchemaVersion) {
      issues.push(
        issue(
          "CAPABILITY_DEFINITION_VERSION",
          `Capability ${identity} produced schemaVersion ${String(payloadSchemaVersion)}, expected ${registration.manifest.definitionSchemaVersion}.`,
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
