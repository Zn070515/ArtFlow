import { expect, it } from "vitest";

import {
  averageScore,
  applyTieDecision,
  computeRanking,
  normalizeScoreSubmission,
} from "../src/index.js";

const rubric = {
  criteria: [
    { key: "technique", weight: 1, maximum: 100 },
    { key: "stage", weight: 1, maximum: 100 },
    { key: "emotion", weight: 1, maximum: 100 },
  ],
};

it("rounds decimal authority with decimal half-up semantics", () => {
  const result = normalizeScoreSubmission(
    { criteria: { technique: 1.005, stage: 0, emotion: 0 }, notes: "" },
    {
      criteria: [
        { key: "technique", weight: 1, maximum: 10 },
        { key: "stage", weight: 1, maximum: 10 },
        { key: "emotion", weight: 1, maximum: 10 },
      ],
    },
  );

  expect(result.total).toBe("1.01");
});

it("averages repeating decimal judge totals without binary drift", () => {
  expect(averageScore(["1.005", "1.015"])).toBe("1.01");
});

function row(contestantId: string, total: number) {
  return { contestantId, total, judgeCount: 3 };
}

it("normalizes criteria deterministically and computes the same total for reordered input", () => {
  const left = normalizeScoreSubmission(
    { criteria: { technique: 36, stage: 27, emotion: 28 }, notes: "" },
    rubric,
  );
  const right = normalizeScoreSubmission(
    { criteria: { emotion: 28, technique: 36, stage: 27 }, notes: "" },
    rubric,
  );

  expect(left.canonicalPayload).toEqual(right.canonicalPayload);
  expect(left.total).toBe("91.00");
});

it("holds equal totals until an explicit tie decision is applied", () => {
  const ranking = computeRanking({
    rows: [row("a", 91), row("b", 91), row("c", 88)],
    tiePolicy: "review",
  });

  expect(ranking.status).toBe("hold");
  expect(ranking.tieGroups).toEqual([
    expect.objectContaining({ contestants: ["a", "b"] }),
  ]);
  expect(() => applyTieDecision(ranking, {
    contestants: ["a", "b"],
    order: ["b", "a"],
    reason: "现场裁决",
  })).not.toThrow();
});

it("keeps other unresolved tie groups on hold after one tie decision", () => {
  const ranking = computeRanking({
    rows: [row("a", 91), row("b", 91), row("c", 88), row("d", 88)],
    tiePolicy: "review",
  });

  const decided = applyTieDecision(ranking, {
    contestants: ["a", "b"],
    order: ["b", "a"],
    reason: "第一组现场裁决",
  });

  expect(decided.status).toBe("hold");
  expect(decided.tieGroups).toEqual([
    expect.objectContaining({ total: "88.00", contestants: ["c", "d"] }),
  ]);
  expect(decided.rows.map((item) => item.contestantId)).toEqual(["b", "a", "c", "d"]);
});

it("rejects a score outside the frozen criterion range", () => {
  expect(() => normalizeScoreSubmission(
    { criteria: { technique: 101, stage: 0, emotion: 0 }, notes: "" },
    rubric,
  )).toThrowError(/criterion|range/i);
});
