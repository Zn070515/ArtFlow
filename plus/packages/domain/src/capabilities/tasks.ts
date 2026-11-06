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

export type TaskStatus = "pending" | "in_progress" | "blocked" | "done";

export interface TaskTemplate {
  readonly key: string;
  readonly title: string;
  readonly sourceCapability: string;
  readonly sourceKey: string;
  readonly required: boolean;
}

export interface TasksDefinition {
  readonly schemaVersion: 1;
  readonly templates: readonly TaskTemplate[];
}

export interface CompiledTasksArtifact {
  readonly schemaVersion: 1;
  readonly templates: readonly TaskTemplate[];
}

const FIELD_LIMITS = {
  key: 100,
  title: 200,
  sourceCapability: 100,
  sourceKey: 200,
} as const;

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTemplate(
  value: unknown,
  index: number,
  issues: CompileIssue[],
): TaskTemplate | null {
  if (!isRecord(value)) {
    issues.push(issue("TEMPLATE_INVALID", "A task template must be an object.", `templates.${index}`));
    return null;
  }

  const fields = [
    ["key", value.key, "KEY_INVALID", FIELD_LIMITS.key],
    ["title", value.title, "TITLE_INVALID", FIELD_LIMITS.title],
    ["sourceCapability", value.sourceCapability, "SOURCE_CAPABILITY_INVALID", FIELD_LIMITS.sourceCapability],
    ["sourceKey", value.sourceKey, "SOURCE_KEY_INVALID", FIELD_LIMITS.sourceKey],
  ] as const;
  const normalized: Record<string, string> = {};
  for (const [field, raw, code, maxLength] of fields) {
    if (typeof raw !== "string" || raw.trim().length === 0 || raw.trim().length > maxLength) {
      issues.push(
        issue(
          code,
          `${field} must be a non-empty string of at most ${maxLength} characters.`,
          `templates.${index}.${field}`,
        ),
      );
      continue;
    }
    normalized[field] = raw.trim();
  }
  if (typeof value.required !== "boolean") {
    issues.push(issue("REQUIRED_INVALID", "required must be a boolean.", `templates.${index}.required`));
  }
  if (Object.keys(normalized).length !== fields.length || typeof value.required !== "boolean") return null;

  return {
    key: normalized.key!,
    title: normalized.title!,
    sourceCapability: normalized.sourceCapability!,
    sourceKey: normalized.sourceKey!,
    required: value.required,
  };
}

function normalizeDefinition(definition: CapabilityDefinition):
  | { readonly definition: CapabilityDefinition; readonly templates: readonly TaskTemplate[] }
  | { readonly issues: readonly CompileIssue[] } {
  if (definition.schemaVersion !== 1 || !isRecord(definition.payload)) {
    return { issues: [issue("PAYLOAD_INVALID", "Not a tasks definition.", "payload")] };
  }
  if (definition.payload.schemaVersion !== 1) {
    return { issues: [issue("SCHEMA_VERSION", "Only schemaVersion 1 is supported.", "payload.schemaVersion")] };
  }
  if (!Array.isArray(definition.payload.templates)) {
    return { issues: [issue("TEMPLATES_INVALID", "templates must be an array.", "payload.templates")] };
  }

  const issues: CompileIssue[] = [];
  const templates: TaskTemplate[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of definition.payload.templates.entries()) {
    const template = normalizeTemplate(raw, index, issues);
    if (template === null) continue;
    if (keys.has(template.key)) {
      issues.push(issue("DUPLICATE_KEY", `Task template ${template.key} is duplicated.`, `templates.${index}.key`));
      continue;
    }
    keys.add(template.key);
    templates.push(template);
  }
  if (issues.length > 0) return { issues };

  templates.sort((left, right) => left.key.localeCompare(right.key));
  return {
    definition: {
      schemaVersion: 1,
      payload: { schemaVersion: 1, templates },
    },
    templates,
  };
}

export function createTasksDefinition(
  templates: readonly TaskTemplate[] = [],
): CapabilityDefinition {
  return {
    schemaVersion: 1,
    payload: {
      schemaVersion: 1,
      templates: templates.map((template) => ({ ...template })),
    },
  };
}

export function compileTasksDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const normalized = normalizeDefinition(definition);
  if ("issues" in normalized) return deepFreeze({ ok: false, issues: normalized.issues });

  const artifact: CompiledTasksArtifact = {
    schemaVersion: 1,
    templates: normalized.templates,
  };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "tasks",
    contentHash: capabilityDefinitionHash(normalized.definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export const tasksCompiler: CapabilityCompiler = {
  capabilityKey: "tasks",
  compile: compileTasksDefinition,
  validateComposition: ({ enabledCapabilities, artifact }) => {
    if (!isRecord(artifact) || !Array.isArray(artifact.templates)) return [];
    const enabled = new Set(enabledCapabilities);
    const issues: CompileIssue[] = [];
    for (const [index, raw] of artifact.templates.entries()) {
      if (!isRecord(raw) || typeof raw.sourceCapability !== "string") continue;
      if (raw.sourceCapability !== "activity" && !enabled.has(raw.sourceCapability)) {
        issues.push(
          issue(
            "SOURCE_CAPABILITY_DISABLED",
            `Task template ${String(raw.key)} references disabled capability ${raw.sourceCapability}.`,
            `templates.${index}.sourceCapability`,
          ),
        );
      }
    }
    return issues;
  },
};

export function createEmptyTasksDefinition(): CapabilityDefinition {
  return createTasksDefinition();
}

export const tasksCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "tasks",
    version: "1.0.0",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "tasks.sync",
      "tasks.assign",
      "tasks.start",
      "tasks.block",
      "tasks.complete",
      "tasks.reopen",
    ],
    queries: ["tasks.list", "readiness.summary"],
    events: ["tasks.changed"],
    permissions: ["tasks.manage"],
    surfaces: ["ops", "studio"],
    scopes: [],
  },
  compiler: tasksCompiler,
  emptyDefinition: createEmptyTasksDefinition,
});
