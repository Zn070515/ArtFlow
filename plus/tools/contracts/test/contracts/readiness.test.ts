import type { ActivityPack, ActivityPackQuestion, CapabilityDefinition } from "@artflow-plus/domain";
import { describe, expect, it } from "vitest";

import { checkPackReadiness, formatReadiness } from "../../src/harness/readiness.js";

const materials: CapabilityDefinition = {
  schemaVersion: 1,
  payload: { schemaVersion: 1, maxBytes: 25_000_000, allowedPurposes: ["audio"] },
};

function questionnaire(withFile: boolean): CapabilityDefinition {
  return {
    schemaVersion: 1,
    payload: {
      schemaVersion: 1,
      version: "v1",
      questions: [
        { key: "name", label: "Name", type: "text", required: true },
        ...(withFile
          ? [{ key: "audio", label: "Audio", type: "file", required: true }]
          : []),
      ],
    },
  };
}

const competition: CapabilityDefinition = { schemaVersion: 1, payload: { schemaVersion: 1 } };
const ticketing: CapabilityDefinition = { schemaVersion: 1, payload: { schemaVersion: 1 } };
const voting: CapabilityDefinition = {
  schemaVersion: 1,
  payload: { schemaVersion: 2, identityPolicy: "ticket" },
};

function pack(
  identity: string,
  definitions: Record<string, CapabilityDefinition>,
  votingQuestion = false,
  extraQuestions: ActivityPackQuestion[] = [],
): ActivityPack {
  return {
    identity,
    version: "1",
    title: identity,
    baselineCapabilities: [],
    questions: [
      ...(votingQuestion
        ? [{ id: "voting", prompt: "Voting?", capability: "voting", default: false }]
        : []),
      ...extraQuestions,
    ],
    definitions,
  };
}

describe("pack readiness", () => {
  it("finds materials without a file question and judging without ticketing", () => {
    const findings = checkPackReadiness([
      pack("bad", {
        materials,
        questionnaire: questionnaire(false),
        competition,
      }),
    ]);
    expect(findings.map((finding) => finding.code)).toEqual([
      "MATERIALS_WITHOUT_FILE_QUESTION",
      "JUDGING_WITHOUT_TICKETING",
    ]);
    expect(formatReadiness(findings)).toContain("bad");
  });

  it("finds a voting option with no explicit voting definition", () => {
    const findings = checkPackReadiness([pack("voting-gap", {}, true)]);
    expect(findings.map((finding) => finding.code)).toEqual(["VOTING_IDENTITY_IMPLICIT"]);
  });

  it("accepts a pack whose feature paths are connected", () => {
    const findings = checkPackReadiness([
      pack("good", {
        materials,
        questionnaire: questionnaire(true),
        competition,
        ticketing,
        voting,
      }, true),
    ]);
    expect(findings).toEqual([]);
    expect(formatReadiness(findings)).toContain("no findings");
  });

  it("accepts a default-on ticketing question as the judge-entry path", () => {
    const findings = checkPackReadiness([
      pack("judge-entry-question", {
        materials,
        questionnaire: questionnaire(true),
        competition,
        voting,
      }, true, [
        { id: "judge-entry", prompt: "Judge entry?", capability: "ticketing", default: true },
      ]),
    ]);
    expect(findings).toEqual([]);
  });
});
