import type { StudioState } from "../../api/studio.js";

export type ReadinessStatus = "done" | "current" | "pending" | "stale" | "blocked";

export interface ReadinessStep {
  readonly id: "definition" | "activate" | "compile" | "release" | "profile" | "ops";
  readonly title: string;
  readonly status: ReadinessStatus;
  readonly detail: string;
  readonly href?: string;
}

export interface ReadinessView {
  readonly steps: readonly ReadinessStep[];
  readonly completed: number;
  readonly total: 4;
  readonly ready: boolean;
  readonly terminal: "closed" | "archived" | null;
}

export function deriveReadiness(state: StudioState): ReadinessView {
  const status = state.activity.status;
  const terminal = status === "closed" || status === "archived" ? status : null;
  const activeRelease = state.releases.find((release) => release.active);
  const compiledHash = state.compiled?.contentHash;
  const releasedCurrent = activeRelease !== undefined &&
    compiledHash !== undefined &&
    activeRelease.contentHash === compiledHash;
  const hasRunningSession = state.sessions.some((session) => session.status === "running");

  const definitionDone = state.draft !== null;
  const activatedDone = status !== "draft";
  const compiledDone = state.compiled !== null;
  const profileDone =
    state.publicProfile.tagline.trim() !== "" || state.publicProfile.description.trim() !== "";

  const releaseStatus: ReadinessStatus = releasedCurrent
    ? "done"
    : terminal !== null
      ? "blocked"
      : activeRelease !== undefined && compiledHash !== undefined ? "stale" : "current";

  const steps: ReadinessStep[] = [
    {
      id: "definition",
      title: "定义已保存",
      status: definitionDone ? "done" : "current",
      detail: definitionDone
        ? `draft revision ${state.draft?.revision ?? "—"}`
        : "在下方 Definition Package 保存草稿。",
      href: "#definition-editor",
    },
    {
      id: "activate",
      title: "活动已激活",
      status: activatedDone ? "done" : "current",
      detail: activatedDone
        ? "活动已进入 active/closed/archived。"
        : "激活后才可以发布定义。",
    },
    {
      id: "compile",
      title: "当前草稿已编译",
      status: compiledDone ? "done" : terminal !== null ? "blocked" : "current",
      detail: compiledDone
        ? `compiled ${state.compiled?.contentHash.slice(0, 12) ?? ""}…`
        : terminal !== null
          ? "活动已结束/归档，不能重新编译。"
          : "点击“编译定义”生成可发布的版本。",
      href: "#definition-editor",
    },
    {
      id: "release",
      title: "已发布当前定义",
      status: releaseStatus,
      detail: releasedCurrent
        ? `active release v${activeRelease?.version ?? "—"}`
        : terminal !== null
          ? "活动已结束/归档，不能重新发布。"
          : hasRunningSession
            ? "先关闭运行中的会话，再发布当前编译。"
            : activeRelease !== undefined
              ? "有新改动未发布；重新编译并发布。"
              : "编译后发布当前定义。",
      href: terminal !== null
        ? undefined
        : hasRunningSession ? "#session-panel" : "#release-panel",
    },
    {
      id: "profile",
      title: "公开主页资料",
      status: profileDone ? "done" : "pending",
      detail: profileDone ? "已填写标语或介绍。" : "建议补全标语/介绍，方便分享。",
    },
    {
      id: "ops",
      title: "去 Ops 准备",
      status: status === "active" && releasedCurrent ? "done" : "pending",
      detail: "报名审核、名单、签到、现场任务在 Ops 完成。",
    },
  ];

  const required = steps.slice(0, 4);
  const completed = required.filter((step) => step.status === "done").length;
  return {
    steps,
    completed,
    total: 4,
    ready: status === "active" && completed === 4,
    terminal,
  };
}
