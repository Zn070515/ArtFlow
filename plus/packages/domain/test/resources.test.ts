import { describe, expect, it } from "vitest";

import {
  compileResourcesDefinition,
  createResourcesDefinition,
} from "../src/index.js";

describe("resources definition", () => {
  it("accepts venue, equipment and staff resources", () => {
    const result = compileResourcesDefinition(createResourcesDefinition([
      { key: "main-hall", name: "主礼堂", kind: "venue", capacity: 800, notes: "" },
      { key: "piano", name: "钢琴", kind: "equipment", notes: "调音" },
      { key: "crew", name: "舞台组", kind: "staff", capacity: 12, notes: "" },
    ]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact).toMatchObject({
        resources: expect.arrayContaining([
          expect.objectContaining({ key: "main-hall", capacity: 800 }),
        ]),
      });
    }
  });

  it("rejects duplicate keys, bad kinds and bad capacity", () => {
    const duplicate = compileResourcesDefinition(createResourcesDefinition([
      { key: "hall", name: "A", kind: "venue", notes: "" },
      { key: "hall", name: "B", kind: "venue", notes: "" },
    ]));
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.issues.map((issue) => issue.code)).toContain("RESOURCE_KEY_DUPLICATE");

    const badKind = compileResourcesDefinition(createResourcesDefinition([
      { key: "hall", name: "A", kind: "magic" as "venue", notes: "" },
    ]));
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.issues.map((issue) => issue.code)).toContain("RESOURCE_KIND_INVALID");

    const badCapacity = compileResourcesDefinition(createResourcesDefinition([
      { key: "hall", name: "A", kind: "venue", capacity: 0, notes: "" },
    ]));
    expect(badCapacity.ok).toBe(false);
    if (!badCapacity.ok) expect(badCapacity.issues.map((issue) => issue.code)).toContain("RESOURCE_CAPACITY_INVALID");
  });
});
