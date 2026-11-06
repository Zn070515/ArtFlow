import { describe, expect, it } from "vitest";

import {
  compileGroupingDefinition,
  createGroupingDefinition,
  groupingCapability,
  normalizeGroupingGroups,
} from "../src/index.js";

describe("grouping definition", () => {
  it("compiles an unconstrained definition", () => {
    const compiled = compileGroupingDefinition(createGroupingDefinition());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact).toEqual({ schemaVersion: 1 });
  });

  it("compiles a groupCount constraint", () => {
    const compiled = compileGroupingDefinition(createGroupingDefinition(5));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact).toEqual({ schemaVersion: 1, groupCount: 5 });
  });

  it("rejects a non-positive groupCount", () => {
    const compiled = compileGroupingDefinition({
      schemaVersion: 1,
      payload: { schemaVersion: 1, groupCount: 0 },
    });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.issues.map((item) => item.code)).toContain("GROUP_COUNT_INVALID");
  });

  it("registers dependencies, commands, and the ops surface", () => {
    expect(groupingCapability.manifest.dependencies).toEqual(["registration", "competition"]);
    expect(groupingCapability.manifest.surfaces).toEqual(["ops"]);
    expect(groupingCapability.manifest.permissions).toEqual(["grouping.manage"]);
    expect(groupingCapability.manifest.scopes).toEqual([]);
    expect(groupingCapability.manifest.commands).toContain("grouping.stage.freeze");
  });
});

describe("grouping partition rules", () => {
  const allowed = new Set(["p1", "p2", "p3"]);

  it("defaults names by position and accepts unequal sizes", () => {
    const groups = normalizeGroupingGroups(
      [
        { participantIds: ["p1", "p2"] },
        { name: "B 组", participantIds: ["p3"] },
      ],
      allowed,
      { complete: true, groupCount: 2 },
    );
    expect(groups).toEqual([
      { name: "第 1 组", participantIds: ["p1", "p2"] },
      { name: "B 组", participantIds: ["p3"] },
    ]);
  });

  it("rejects an incomplete partition when completeness is required", () => {
    expect(() =>
      normalizeGroupingGroups([{ participantIds: ["p1"] }], allowed, { complete: true }),
    ).toThrowError(/missing participants/);
  });

  it("allows an incomplete draft", () => {
    const groups = normalizeGroupingGroups([{ participantIds: ["p1"] }], allowed, {
      complete: false,
    });
    expect(groups).toHaveLength(1);
  });

  it("rejects a participant outside the source roster", () => {
    expect(() =>
      normalizeGroupingGroups([{ participantIds: ["p9"] }], allowed, { complete: false }),
    ).toThrowError(/not in the source roster/);
  });

  it("rejects a participant in two groups", () => {
    expect(() =>
      normalizeGroupingGroups(
        [{ participantIds: ["p1"] }, { participantIds: ["p1"] }],
        allowed,
        { complete: false },
      ),
    ).toThrowError(/cannot belong to two groups/);
  });

  it("rejects a group-count mismatch", () => {
    expect(() =>
      normalizeGroupingGroups(
        [{ participantIds: ["p1", "p2", "p3"] }],
        allowed,
        { complete: true, groupCount: 2 },
      ),
    ).toThrowError(/needs exactly 2 groups/);
  });

  it("rejects duplicate group names", () => {
    expect(() =>
      normalizeGroupingGroups(
        [{ name: "A", participantIds: ["p1"] }, { name: "A", participantIds: ["p2"] }],
        allowed,
        { complete: false },
      ),
    ).toThrowError(/is duplicated/);
  });
});
