import { describe, expect, it } from "vitest";

import { liveDisplayRanks } from "./ranking.js";

describe("live display ranks", () => {
  it("uses the first row of a tie group for competition rank", () => {
    const rows = [
      { contestantId: "a", total: "90.00", judgeCount: 2 },
      { contestantId: "b", total: "90.00", judgeCount: 2 },
      { contestantId: "c", total: "80.00", judgeCount: 2 },
    ];
    expect(liveDisplayRanks(rows, [{ total: "90.00", contestants: ["a", "b"] }])).toEqual([1, 1, 3]);
  });

  it("falls back to ordinal positions when there are no published ties", () => {
    const rows = [
      { contestantId: "a", total: "90.00", judgeCount: 2 },
      { contestantId: "b", total: "80.00", judgeCount: 2 },
    ];
    expect(liveDisplayRanks(rows, [])).toEqual([1, 2]);
  });
});
