import type { ActivityAnalyticsResponse } from "@artflow-plus/contracts";

import type { LiveState } from "../../api/live.js";
import type { StudioState } from "../../api/studio.js";

export interface WorkspaceActivity {
  readonly id: string;
  readonly publicCode: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  readonly enabledCapabilities: readonly string[];
}

export type WorkspaceSurface = "studio" | "ops" | "live" | "results";

export interface WorkspaceAccess {
  readonly studio: boolean;
  readonly ops: boolean;
  readonly live: boolean;
}

export interface WorkspaceFacts {
  readonly activity: WorkspaceActivity;
  readonly analytics: ActivityAnalyticsResponse | null;
  readonly studio: StudioState | null;
  readonly live: LiveState | null;
  readonly access: WorkspaceAccess;
}

export interface WorkspaceProgressItem {
  readonly key: "setup" | "registration" | "review" | "live" | "results";
  readonly label: string;
  readonly state: "complete" | "attention" | "available" | "unavailable";
  readonly detail: string;
  readonly target: WorkspaceSurface | null;
}

export interface WorkspaceNextAction {
  readonly code: string;
  readonly label: string;
  readonly description: string;
  readonly target: WorkspaceSurface;
  readonly count?: number;
}

interface AttentionRule {
  readonly label: string;
  readonly description: (count: number | undefined) => string;
  readonly target: WorkspaceSurface;
}

const attentionRules: Readonly<Record<string, AttentionRule>> = {
  REGISTRATION_REVIEW_PENDING: {
    label: "处理报名审核",
    description: (count) => `还有 ${count ?? 0} 项报名需要处理。`,
    target: "ops",
  },
  REQUIRED_MATERIALS_PENDING: {
    label: "检查报名材料",
    description: (count) => `还有 ${count ?? 0} 项必需材料未完成审核。`,
    target: "ops",
  },
  ROSTER_NOT_FINAL: {
    label: "完成名单定稿",
    description: () => "报名审核完成后，定稿名单才能进入后续流程。",
    target: "ops",
  },
  FORMAL_VOTE_OPEN: {
    label: "处理进行中的投票",
    description: (count) => `还有 ${count ?? 0} 个正式投票会话处于开放状态。`,
    target: "ops",
  },
  COMPETITION_ROUND_NOT_LOCKED: {
    label: "进入现场控制",
    description: (count) => `还有 ${count ?? 0} 个回合尚未锁定。`,
    target: "live",
  },
  RESULT_STALE: {
    label: "检查赛果",
    description: (count) => `有 ${count ?? 0} 个赛果需要重新确认。`,
    target: "ops",
  },
  RESULT_RELEASE_PENDING: {
    label: "完成赛果发布",
    description: (count) => `还有 ${count ?? 0} 项赛果需要确认或发布。`,
    target: "ops",
  },
  ARCHIVE_MISSING: {
    label: "整理活动归档",
    description: () => "活动已经结束，但还没有当前归档包。",
    target: "ops",
  },
};

export function attentionCopy(code: string): string {
  return attentionRules[code]?.label ?? "查看活动状态";
}

function hasCapability(facts: WorkspaceFacts, capability: string): boolean {
  return facts.activity.enabledCapabilities.includes(capability);
}

function canOpen(facts: WorkspaceFacts, target: WorkspaceSurface): boolean {
  if (target === "studio") return facts.access.studio;
  if (target === "ops") return facts.access.ops;
  if (target === "live") return facts.access.live && hasCapability(facts, "competition");
  return facts.activity.status !== "draft";
}

function fallbackSurface(facts: WorkspaceFacts): WorkspaceSurface | null {
  if (facts.access.ops) return "ops";
  if (facts.access.studio) return "studio";
  if (facts.access.live && hasCapability(facts, "competition")) return "live";
  return null;
}

function attentionAction(facts: WorkspaceFacts): WorkspaceNextAction | null {
  for (const item of facts.analytics?.attention ?? []) {
    const rule = attentionRules[item.code];
    if (rule === undefined) {
      const target = fallbackSurface(facts);
      if (target === null) continue;
      return {
        code: item.code,
        label: attentionCopy(item.code),
        description: item.count === undefined ? "活动还有一项需要关注的状态。" : `还有 ${item.count} 项需要关注。`,
        target,
        ...(item.count === undefined ? {} : { count: item.count }),
      };
    }
    if (!canOpen(facts, rule.target)) continue;
    return {
      code: item.code,
      label: rule.label,
      description: rule.description(item.count),
      target: rule.target,
      ...(item.count === undefined ? {} : { count: item.count }),
    };
  }
  return null;
}

