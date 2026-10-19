import { expect, it } from "vitest";

import {
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
  expect(left.total).toBe(91);
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

it("rejects a score outside the frozen criterion range", () => {
  expect(() => normalizeScoreSubmission(
    { criteria: { technique: 101, stage: 0, emotion: 0 }, notes: "" },
    rubric,
  )).toThrowError(/criterion|range/i);
});
