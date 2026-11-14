import { describe, expect, it } from "vitest";

import {
  compileIncidentDefinition,
  createIncidentDefinition,
  defaultCapabilityRegistry,
  STAGE_SHOW_PACK,
} from "../src/index.js";

describe("incident capability", () => {
  it("compiles the empty incident definition", () => {
    const result = compileIncidentDefinition(createIncidentDefinition());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact).toMatchObject({
      version: 1,
      schemaVersion: 1,
      severities: ["low", "medium", "high", "critical"],
      categories: ["participant", "judge", "stage", "technical", "safety", "other"],
    });
  });

  it("is registered and available as an optional stage-show question", () => {
    expect(defaultCapabilityRegistry.get("incident")).toBeDefined();
    expect(STAGE_SHOW_PACK.questions.some((question) => question.capability === "incident")).toBe(true);
  });
});
