import { describe, expect, it } from "vitest";

import {
  compileScheduleDefinition,
  createEmptyScheduleDefinition,
  createScheduleDefinition,
  defaultCapabilityRegistry,
  instantiateActivityPack,
  STAGE_SHOW_PACK,
} from "../src/index.js";

describe("schedule capability", () => {
  it("compiles an empty schedule", () => {
    const result = compileScheduleDefinition(createEmptyScheduleDefinition());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact).toMatchObject({ version: 1, schemaVersion: 1, slots: [] });
  });

  it("compiles slots with duration and kind", () => {
    const result = compileScheduleDefinition(
      createScheduleDefinition([
        { key: "opening", label: "开场", durationMinutes: 10, kind: "ceremony" },
        { key: "programs", label: "节目", durationMinutes: 6, kind: "program" },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact).toMatchObject({
      slots: [
        { key: "opening", durationMinutes: 10, kind: "ceremony" },
        { key: "programs", durationMinutes: 6, kind: "program" },
      ],
    });
  });

  it("rejects duplicate keys, invalid durations, and unknown kinds", () => {
    const result = compileScheduleDefinition(
      createScheduleDefinition([
        { key: "same", label: "A", durationMinutes: 0, kind: "program" },
        { key: "same", label: "", durationMinutes: 5, kind: "unknown" as "program" },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("SLOT_DURATION_INVALID");
    expect(codes).toContain("SLOT_KEY_DUPLICATE");
    expect(codes).toContain("SLOT_LABEL_REQUIRED");
    expect(codes).toContain("SLOT_KIND_INVALID");
  });

  it("rejects slot keys longer than the persisted column", () => {
    const result = compileScheduleDefinition(
      createScheduleDefinition([
        { key: "k".repeat(65), label: "过长", durationMinutes: 5, kind: "program" },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain("SLOT_KEY_TOO_LONG");
  });

  it("is registered and included in the stage-show pack", () => {
    expect(defaultCapabilityRegistry.get("schedule")).toBeDefined();
    const result = instantiateActivityPack(STAGE_SHOW_PACK, defaultCapabilityRegistry, {
      title: "毕业晚会",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instantiation.enabledCapabilities).toContain("schedule");
    expect(result.instantiation.definition.capabilities.schedule).toBeDefined();
  });
});
