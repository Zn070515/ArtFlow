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

export type ResourceKind = "venue" | "equipment" | "staff";

export interface ResourceDefinition {
  readonly key: string;
  readonly name: string;
  readonly kind: ResourceKind;
  readonly capacity?: number;
  readonly notes: string;
}

export interface ResourcesDefinition {
  readonly schemaVersion: 1;
  readonly resources: readonly ResourceDefinition[];
}

export interface CompiledResourcesArtifact {
  readonly schemaVersion: 1;
  readonly resources: readonly ResourceDefinition[];
}

const KEY_PATTERN = /^[a-z0-9-]{1,80}$/;
const KINDS: readonly ResourceKind[] = ["venue", "equipment", "staff"];

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

export function compileResourcesDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const payload = definition.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return deepFreeze({ ok: false, issues: [issue("PAYLOAD_INVALID", "Not a resources definition.", "payload")] });
  }
  const candidate = payload as Partial<ResourcesDefinition>;
  const issues: CompileIssue[] = [];
  if (candidate.schemaVersion !== 1) {
    issues.push(issue("SCHEMA_VERSION", "Only schemaVersion 1 is supported.", "schemaVersion"));
  }
  const resources = Array.isArray(candidate.resources) ? candidate.resources : [];
  if (!Array.isArray(candidate.resources)) {
    issues.push(issue("RESOURCES_INVALID", "resources must be an array.", "resources"));
  }
  const keys = new Set<string>();
  resources.forEach((resource, index) => {
    const path = `resources.${index}`;
    if (resource === null || typeof resource !== "object") {
      issues.push(issue("RESOURCE_INVALID", "Resource must be an object.", path));
      return;
    }
    const item = resource as Partial<ResourceDefinition>;
    if (typeof item.key !== "string" || !KEY_PATTERN.test(item.key)) {
      issues.push(issue("RESOURCE_KEY_INVALID", "Resource key must be 1-80 lowercase letters, numbers or dashes.", `${path}.key`));
    } else if (keys.has(item.key)) {
      issues.push(issue("RESOURCE_KEY_DUPLICATE", "Resource keys must be unique.", `${path}.key`));
    } else {
      keys.add(item.key);
    }
    if (typeof item.name !== "string" || item.name.trim() === "" || item.name.length > 120) {
      issues.push(issue("RESOURCE_NAME_INVALID", "Resource name must be 1-120 characters.", `${path}.name`));
    }
    if (typeof item.kind !== "string" || !KINDS.includes(item.kind as ResourceKind)) {
      issues.push(issue("RESOURCE_KIND_INVALID", "Resource kind must be venue, equipment or staff.", `${path}.kind`));
    }
    if (item.capacity !== undefined && (!Number.isInteger(item.capacity) || item.capacity < 1)) {
      issues.push(issue("RESOURCE_CAPACITY_INVALID", "Capacity must be a positive integer.", `${path}.capacity`));
    }
    if (item.notes !== undefined && typeof item.notes !== "string") {
      issues.push(issue("RESOURCE_NOTES_INVALID", "Notes must be a string.", `${path}.notes`));
    }
  });
  if (issues.length > 0) return deepFreeze({ ok: false, issues });
  const artifact: CompiledResourcesArtifact = {
    schemaVersion: 1,
    resources: resources.map((resource) => ({
      key: resource.key,
      name: resource.name.trim(),
      kind: resource.kind,
      ...(resource.capacity === undefined ? {} : { capacity: resource.capacity }),
      notes: (resource.notes ?? "").trim(),
    })),
  };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "resources",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export const resourcesCompiler: CapabilityCompiler = {
  capabilityKey: "resources",
  compile: compileResourcesDefinition,
};

export function createResourcesDefinition(
  resources: readonly ResourceDefinition[],
): CapabilityDefinition {
  return { schemaVersion: 1, payload: { schemaVersion: 1, resources } };
}

export function createEmptyResourcesDefinition(): CapabilityDefinition {
  return createResourcesDefinition([]);
}

export const resourcesCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "resources",
    version: "1.0.0",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "resources.booking.create",
      "resources.booking.update",
      "resources.booking.confirm",
      "resources.booking.cancel",
    ],
    queries: ["resources.read"],
    events: [
      "ResourceBookingCreated",
      "ResourceBookingUpdated",
      "ResourceBookingConfirmed",
      "ResourceBookingCancelled",
    ],
    permissions: ["resources.manage"],
    surfaces: ["studio", "ops"],
    scopes: [],
  },
  compiler: resourcesCompiler,
  emptyDefinition: createEmptyResourcesDefinition,
});
