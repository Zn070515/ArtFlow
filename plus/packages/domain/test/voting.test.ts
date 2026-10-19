import { expect, it } from "vitest";

import {
  compileVotingDefinition,
  computeVoteScores,
  createVotingDefinition,
  votingCapability,
} from "../src/index.js";

it("compiles a voting definition with a frozen scoring rule", () => {
  const result = compileVotingDefinition(
    createVotingDefinition({
      purpose: "score_component",
      selectionType: "single",
      maxSelections: 1,
      requiresTicket: true,
      allowBrowserIdentity: false,
      scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.artifact).toMatchObject({
    purpose: "score_component",
    requiresTicket: true,
    scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
  });
});

it("rejects multi-select definitions whose limit is not explicit", () => {
  const result = compileVotingDefinition(
    createVotingDefinition({
      purpose: "popularity",
      selectionType: "multi",
      maxSelections: 1,
      requiresTicket: false,
      allowBrowserIdentity: true,
      scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.map((issue) => issue.code)).toContain("MAX_SELECTIONS_INVALID");
});

it("computes ballot-share scores with explicit empty-session semantics", () => {
  expect(
    computeVoteScores({
      counts: { singerA: 2, singerB: 1 },
      totalBallots: 3,
      rule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
  ).toEqual({ singerA: 66.67, singerB: 33.33 });

  expect(
    computeVoteScores({
      counts: { singerA: 2 },
      totalBallots: 0,
      rule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
  ).toEqual({ singerA: 0 });
});

it("exposes a voting capability manifest with its execution scope", () => {
  expect(votingCapability.manifest.identity).toBe("voting");
  expect(votingCapability.manifest.commands).toContain("voting.ballot.submit");
  expect(votingCapability.manifest.scopes).toContain("voting");
});
