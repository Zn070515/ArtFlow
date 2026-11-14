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

export type ScheduleSlotKind = "program" | "break" | "ceremony";

export interface ScheduleSlotDefinition {
  readonly key: string;
  readonly label: string;
  readonly durationMinutes: number;
  readonly kind: ScheduleSlotKind;
}

export interface ScheduleDefinition {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly slots: readonly ScheduleSlotDefinition[];
}

export interface CompiledScheduleArtifact {
  readonly version: 1;
  readonly schemaVersion: 1;
  readonly slots: readonly ScheduleSlotDefinition[];
}

const KINDS: readonly ScheduleSlotKind[] = ["program", "break", "ceremony"];

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

export function compileScheduleDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const payload = definition.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return deepFreeze({ ok: false, issues: [issue("PAYLOAD_INVALID", "Not a schedule definition.", "payload")] });
  }
  const candidate = payload as Partial<ScheduleDefinition>;
  const issues: CompileIssue[] = [];
  if (candidate.schemaVersion !== 1) {
    issues.push(issue("SCHEMA_VERSION", "Only schemaVersion 1 is supported.", "schemaVersion"));
  }
  if (typeof candidate.version !== "string" || !candidate.version.trim()) {
    issues.push(issue("VERSION_REQUIRED", "A schedule version is required.", "version"));
  }
  if (!Array.isArray(candidate.slots)) {
    issues.push(issue("SLOTS_REQUIRED", "slots must be an array.", "slots"));
  } else {
    const keys = new Set<string>();
    candidate.slots.forEach((slot, index) => {
      const path = `slots[${index}]`;
      if (slot === null || typeof slot !== "object" || Array.isArray(slot)) {
        issues.push(issue("SLOT_INVALID", "A slot must be an object.", path));
        return;
      }
      const value = slot as Partial<ScheduleSlotDefinition>;
      if (typeof value.key !== "string" || !value.key.trim()) {
        issues.push(issue("SLOT_KEY_REQUIRED", "A slot key is required.", `${path}.key`));
      } else if (keys.has(value.key)) {
        issues.push(issue("SLOT_KEY_DUPLICATE", "Slot keys must be unique.", `${path}.key`));
      } else {
        keys.add(value.key);
      }
      if (typeof value.label !== "string" || !value.label.trim()) {
        issues.push(issue("SLOT_LABEL_REQUIRED", "A slot label is required.", `${path}.label`));
      }
      if (
        typeof value.durationMinutes !== "number" ||
        !Number.isInteger(value.durationMinutes) ||
        value.durationMinutes < 1 ||
        value.durationMinutes > 1440
      ) {
        issues.push(issue("SLOT_DURATION_INVALID", "durationMinutes must be 1-1440.", `${path}.durationMinutes`));
      }
      if (!KINDS.includes(value.kind as ScheduleSlotKind)) {
        issues.push(issue("SLOT_KIND_INVALID", "kind must be program, break, or ceremony.", `${path}.kind`));
      }
    });
  }
  if (issues.length > 0) return deepFreeze({ ok: false, issues });
  const artifact: CompiledScheduleArtifact = {
    version: 1,
    schemaVersion: 1,
    slots: (candidate.slots as readonly ScheduleSlotDefinition[]).map((slot) => ({
      key: slot.key,
      label: slot.label,
      durationMinutes: slot.durationMinutes,
      kind: slot.kind,
    })),
  };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "schedule",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export const scheduleCompiler: CapabilityCompiler = {
  capabilityKey: "schedule",
  compile: compileScheduleDefinition,
};

export function createScheduleDefinition(
  slots: readonly ScheduleSlotDefinition[],
  version = "v1",
): CapabilityDefinition {
  return { schemaVersion: 1, payload: { schemaVersion: 1, version, slots } };
}

export function createEmptyScheduleDefinition(): CapabilityDefinition {
  return createScheduleDefinition([], "v1");
}

export const scheduleCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "schedule",
    version: "1",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "schedule.entry.upsert",
      "schedule.entry.reorder",
      "schedule.entry.remove",
      "schedule.release",
      "schedule.release.revoke",
      "schedule.current.advance",
    ],
    queries: ["schedule.read", "schedule.public"],
    events: [
      "ScheduleEntryChanged",
      "ScheduleReordered",
      "ScheduleReleased",
      "ScheduleRevoked",
      "ScheduleAdvanced",
    ],
    permissions: ["schedule.manage"],
    surfaces: ["studio", "ops", "live", "portal"],
    scopes: ["schedule"],
    commandScopes: { "schedule.current.advance": ["schedule"] },
  },
  compiler: scheduleCompiler,
  emptyDefinition: createEmptyScheduleDefinition,
});
