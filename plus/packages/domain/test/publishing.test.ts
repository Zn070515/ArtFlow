import { describe, expect, it } from "vitest";

import {
  buildResultSnapshot,
  compilePublishingDefinition,
  createEmptyPublishingDefinition,
  createPublishingDefinition,
  defaultCapabilityRegistry,
  validateAwards,
} from "../src/index.js";

const decisions = [
  { rank: 1, contestantId: "singer-a", score: "98.30" },
  { rank: 2, contestantId: "singer-b", score: "97.80" },
];

function expectCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("publishing capability", () => {
  it("registers and compiles the default final_podium stage", () => {
    expect(defaultCapabilityRegistry.get("publishing")).toBeDefined();
    const compiled = compilePublishingDefinition(createEmptyPublishingDefinition());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact).toMatchObject({
      version: 1,
      schemaVersion: 1,
      stages: [{ key: "final_podium", label: "正式赛果" }],
    });
  });

  it("rejects empty, duplicate, and blank stages", () => {
    expect(compilePublishingDefinition(createPublishingDefinition([])).ok).toBe(false);
    expect(
      compilePublishingDefinition(
        createPublishingDefinition([
          { key: "stage", label: "A" },
          { key: "stage", label: "B" },
        ]),
      ).ok,
    ).toBe(false);
    expect(
      compilePublishingDefinition(createPublishingDefinition([{ key: "", label: "A" }])).ok,
    ).toBe(false);
  });

  it("validates awards against the confirmed decisions", () => {
    expect(() =>
      validateAwards(decisions, [{ award: "冠军", contestantId: "singer-a" }]),
    ).not.toThrow();
    expectCode(
      () => validateAwards(decisions, [{ award: "冠军", contestantId: "singer-x" }]),
      "AWARD_INVALID",
    );
    expectCode(
      () => validateAwards(decisions, [{ award: " ", contestantId: "singer-a" }]),
      "AWARD_INVALID",
    );
    expectCode(
      () =>
        validateAwards(decisions, [
          { award: "冠军", contestantId: "singer-a" },
          { award: "冠军", contestantId: "singer-b" },
        ]),
      "AWARD_INVALID",
    );
  });

  it("freezes the snapshot and derives the public title from the stage label", () => {
    const snapshot = buildResultSnapshot({
      activityTitle: "2026 院十佳",
      stageKey: "final_podium",
      stageLabel: "正式赛果",
      decisions,
      awards: [{ award: "冠军", contestantId: "singer-a" }],
    });
    expect(snapshot.publicTitle).toBe("2026 院十佳 · 正式赛果");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.decisions)).toBe(true);
    expect(Object.isFrozen(snapshot.awards)).toBe(true);
    expect(snapshot.decisions).toHaveLength(2);
  });
});
