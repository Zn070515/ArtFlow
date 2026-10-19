import { expect, it } from "vitest";

import {
  compileVotingDefinition,
  computeVoteScores,
  createVotingDefinition,
  decodeVotingArtifact,
  votingCapability,
} from "../src/index.js";

it("compiles a voting definition with a frozen scoring rule", () => {
  const result = compileVotingDefinition(
    createVotingDefinition({
      purpose: "score_component",
      selectionType: "single",
      maxSelections: 1,
      identityPolicy: "ticket",
      scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.artifact).toMatchObject({
    version: 2,
    schemaVersion: 2,
    purpose: "score_component",
    identityPolicy: "ticket",
    scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
  });
});

it("identifies the former boolean voting artifact as legacy", () => {
  const legacy = {
    version: 1,
    schemaVersion: 1,
    purpose: "score_component",
    selectionType: "single",
    maxSelections: 1,
    requiresTicket: true,
    allowBrowserIdentity: false,
    scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
  };

  expect(decodeVotingArtifact(legacy)).toMatchObject({ kind: "legacy", artifact: legacy });
});

it("rejects multi-select definitions whose limit is not explicit", () => {
  const result = compileVotingDefinition(
    createVotingDefinition({
      purpose: "popularity",
      selectionType: "multi",
      maxSelections: 1,
      identityPolicy: "browser",
      scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.map((issue) => issue.code)).toContain("MAX_SELECTIONS_INVALID");
});

it("computes ballot-share scores with explicit empty-session hold semantics", () => {
  expect(
    computeVoteScores({
      counts: { singerA: 2, singerB: 1 },
      totalBallots: 3,
      rule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
  ).toEqual({ status: "ready", scores: { singerA: 66.67, singerB: 33.33 } });

  expect(
    computeVoteScores({
      counts: { singerA: 2 },
      totalBallots: 0,
      rule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
  ).toEqual({ status: "hold", reason: "NO_VALID_BALLOTS" });
});

it("requires an explicit identity policy and does not inherit ticketing", () => {
  const result = compileVotingDefinition(
    createVotingDefinition({
      purpose: "popularity",
      selectionType: "single",
      maxSelections: 1,
      identityPolicy: "browser",
      scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
  );

  expect(result.ok).toBe(true);
  expect(votingCapability.manifest.dependencies).not.toContain("ticketing");
});

it("does not allow browser or anonymous identity for a score component", () => {
  const result = compileVotingDefinition(
    createVotingDefinition({
      purpose: "score_component",
      selectionType: "single",
      maxSelections: 1,
      identityPolicy: "browser",
      scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.map((issue) => issue.code)).toContain("SCORE_COMPONENT_IDENTITY_INVALID");
});

it("exposes a voting capability manifest with its execution scope", () => {
  expect(votingCapability.manifest.identity).toBe("voting");
  expect(votingCapability.manifest.commands).toContain("voting.ballot.submit");
  expect(votingCapability.manifest.scopes).toContain("voting");
});
