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

export type QuestionnaireQuestionType = "text" | "file" | "notice";

export interface QuestionnaireFileSlot {
  readonly slot: string;
  readonly purpose: string;
  readonly accepts: readonly string[];
  readonly maxBytes?: number;
}

export interface QuestionnaireQuestion {
  readonly key: string;
  readonly label: string;
  readonly type: QuestionnaireQuestionType;
  readonly required?: boolean;
  readonly file?: QuestionnaireFileSlot;
}

export interface QuestionnaireDefinition {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly questions: readonly QuestionnaireQuestion[];
}

export interface CompiledQuestionnaireQuestion extends QuestionnaireQuestion {
  readonly required: boolean;
}

export interface CompiledQuestionnaireArtifact {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly schemaHash: string;
  readonly questions: readonly CompiledQuestionnaireQuestion[];
  readonly fileSlots: readonly (QuestionnaireFileSlot & { readonly key: string })[];
}

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseFile(value: unknown, path: string): QuestionnaireFileSlot | null {
  if (!isRecord(value)) {
    return null;
  }
  const slot = value.slot;
  const purpose = value.purpose;
  const accepts = value.accepts;
  if (
    typeof slot !== "string" ||
    !slot.trim() ||
    typeof purpose !== "string" ||
    !purpose.trim() ||
    !Array.isArray(accepts) ||
    accepts.length === 0 ||
    accepts.some((item) => typeof item !== "string" || !item.trim())
  ) {
    return null;
  }
  const maxBytes = value.maxBytes;
  if (maxBytes !== undefined && (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1)) {
    return null;
  }
  return {
    slot,
    purpose,
    accepts: [...new Set(accepts as string[])].sort(),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

function parseDefinition(value: unknown): QuestionnaireDefinition | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.version !== "string") {
    return null;
  }
  if (!Array.isArray(value.questions)) return null;
  return value as unknown as QuestionnaireDefinition;
}

export function compileQuestionnaireDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const payload = parseDefinition(definition.payload);
  if (payload === null) {
    return deepFreeze({
      ok: false,
      issues: [issue("PAYLOAD_INVALID", "Not a questionnaire definition.", "payload")],
    });
  }
  const issues: CompileIssue[] = [];
  if (!payload.version.trim()) {
    issues.push(issue("VERSION_REQUIRED", "A questionnaire version is required.", "version"));
  }
  const keys = new Set<string>();
  const questions: CompiledQuestionnaireQuestion[] = [];
  const fileSlots: (QuestionnaireFileSlot & { readonly key: string })[] = [];
  payload.questions.forEach((question, index) => {
    if (!isRecord(question)) {
      issues.push(issue("QUESTION_INVALID", "A question must be an object.", `questions.${index}`));
      return;
    }
    const key = question.key;
    const label = question.label;
    const type = question.type;
    if (typeof key !== "string" || !key.trim()) {
      issues.push(issue("KEY_REQUIRED", "A question key is required.", `questions.${index}.key`));
      return;
    }
    if (keys.has(key)) {
      issues.push(issue("DUPLICATE_KEY", `Question key ${key} is repeated.`, `questions.${index}.key`));
      return;
    }
    keys.add(key);
    if (typeof label !== "string" || !label.trim()) {
      issues.push(issue("LABEL_REQUIRED", "A question label is required.", `questions.${index}.label`));
      return;
    }
    if (type !== "text" && type !== "file" && type !== "notice") {
      issues.push(issue("TYPE_INVALID", `Question ${key} has an unsupported type.`, `questions.${index}.type`));
      return;
    }
    const required = question.required === true;
    const file = parseFile(question.file, `questions.${index}.file`);
    if (type === "file" && file === null) {
      issues.push(issue("FILE_SLOT_REQUIRED", `File question ${key} needs a valid file slot.`, `questions.${index}.file`));
      return;
    }
    if (type !== "file" && question.file !== undefined) {
      issues.push(issue("FILE_SLOT_UNEXPECTED", `Non-file question ${key} cannot have a file slot.`, `questions.${index}.file`));
      return;
    }
    const normalized: CompiledQuestionnaireQuestion = {
      key,
      label,
      type,
      required,
      ...(file === null ? {} : { file }),
    };
    questions.push(normalized);
    if (file !== null) fileSlots.push({ key, ...file });
  });
  if (issues.length > 0) return deepFreeze({ ok: false, issues });

  const normalized: QuestionnaireDefinition = {
    schemaVersion: 1,
    version: payload.version,
    questions,
  };
  const schemaHash = capabilityDefinitionHash({ schemaVersion: 1, payload: normalized });
  const artifact: CompiledQuestionnaireArtifact = {
    schemaVersion: 1,
    version: payload.version,
    schemaHash,
    questions,
    fileSlots,
  };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "questionnaire",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export const questionnaireCompiler: CapabilityCompiler = {
  capabilityKey: "questionnaire",
  compile: compileQuestionnaireDefinition,
};

export function createQuestionnaireDefinition(
  version: string,
  questions: readonly QuestionnaireQuestion[],
): CapabilityDefinition {
  return { schemaVersion: 1, payload: { schemaVersion: 1, version, questions } };
}

export function createEmptyQuestionnaireDefinition(): CapabilityDefinition {
  return createQuestionnaireDefinition("draft", []);
}

export const questionnaireCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "questionnaire",
    version: "1",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: ["questionnaire.configure", "questionnaire.answer"],
    queries: ["questionnaire.describe"],
    events: ["QuestionnaireAnswered"],
    permissions: ["questionnaire.manage"],
    surfaces: ["studio", "portal"],
    scopes: ["registration"],
  },
  compiler: questionnaireCompiler,
  emptyDefinition: createEmptyQuestionnaireDefinition,
});
