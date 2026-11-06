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

export interface MaterialsDefinition {
  readonly schemaVersion: 1;
  readonly maxBytes: number;
  readonly allowedPurposes: readonly string[];
}

export interface CompiledMaterialsArtifact {
  readonly schemaVersion: 1;
  readonly maxBytes: number;
  readonly allowedPurposes: readonly string[];
}

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

export function compileMaterialsDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const payload = definition.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return deepFreeze({ ok: false, issues: [issue("PAYLOAD_INVALID", "Not a materials definition.", "payload")] });
  }
  const candidate = payload as Partial<MaterialsDefinition>;
  const issues: CompileIssue[] = [];
  if (candidate.schemaVersion !== 1) issues.push(issue("SCHEMA_VERSION", "Only schemaVersion 1 is supported.", "schemaVersion"));
  if (!Number.isInteger(candidate.maxBytes) || (candidate.maxBytes ?? 0) < 1) {
    issues.push(issue("MAX_BYTES_INVALID", "maxBytes must be a positive integer.", "maxBytes"));
  }
  if (!Array.isArray(candidate.allowedPurposes) || candidate.allowedPurposes.some((item) => typeof item !== "string" || !item.trim())) {
    issues.push(issue("PURPOSES_INVALID", "allowedPurposes must contain non-empty strings.", "allowedPurposes"));
  }
  const allowedPurposes = Array.isArray(candidate.allowedPurposes)
    ? [...new Set(candidate.allowedPurposes as string[])].sort()
    : [];
  if (allowedPurposes.length !== (candidate.allowedPurposes?.length ?? 0)) {
    issues.push(issue("PURPOSES_DUPLICATE", "allowedPurposes must be unique.", "allowedPurposes"));
  }
  if (issues.length > 0) return deepFreeze({ ok: false, issues });
  const artifact: CompiledMaterialsArtifact = {
    schemaVersion: 1,
    maxBytes: candidate.maxBytes as number,
    allowedPurposes,
  };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "materials",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export const materialsCompiler: CapabilityCompiler = {
  capabilityKey: "materials",
  compile: compileMaterialsDefinition,
};

export function createMaterialsDefinition(
  maxBytes: number,
  allowedPurposes: readonly string[],
): CapabilityDefinition {
  return { schemaVersion: 1, payload: { schemaVersion: 1, maxBytes, allowedPurposes } };
}

export function createEmptyMaterialsDefinition(): CapabilityDefinition {
  return createMaterialsDefinition(25 * 1024 * 1024, []);
}

export const materialsCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "materials",
    version: "1",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: ["materials.upload", "materials.content.attach", "materials.review"],
    queries: ["materials.read"],
    events: ["MaterialUploaded", "MaterialReviewed"],
    permissions: ["materials.manage", "materials.review"],
    surfaces: ["studio", "ops", "portal"],
    scopes: ["registration"],
  },
  compiler: materialsCompiler,
  emptyDefinition: createEmptyMaterialsDefinition,
});
