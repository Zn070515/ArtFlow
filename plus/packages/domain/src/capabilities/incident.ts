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

export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentCategory =
  | "participant"
  | "judge"
  | "stage"
  | "technical"
  | "safety"
  | "other";
export type IncidentStatus = "open" | "acknowledged" | "resolved";

export interface IncidentDefinition {
  readonly schemaVersion: 1;
}

export interface CompiledIncidentArtifact {
  readonly version: 1;
  readonly schemaVersion: 1;
  readonly severities: readonly IncidentSeverity[];
  readonly categories: readonly IncidentCategory[];
}

const SEVERITIES: readonly IncidentSeverity[] = ["low", "medium", "high", "critical"];
const CATEGORIES: readonly IncidentCategory[] = [
  "participant",
  "judge",
  "stage",
  "technical",
  "safety",
  "other",
];

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

export function compileIncidentDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const payload = definition.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return deepFreeze({ ok: false, issues: [issue("PAYLOAD_INVALID", "Not an incident definition.", "payload")] });
  }
  const candidate = payload as Partial<IncidentDefinition>;
  if (candidate.schemaVersion !== 1) {
    return deepFreeze({
      ok: false,
      issues: [issue("SCHEMA_VERSION", "Only schemaVersion 1 is supported.", "schemaVersion")],
    });
  }
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "incident",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze({
      version: 1,
      schemaVersion: 1,
      severities: [...SEVERITIES],
      categories: [...CATEGORIES],
    }),
  };
  return deepFreeze(plan);
}

export const incidentCompiler: CapabilityCompiler = {
  capabilityKey: "incident",
  compile: compileIncidentDefinition,
};

export function createIncidentDefinition(): CapabilityDefinition {
  return { schemaVersion: 1, payload: { schemaVersion: 1 } };
}

export const incidentCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "incident",
    version: "1",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "incident.open",
      "incident.acknowledge",
      "incident.resolve",
      "incident.reopen",
    ],
    queries: ["incident.read"],
    events: [
      "IncidentOpened",
      "IncidentAcknowledged",
      "IncidentResolved",
      "IncidentReopened",
    ],
    permissions: ["incident.manage"],
    surfaces: ["studio", "ops", "live"],
  },
  compiler: incidentCompiler,
  emptyDefinition: createIncidentDefinition,
});
