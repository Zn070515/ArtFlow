import { describe, expect, it } from "vitest";

import {
  compileArchiveDefinition,
  createEmptyArchiveDefinition,
  defaultCapabilityRegistry,
  renameActivity,
  unarchiveActivity,
} from "../src/index.js";
import type { Activity } from "../src/index.js";

const base: Activity = {
  id: "act-1",
  title: "2026 院十佳",
  status: "closed",
  revision: 3,
  enabledCapabilities: ["archive"],
  activeDefinitionVersion: 1,
};

function expectCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("archive capability", () => {
  it("registers and compiles the zip-json-csv format", () => {
    expect(defaultCapabilityRegistry.get("archive")).toBeDefined();
    const compiled = compileArchiveDefinition(createEmptyArchiveDefinition());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact).toMatchObject({ version: 1, schemaVersion: 1, format: "zip-json-csv" });
  });

  it("rejects unsupported archive formats", () => {
    const compiled = compileArchiveDefinition({
      schemaVersion: 1,
      payload: { version: 1, schemaVersion: 1, format: "xlsx" },
    });
    expect(compiled.ok).toBe(false);
  });

  it("renames a closed activity and rejects an archived one", () => {
    const renamed = renameActivity(base, "渡梦十佳", 3);
    expect(renamed.title).toBe("渡梦十佳");
    expect(renamed.revision).toBe(4);
    expectCode(
      () => renameActivity({ ...base, status: "archived" }, "x", 3),
      "ACTIVITY_ARCHIVED",
    );
  });

  it("unarchives only an archived activity", () => {
    const unarchived = unarchiveActivity({ ...base, status: "archived" }, 3);
    expect(unarchived.status).toBe("closed");
    expect(unarchived.revision).toBe(4);
    expectCode(() => unarchiveActivity(base, 3), "INVALID_TRANSITION");
  });
});
