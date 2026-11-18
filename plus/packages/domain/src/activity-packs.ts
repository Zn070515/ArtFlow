import { createCompetitionDefinition } from "./capabilities/competition.js";
import { createGroupingDefinition } from "./capabilities/grouping.js";
import { createMaterialsDefinition, MAX_MATERIAL_UPLOAD_BYTES } from "./capabilities/materials.js";
import { createResourcesDefinition } from "./capabilities/resources.js";
import { createPublishingDefinition } from "./capabilities/publishing.js";
import { createQuestionnaireDefinition } from "./capabilities/questionnaire.js";
import { createVotingDefinition } from "./capabilities/voting.js";
import { createTasksDefinition } from "./capabilities/tasks.js";
import { createScheduleDefinition } from "./capabilities/schedule.js";
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
      id: "incident",
      prompt: "是否需要现场事故记录？",
      capability: "incident",
      default: false,
    },
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
      id: "judge-entry",
      prompt: "现场评委是否使用入口链接评分？",
      capability: "ticketing",
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
    {
      id: "tasks",
      prompt: "是否需要运营任务清单？",
      capability: "tasks",
      default: false,
    },
    {
      id: "attendance",
      prompt: "是否需要现场签到？",
      capability: "attendance",
      default: false,
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
      {
        key: "audio",
        label: "试唱 / 伴奏音频",
        type: "file",
        required: false,
        file: {
          slot: "audio",
          purpose: "audio",
          accepts: [".mp3", ".m4a", ".wav"],
          maxBytes: MAX_MATERIAL_UPLOAD_BYTES,
        },
      },
    ]),
    materials: createMaterialsDefinition(MAX_MATERIAL_UPLOAD_BYTES, ["audio"]),
    voting: createVotingDefinition({
      purpose: "popularity",
      selectionType: "single",
      maxSelections: 1,
      identityPolicy: "ticket",
      scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
    grouping: createGroupingDefinition(5),
    tasks: createTasksDefinition([
      { key: "registration.review", title: "审核报名", sourceCapability: "registration", sourceKey: "review", required: true },
      { key: "materials.audio", title: "确认音频材料", sourceCapability: "materials", sourceKey: "audio", required: true },
      { key: "competition.roster", title: "确认参赛名单", sourceCapability: "competition", sourceKey: "roster", required: true },
      { key: "publishing.result", title: "确认结果发布", sourceCapability: "publishing", sourceKey: "result", required: true },
      { key: "archive.package", title: "完成归档包", sourceCapability: "archive", sourceKey: "package", required: false },
    ]),
  },
});

export const STAGE_SHOW_PACK: ActivityPack = deepFreeze({
  identity: "stage-show",
  version: "1",
  title: "Stage Show",
  baselineCapabilities: ["registration", "questionnaire", "materials", "archive", "schedule", "resources"],
  questions: [
    {
      id: "incident",
      prompt: "是否需要现场事故记录？",
      capability: "incident",
      default: false,
    },
    {
      id: "audience-voting",
      prompt: "是否需要观众投票？",
      capability: "voting",
      default: false,
    },
    {
      id: "tasks",
      prompt: "是否需要运营任务清单？",
      capability: "tasks",
      default: false,
    },
    {
      id: "attendance",
      prompt: "是否需要现场签到？",
      capability: "attendance",
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
          maxBytes: MAX_MATERIAL_UPLOAD_BYTES,
        },
      },
    ]),
    materials: createMaterialsDefinition(MAX_MATERIAL_UPLOAD_BYTES, ["video", "image", "document"]),
    voting: createVotingDefinition({
      purpose: "popularity",
      selectionType: "single",
      maxSelections: 1,
      identityPolicy: "browser",
      scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
    tasks: createTasksDefinition([
      { key: "registration.review", title: "审核报名", sourceCapability: "registration", sourceKey: "review", required: true },
      { key: "materials.work", title: "确认作品材料", sourceCapability: "materials", sourceKey: "work", required: true },
      { key: "archive.package", title: "完成归档包", sourceCapability: "archive", sourceKey: "package", required: false },
    ]),
    schedule: createScheduleDefinition([
      { key: "opening", label: "开场", durationMinutes: 10, kind: "ceremony" },
      { key: "programs", label: "节目", durationMinutes: 6, kind: "program" },
      { key: "closing", label: "谢幕", durationMinutes: 10, kind: "ceremony" },
    ], "stage-v1"),
    resources: createResourcesDefinition([
      { key: "main-hall", name: "主礼堂", kind: "venue", capacity: 800, notes: "" },
      { key: "projector", name: "投影与音响", kind: "equipment", notes: "" },
      { key: "stage-crew", name: "舞台组", kind: "staff", capacity: 12, notes: "" },
    ]),
  },
});

export const REVIEW_AWARDS_PACK: ActivityPack = deepFreeze({
  identity: "review-awards",
  version: "1",
  title: "Review & Awards",
  baselineCapabilities: ["competition", "publishing", "archive"],
  questions: [
    {
      id: "incident",
      prompt: "是否需要现场事故记录？",
      capability: "incident",
      default: false,
    },
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
      id: "judge-entry",
      prompt: "现场评委是否使用入口链接评分？",
      capability: "ticketing",
      default: true,
    },
    {
      id: "audience-voting",
      prompt: "是否需要观众投票？",
      capability: "voting",
      default: false,
    },
    {
      id: "tasks",
      prompt: "是否需要运营任务清单？",
      capability: "tasks",
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
          maxBytes: MAX_MATERIAL_UPLOAD_BYTES,
        },
      },
    ]),
    materials: createMaterialsDefinition(MAX_MATERIAL_UPLOAD_BYTES, ["video", "image", "document"]),
    voting: createVotingDefinition({
      purpose: "popularity",
      selectionType: "single",
      maxSelections: 1,
      identityPolicy: "browser",
      scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
    tasks: createTasksDefinition([
      { key: "registration.review", title: "审核报名", sourceCapability: "registration", sourceKey: "review", required: true },
      { key: "materials.work", title: "确认作品材料", sourceCapability: "materials", sourceKey: "work", required: true },
      { key: "competition.review", title: "完成评审", sourceCapability: "competition", sourceKey: "review", required: true },
      { key: "publishing.result", title: "确认结果发布", sourceCapability: "publishing", sourceKey: "result", required: true },
      { key: "archive.package", title: "完成归档包", sourceCapability: "archive", sourceKey: "package", required: false },
    ]),
  },
});

export const VOTE_POLL_PACK: ActivityPack = deepFreeze({
  identity: "vote-poll",
  version: "1",
  title: "Vote Poll",
  baselineCapabilities: ["voting", "publishing"],
  questions: [
    {
      id: "archive",
      prompt: "结束后是否归档？",
      capability: "archive",
      default: true,
    },
    {
      id: "tasks",
      prompt: "是否需要运营任务清单？",
      capability: "tasks",
      default: false,
    },
  ],
  definitions: {
    voting: createVotingDefinition({
      purpose: "popularity",
      selectionType: "single",
      maxSelections: 1,
      identityPolicy: "browser",
      scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
    }),
    publishing: createPublishingDefinition([{ key: "vote_result", label: "投票结果" }]),
    tasks: createTasksDefinition([
      { key: "voting.ballots", title: "核对投票记录", sourceCapability: "voting", sourceKey: "ballots", required: true },
      { key: "publishing.result", title: "确认投票结果发布", sourceCapability: "publishing", sourceKey: "vote_result", required: true },
      { key: "archive.package", title: "完成归档包", sourceCapability: "archive", sourceKey: "package", required: false },
    ]),
  },
});
