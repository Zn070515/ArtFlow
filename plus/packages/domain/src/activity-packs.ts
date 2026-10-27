import { createCompetitionDefinition } from "./capabilities/competition.js";
import { createGroupingDefinition } from "./capabilities/grouping.js";
import { createMaterialsDefinition } from "./capabilities/materials.js";
import { createQuestionnaireDefinition } from "./capabilities/questionnaire.js";
import { deepFreeze } from "./model.js";
import type { ActivityPack } from "./packs.js";

/**
 * The concrete guided catalog. `packs.ts` stays capability-agnostic; this module
 * owns the product defaults that reference concrete capability builders.
 */
export const SINGER_COMPETITION_PACK: ActivityPack = deepFreeze({
  identity: "singer-competition",
  version: "1",
  title: "Singer Competition",
  baselineCapabilities: ["competition"],
  questions: [
    {
      id: "registration-required",
      prompt: "报名是否必需？",
      capability: "registration",
      default: true,
    },
    {
      id: "questionnaire",
      prompt: "报名时是否需要问卷？",
      capability: "questionnaire",
      default: true,
    },
    {
      id: "collect-materials",
      prompt: "节目是否需要提交材料？",
      capability: "materials",
      default: true,
    },
    {
      id: "grouping",
      prompt: "需要第一轮分组/合唱吗？",
      capability: "grouping",
      default: true,
    },
    {
      id: "audience-voting",
      prompt: "是否需要观众投票？",
      capability: "voting",
      default: false,
    },
    {
      id: "publish-results",
      prompt: "是否需要公开发布结果？",
      capability: "publishing",
      default: true,
    },
    {
      id: "archive",
      prompt: "结束后是否归档？",
      capability: "archive",
      default: true,
    },
  ],
  definitions: {
    competition: createCompetitionDefinition(
      [
        { key: "roster", type: "roster" },
        { key: "final", type: "round" },
        { key: "result", type: "output" },
      ],
      [{ from: "roster", to: "final" }, { from: "final", to: "result" }],
      {
        rounds: [{
          key: "final",
          judgeCount: 3,
          minimumJudges: 2,
          completion: "minimum_valid",
          advanceCount: 1,
          scoringMethod: "average",
        }],
        rubric: {
          criteria: [
            { key: "演唱技巧", weight: 1, maximum: 100, minimum: 0 },
            { key: "舞台表现", weight: 1, maximum: 100, minimum: 0 },
            { key: "情感表达", weight: 1, maximum: 100, minimum: 0 },
          ],
        },
        tiePolicy: "review",
      },
    ),
    questionnaire: createQuestionnaireDefinition("guided-v1", [
      { key: "name", label: "姓名", type: "text", required: true },
      { key: "student_id", label: "学号", type: "text", required: true },
      { key: "song", label: "演唱曲目", type: "text", required: true },
      { key: "description", label: "自我介绍", type: "text", required: false },
    ]),
    materials: createMaterialsDefinition(25 * 1024 * 1024, ["audio"]),
    grouping: createGroupingDefinition(5),
  },
});

export const STAGE_SHOW_PACK: ActivityPack = deepFreeze({
  identity: "stage-show",
  version: "1",
  title: "Stage Show",
  baselineCapabilities: ["registration", "questionnaire", "materials", "archive"],
  questions: [
    {
      id: "audience-voting",
      prompt: "是否需要观众投票？",
      capability: "voting",
      default: false,
    },
  ],
  definitions: {
    questionnaire: createQuestionnaireDefinition("stage-v1", [
      { key: "name", label: "负责人", type: "text", required: true },
      { key: "program", label: "节目名称", type: "text", required: true },
      { key: "description", label: "节目介绍", type: "text", required: false },
      {
        key: "work_file",
        label: "作品文件",
        type: "file",
        required: true,
        file: {
          slot: "work",
          purpose: "video",
          accepts: [".mp4", ".mov"],
          maxBytes: 100 * 1024 * 1024,
        },
      },
    ]),
    materials: createMaterialsDefinition(100 * 1024 * 1024, ["video", "image", "document"]),
  },
});

export const REVIEW_AWARDS_PACK: ActivityPack = deepFreeze({
  identity: "review-awards",
  version: "1",
  title: "Review & Awards",
  baselineCapabilities: ["competition", "publishing", "archive"],
  questions: [
    {
      id: "registration-required",
      prompt: "是否需要报名？",
      capability: "registration",
      default: true,
    },
    {
      id: "questionnaire",
      prompt: "是否填写作品问卷？",
      capability: "questionnaire",
      default: true,
    },
    {
      id: "collect-materials",
      prompt: "是否需要提交作品文件？",
      capability: "materials",
      default: true,
    },
    {
      id: "audience-voting",
      prompt: "是否需要观众投票？",
      capability: "voting",
      default: false,
    },
  ],
  definitions: {
    competition: createCompetitionDefinition(
      [
        { key: "roster", type: "roster" },
        { key: "review", type: "round" },
        { key: "result", type: "output" },
      ],
      [{ from: "roster", to: "review" }, { from: "review", to: "result" }],
      {
        rounds: [{
          key: "review",
          judgeCount: 3,
          minimumJudges: 2,
          completion: "minimum_valid",
          advanceCount: 1,
          scoringMethod: "average",
        }],
        rubric: {
          criteria: [
            { key: "主题", weight: 1, maximum: 100, minimum: 0 },
            { key: "完成度", weight: 1, maximum: 100, minimum: 0 },
            { key: "表现力", weight: 1, maximum: 100, minimum: 0 },
          ],
        },
        tiePolicy: "review",
      },
    ),
    questionnaire: createQuestionnaireDefinition("review-v1", [
      { key: "name", label: "作者", type: "text", required: true },
      { key: "work_title", label: "作品名称", type: "text", required: true },
      { key: "description", label: "作品说明", type: "text", required: false },
      {
        key: "work_file",
        label: "作品文件",
        type: "file",
        required: true,
        file: {
          slot: "work",
          purpose: "video",
          accepts: [".mp4", ".mov", ".jpg", ".png"],
          maxBytes: 100 * 1024 * 1024,
        },
      },
    ]),
    materials: createMaterialsDefinition(100 * 1024 * 1024, ["video", "image", "document"]),
  },
});
