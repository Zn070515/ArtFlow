import { capabilityDefinitionHash } from "../compiler.js";
import type {
  CapabilityCompileResult,
  CapabilityCompiler,
  CapabilityDefinition,
  CompiledCapabilityPlan,
} from "../model.js";
import { deepFreeze } from "../model.js";
import type { CapabilityRegistration } from "../registry.js";

export type AttendanceSubjectType = "participant" | "ticket" | "staff";

export interface CompiledAttendanceArtifact {
  readonly schemaVersion: 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createEmptyAttendanceDefinition(): CapabilityDefinition {
  return { schemaVersion: 1, payload: { schemaVersion: 1 } };
}

export function compileAttendanceDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  if (definition.schemaVersion !== 1 || !isRecord(definition.payload)) {
    return deepFreeze({
      ok: false,
      issues: [{ code: "PAYLOAD_INVALID", message: "Not an attendance definition.", path: "payload" }],
    });
  }
  if (definition.payload.schemaVersion !== 1) {
    return deepFreeze({
      ok: false,
      issues: [{ code: "SCHEMA_VERSION", message: "Only schemaVersion 1 is supported.", path: "payload.schemaVersion" }],
    });
  }
  const unknown = Object.keys(definition.payload).filter((key) => key !== "schemaVersion");
  if (unknown.length > 0) {
    return deepFreeze({
      ok: false,
      issues: [{
        code: "PAYLOAD_UNKNOWN_KEY",
        message: `Attendance definitions only accept schemaVersion; found ${unknown.join(", ")}.`,
        path: `payload.${unknown[0]}`,
      }],
    });
  }
  const artifact: CompiledAttendanceArtifact = { schemaVersion: 1 };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "attendance",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export const attendanceCompiler: CapabilityCompiler = {
  capabilityKey: "attendance",
  compile: compileAttendanceDefinition,
};

export const ATTENDANCE_COMMAND_SCOPES: Readonly<Record<string, readonly string[]>> = deepFreeze({
  "attendance.checkin": ["checkin"],
  "attendance.undo": ["checkin"],
});

export const attendanceCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "attendance",
    version: "1",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "attendance.point.create",
      "attendance.point.update",
      "attendance.staff.add",
      "attendance.staff.update",
      "attendance.checkin",
      "attendance.undo",
    ],
    queries: ["attendance.list", "attendance.staff.list"],
    events: [
      "AttendancePointChanged",
      "AttendanceStaffChanged",
      "AttendanceCheckedIn",
      "AttendanceUndone",
    ],
    permissions: ["attendance.manage"],
    surfaces: ["studio", "ops", "live"],
    scopes: ["checkin"],
    commandScopes: ATTENDANCE_COMMAND_SCOPES,
  },
  compiler: attendanceCompiler,
  emptyDefinition: createEmptyAttendanceDefinition,
});
