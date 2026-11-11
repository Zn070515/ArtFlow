import { describe, expect, it } from "vitest";

import { summarizeDefinition } from "./definitionSummary.js";

const definition = {
  schemaVersion: 1,
  manifest: { key: "singer", title: "Singer Pack" },
  capabilities: {
    registration: { schemaVersion: 1, payload: { schemaVersion: 1, lifecycleVersion: 1, lifecycle: "open" } },
    questionnaire: {
      schemaVersion: 1,
      payload: {
        schemaVersion: 1,
        version: "guided-v1",
        questions: [
          { key: "name", label: "姓名", type: "text", required: true },
          { key: "description", label: "自我介绍", type: "text", required: false },
          {
            key: "audio",
            label: "试唱音频",
            type: "file",
            required: false,
            file: { slot: "audio", purpose: "audio", accepts: [".mp3", ".wav"], maxBytes: 25 * 1024 * 1024 },
          },
        ],
      },
    },
    materials: { schemaVersion: 1, payload: { schemaVersion: 1, maxBytes: 25 * 1024 * 1024, allowedPurposes: ["audio"] } },
    competition: {
      schemaVersion: 1,
      payload: {
        schemaVersion: 1,
        nodes: [],
        edges: [],
        rounds: [
          { key: "final", judgeCount: 3, minimumJudges: 2, completion: "minimum_valid", advanceCount: 1, scoringMethod: "average" },
        ],
        rubric: {
          criteria: [
            { key: "演唱技巧", weight: 1, maximum: 100, minimum: 0 },
            { key: "舞台表现", weight: 1, maximum: 100, minimum: 0 },
          ],
        },
        tiePolicy: "review",
      },
    },
    publishing: {
      schemaVersion: 1,
      payload: { version: 1, schemaVersion: 1, stages: [{ key: "result", label: "结果公示" }] },
    },
    voting: {
      schemaVersion: 1,
      payload: {
        purpose: "popularity",
        selectionType: "single",
        maxSelections: 1,
        identityPolicy: "ticket",
        scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
      },
    },
  },
};

describe("summarizeDefinition", () => {
  it("lists the organizer-facing facts instead of raw payloads", () => {
    const summary = summarizeDefinition(definition, ["competition", "questionnaire", "registration"]);

    expect(summary.capabilities).toEqual(["competition", "questionnaire", "registration"]);
    expect(summary.registration).toEqual([
      "报名生命周期：开放",
      "姓名（必填）",
      "自我介绍（选填）",
      "试唱音频（文件：.mp3/.wav，≤ 25.0 MB，选填）",
    ]);
    expect(summary.rounds).toEqual(["final：3 位评委，至少 2 位有效，晋级 1 人"]);
    expect(summary.scoring).toEqual([
      "计分方式：average",
      "演唱技巧 · 权重 1 · 满分 100",
      "舞台表现 · 权重 1 · 满分 100",
      "并列处理：review",
    ]);
    expect(summary.materials).toEqual(["单个材料上限：25.0 MB", "允许的材料用途：audio"]);
    expect(summary.publishing).toEqual(["结果公示"]);
    expect(summary.voting).toEqual(["单选，最多选 1 项，票据身份"]);
  });

  it("omits sections the definition does not declare", () => {
    const summary = summarizeDefinition({ schemaVersion: 1, capabilities: {} }, []);

    expect(summary.registration).toEqual([]);
    expect(summary.rounds).toEqual([]);
    expect(summary.scoring).toEqual([]);
    expect(summary.materials).toEqual([]);
    expect(summary.publishing).toEqual([]);
    expect(summary.voting).toEqual([]);
  });
});
