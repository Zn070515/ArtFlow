import { describe, expect, it } from "vitest";

import {
  attendanceCapability,
  compileAttendanceDefinition,
  createEmptyAttendanceDefinition,
} from "../src/capabilities/attendance.js";
import { createCapabilityRegistry } from "../src/registry.js";

describe("attendance capability", () => {
  it("compiles only the schema-version-1 empty definition", () => {
    const compiled = compileAttendanceDefinition(createEmptyAttendanceDefinition());
    expect(compiled.ok).toBe(true);
    expect(compiled.ok && compiled.artifact).toEqual({ schemaVersion: 1 });

    const unknown = compileAttendanceDefinition({
      schemaVersion: 1,
      payload: { schemaVersion: 1, points: [] },
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.ok === false && unknown.issues[0]?.code).toBe("PAYLOAD_UNKNOWN_KEY");
  });

  it("declares the check-in command scope", () => {
    expect(attendanceCapability.manifest.scopes).toEqual(["checkin"]);
    expect(attendanceCapability.manifest.commandScopes).toEqual({
      "attendance.checkin": ["checkin"],
      "attendance.undo": ["checkin"],
    });
  });

  it("merges its command scopes into the composition", () => {
    const registry = createCapabilityRegistry([attendanceCapability]);
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    const composition = registry.registry.validateComposition({ enable: ["attendance"] });
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    expect(composition.plan.commandScopes["attendance.checkin"]).toEqual(["checkin"]);
    expect(composition.plan.declaredScopes).toContain("checkin");
  });
});
