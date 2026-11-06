import { expect, it } from "vitest";

import {
  compileCompetitionDefinition,
  createCompetitionDefinition,
} from "../src/index.js";

function configuredDefinition(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    payload: {
      schemaVersion: 1,
      nodes: [
        { key: "roster", type: "roster" },
        { key: "final", type: "round", round: "final" },
        { key: "result", type: "output" },
      ],
      edges: [
        { from: "roster", to: "final" },
        { from: "final", to: "result" },
      ],
      rounds: [{ key: "final", minimumJudges: 3, judgeCount: 5, completion: "minimum_valid" }],
      rubric: { criteria: [{ key: "technique", weight: 1, maximum: 100 }] },
      tiePolicy: "review",
      ...overrides,
    },
  };
}

it("compiles round, rubric, panel, completion, and tie policy into the release artifact", () => {
  const result = compileCompetitionDefinition(configuredDefinition());

  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  expect(result.artifact).toMatchObject({
    rounds: [{ key: "final", minimumJudges: 3, judgeCount: 5 }],
    tiePolicy: "review",
  });
});

it("rejects a round whose minimum judge count exceeds its panel size", () => {
  const result = compileCompetitionDefinition(
    configuredDefinition({ rounds: [{ key: "final", minimumJudges: 3, judgeCount: 2 }] }),
  );

  expect(result).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ code: "MINIMUM_JUDGES_INVALID" }),
    ]),
  });
});

it("keeps the empty competition definition compilable", () => {
  const result = compileCompetitionDefinition(createCompetitionDefinition(
    [
      { key: "roster", type: "roster" },
      { key: "result", type: "output" },
    ],
    [{ from: "roster", to: "result" }],
  ));

  expect(result.ok).toBe(true);
});