export function pickWorkspaceNextAction(facts: WorkspaceFacts): WorkspaceNextAction | null {
  const attention = attentionAction(facts);
  if (attention !== null) return attention;

  if ((facts.analytics?.publishing.resultReleases.byStatus.active ?? 0) > 0 && canOpen(facts, "results")) {
    return {
      code: "RESULTS_AVAILABLE",
      label: "查看公开赛果",
      description: "正式赛果已经发布，可以打开公开页面。",
      target: "results",
    };
  }

  if (facts.activity.status === "draft" && facts.access.studio) {
    return {
      code: "SETUP_REQUIRED",
      label: "继续配置活动",
      description: "活动还没有完成基础配置。",
      target: "studio",
    };
  }

  if (facts.access.live && hasCapability(facts, "competition")) {
    return {
      code: "LIVE_AVAILABLE",
      label: "进入现场控制",
      description: "进入 Live 工作区查看回合和现场状态。",
      target: "live",
    };
  }

  return null;
}

function registrationProgress(facts: WorkspaceFacts): WorkspaceProgressItem {
  if (!hasCapability(facts, "registration")) {
    return { key: "registration", label: "报名", state: "unavailable", detail: "未启用报名能力", target: null };
  }
  if (!facts.access.ops || facts.analytics === null) {
    return { key: "registration", label: "报名", state: "unavailable", detail: "当前账号无法查看报名摘要", target: null };
  }
  const total = facts.analytics.registration.total;
  return {
    key: "registration",
    label: "报名",
    state: total > 0 ? "complete" : "available",
    detail: total > 0 ? `已有 ${total} 份报名` : "等待报名进入",
    target: "ops",
  };
}

function reviewProgress(facts: WorkspaceFacts): WorkspaceProgressItem {
  if (!hasCapability(facts, "registration")) {
    return { key: "review", label: "审核与名单", state: "unavailable", detail: "未启用报名能力", target: null };
  }
  if (!facts.access.ops || facts.analytics === null) {
    return { key: "review", label: "审核与名单", state: "unavailable", detail: "当前账号无法查看运营摘要", target: null };
  }
  const hasAttention = facts.analytics.attention.some((item) =>
    ["REGISTRATION_REVIEW_PENDING", "REQUIRED_MATERIALS_PENDING", "ROSTER_NOT_FINAL"].includes(item.code),
  );
  return {
    key: "review",
    label: "审核与名单",
    state: hasAttention ? "attention" : facts.analytics.roster.status === "final" ? "complete" : "available",
    detail: facts.analytics.roster.status === "final" ? "名单已定稿" : "需要检查报名和名单",
    target: "ops",
  };
}

function liveProgress(facts: WorkspaceFacts): WorkspaceProgressItem {
  if (!hasCapability(facts, "competition")) {
    return { key: "live", label: "现场与评分", state: "unavailable", detail: "未启用现场比赛能力", target: null };
  }
  if (!facts.access.live) {
    return { key: "live", label: "现场与评分", state: "unavailable", detail: "当前账号没有 Live 权限", target: null };
  }
  const hasAttention = facts.analytics?.attention.some((item) => item.code === "COMPETITION_ROUND_NOT_LOCKED") === true;
  return {
    key: "live",
    label: "现场与评分",
    state: hasAttention ? "attention" : facts.live?.session?.status === "closed" ? "complete" : "available",
    detail: facts.live?.session?.status === "running" ? "现场会话进行中" : "进入 Live 查看回合",
    target: "live",
  };
}

function resultsProgress(facts: WorkspaceFacts): WorkspaceProgressItem {
  if (!hasCapability(facts, "publishing")) {
    return { key: "results", label: "赛果", state: "unavailable", detail: "未启用赛果发布能力", target: null };
  }
  if (facts.analytics === null) {
    return { key: "results", label: "赛果", state: "unavailable", detail: "当前账号无法查看赛果摘要", target: null };
  }
  const active = facts.analytics.publishing.resultReleases.byStatus.active ?? 0;
  const hasAttention = facts.analytics.attention.some((item) =>
    ["RESULT_STALE", "RESULT_RELEASE_PENDING"].includes(item.code),
  );
  return {
    key: "results",
    label: "赛果",
    state: hasAttention ? "attention" : active > 0 ? "complete" : "available",
    detail: active > 0 ? "正式赛果已发布" : "赛果尚未发布",
    target: active > 0 ? "results" : "ops",
  };
}

export function buildWorkspaceProgress(facts: WorkspaceFacts): readonly WorkspaceProgressItem[] {
  const setupComplete = facts.activity.status !== "draft";
  const setup: WorkspaceProgressItem = !facts.access.studio
    ? { key: "setup", label: "活动配置", state: "unavailable", detail: "当前账号没有 Studio 权限", target: null }
    : {
        key: "setup",
        label: "活动配置",
        state: setupComplete ? "complete" : "attention",
        detail: setupComplete ? "活动已激活" : "完成定义并激活活动",
        target: "studio",
      };
  return [setup, registrationProgress(facts), reviewProgress(facts), liveProgress(facts), resultsProgress(facts)];
}
