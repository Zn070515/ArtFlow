import { describe, expect, it } from "vitest";

import {
  compileTeamsDefinition,
  createEmptyTeamsDefinition,
  createTeamsDefinition,
} from "../src/index.js";

describe("teams definition", () => {
  it("compiles the organizer-facing size, captain and source fields", () => {
    const result = compileTeamsDefinition(createTeamsDefinition({
      minSize: 2,
      maxSize: 6,
      requireCaptain: true,
      source: "grouping",
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact).toEqual({
        schemaVersion: 1,
        minSize: 2,
        maxSize: 6,
        requireCaptain: true,
        source: "grouping",
      });
    }
  });

  it("accepts the empty default shape", () => {
    const result = compileTeamsDefinition(createEmptyTeamsDefinition());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact).toMatchObject({ minSize: 1, maxSize: 8, source: "manual" });
    }
  });

  it("rejects inverted, out-of-range and unknown settings", () => {
    const inverted = compileTeamsDefinition(createTeamsDefinition({ minSize: 5, maxSize: 2 }));
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.issues.map((issue) => issue.code)).toContain("TEAM_SIZE_RANGE_INVALID");

    const tooLarge = compileTeamsDefinition(createTeamsDefinition({ maxSize: 65 }));
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.issues.map((issue) => issue.code)).toContain("TEAM_MAX_SIZE_INVALID");

    const badSource = compileTeamsDefinition(createTeamsDefinition({
      source: "magic" as "manual",
    }));
    expect(badSource.ok).toBe(false);
    if (!badSource.ok) expect(badSource.issues.map((issue) => issue.code)).toContain("TEAM_SOURCE_INVALID");
  });
});
