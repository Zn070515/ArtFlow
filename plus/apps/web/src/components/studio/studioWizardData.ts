import type { ActivityPackSummary, PackQuestion } from "../../api/studio.js";

export const PACK_COPY: Readonly<Record<string, { readonly title: string; readonly description: string }>> = {
  "singer-competition": {
    title: "歌手比赛",
    description: "报名、问卷、音频材料、分组、评委评分、结果发布与归档。",
  },
  "stage-show": {
    title: "舞台演出 / 节目征集",
    description: "节目报名、作品材料、审核、任务与归档，不含比赛排名。",
  },
  "review-awards": {
    title: "作品评审 / 评奖",
    description: "报名、作品材料、评委评审、奖项候选与结果发布。",
  },
  "vote-poll": {
    title: "人气投票",
    description: "单个或多个候选的观众投票，结果确认后公开发布。",
  },
};

export function packCopy(pack: { readonly identity: string; readonly title: string }): {
  readonly title: string;
  readonly description: string;
} {
  return PACK_COPY[pack.identity] ?? { title: pack.title, description: "" };
}

export const WIZARD_STEPS = [
  { id: "pack", label: "选择模板" },
  { id: "basics", label: "基本信息" },
  { id: "registration", label: "报名与材料" },
  { id: "evaluation", label: "评审与现场" },
  { id: "operations", label: "运营与发布" },
  { id: "review", label: "检查与创建" },
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number]["id"];

const REGISTRATION = new Set(["registration", "questionnaire", "materials"]);
const EVALUATION = new Set(["competition", "grouping", "voting", "ticketing"]);

export function questionsForStep(pack: ActivityPackSummary, step: WizardStep): readonly PackQuestion[] {
  return pack.questions.filter((question) => {
    if (step === "registration") return REGISTRATION.has(question.capability);
    if (step === "evaluation") return EVALUATION.has(question.capability);
    if (step === "operations") return !REGISTRATION.has(question.capability) && !EVALUATION.has(question.capability);
    return false;
  });
}

export function defaultsFor(pack: ActivityPackSummary): Record<string, boolean> {
  return Object.fromEntries(pack.questions.map((question) => [question.id, question.default]));
}
