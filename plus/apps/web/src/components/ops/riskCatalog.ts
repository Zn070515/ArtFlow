export type RiskSeverity = "critical" | "warning";
export type RiskArea =
  | "registration"
  | "materials"
  | "roster"
  | "voting"
  | "competition"
  | "results"
  | "archive"
  | "other";
export type RiskTarget =
  | { readonly kind: "anchor"; readonly id: "registration" | "roster" | "voting" | "archive" }
  | { readonly kind: "live" }
  | { readonly kind: "public-results" }
  | { readonly kind: "none" };

export type RiskRowStatus = "blocked" | "attention" | "preparing" | "ready" | "closed";

export interface RiskActivity {
  readonly id: string;
  readonly title: string;
  readonly publicCode: string;
  readonly status: "draft" | "active" | "closed" | "archived";
  readonly enabledCapabilities: readonly string[];
}

export interface RiskItem {
  readonly code: string;
  readonly count?: number;
  readonly title: string;
  readonly reason: string;
  readonly area: RiskArea;
  readonly severity: RiskSeverity;
  readonly actionLabel: string;
  readonly target: RiskTarget;
}

export interface RiskRow {
  readonly activity: RiskActivity;
  readonly status: RiskRowStatus;
  readonly critical: number;
  readonly warning: number;
  readonly items: readonly RiskItem[];
}

interface Definition {
  readonly title: string;
  readonly reason: string;
  readonly area: RiskArea;
  readonly actionLabel: string;
}

const DEFINITIONS: Readonly<Record<string, Definition>> = {
  REGISTRATION_REVIEW_PENDING: {
    title: "报名待审核",
    area: "registration",
    actionLabel: "去审核",
    reason: "还有报名处于已提交/待补充，审核后才能定稿名单。",
  },
  REQUIRED_MATERIALS_PENDING: {
    title: "必交材料未通过",
    area: "materials",
    actionLabel: "去处理",
    reason: "还有必交材料未通过审核，会影响名单与参赛资格。",
  },
  ROSTER_NOT_FINAL: {
    title: "名单未定稿",
    area: "roster",
    actionLabel: "去定稿",
    reason: "最终名单尚未定稿；Live 使用已通过报名，但运营记录需要定稿。",
  },
  FORMAL_VOTE_OPEN: {
    title: "正式投票开放",
    area: "voting",
    actionLabel: "去投票",
    reason: "正式投票仍在开放，结果发布前需要结束并确认。",
  },
  COMPETITION_ROUND_NOT_LOCKED: {
    title: "回合未锁定",
    area: "competition",
    actionLabel: "去 Live",
    reason: "还有比赛回合未锁定，结果不能视为最终。",
  },
  RESULT_STALE: {
    title: "赛果来源已变化",
    area: "results",
    actionLabel: "去 Live",
    reason: "已确认赛果的来源发生变化，继续推进或发布可能写出错误结果。",
  },
  RESULT_RELEASE_PENDING: {
    title: "赛果待发布",
    area: "results",
    actionLabel: "去 Live",
    reason: "还有赛果待确认或发布。",
  },
  ARCHIVE_MISSING: {
    title: "尚未归档",
    area: "archive",
    actionLabel: "去归档",
    reason: "活动已关闭但还没有当前归档包。",
  },
};

const PRE_EVENT = new Set<RiskArea>(["registration", "materials", "roster", "voting", "competition"]);
const POST_EVENT = new Set<RiskArea>(["results", "archive"]);

export function visibleFor(status: RiskActivity["status"], area: RiskArea): boolean {
  if (status === "archived") return false;
  if (status === "draft") return PRE_EVENT.has(area);
  if (status === "closed") return POST_EVENT.has(area) || area === "other";
  return true;
}

/**
 * Only an active stale result blocks: the confirmed result's source changed,
 * so advancing or publishing could write a wrong result. The final roster is
 * not a Live precondition (Live uses approved registrations), and closed
 * results are frozen.
 */
export function severityFor(status: RiskActivity["status"], code: string): RiskSeverity {
  return status === "active" && code === "RESULT_STALE" ? "critical" : "warning";
}

export function targetFor(code: string, activity: RiskActivity): RiskTarget {
  if (code === "RESULT_STALE" || code === "RESULT_RELEASE_PENDING") {
    return activity.status === "closed" ? { kind: "public-results" } : { kind: "live" };
  }
  if (code === "COMPETITION_ROUND_NOT_LOCKED") return { kind: "live" };
  if (code === "REGISTRATION_REVIEW_PENDING" || code === "REQUIRED_MATERIALS_PENDING") {
    return { kind: "anchor", id: "registration" };
  }
  if (code === "ROSTER_NOT_FINAL") return { kind: "anchor", id: "roster" };
  if (code === "FORMAL_VOTE_OPEN") return { kind: "anchor", id: "voting" };
  if (code === "ARCHIVE_MISSING") return { kind: "anchor", id: "archive" };
  return { kind: "none" };
}

function actionLabelFor(
  activity: RiskActivity,
  definition: Definition,
  target: RiskTarget,
): string {
  if (activity.status === "draft") return "查看/准备";
  if (target.kind === "public-results") return "查看赛果";
  return definition.actionLabel;
}

export function describeRisk(
  code: string,
  activity: RiskActivity,
  count?: number,
): RiskItem | null {
  const definition = DEFINITIONS[code] ?? {
    title: code,
    area: "other" as const,
    actionLabel: "查看",
    reason: "未识别的运营注意项，请检查 analytics 的新码。",
  };
  if (!visibleFor(activity.status, definition.area)) return null;
  const target = targetFor(code, activity);
  return {
    code,
    ...(count === undefined ? {} : { count }),
    ...definition,
    severity: severityFor(activity.status, code),
    actionLabel: actionLabelFor(activity, definition, target),
    target,
  };
}

export function deriveRiskRow(
  activity: RiskActivity,
  attention: readonly { readonly code: string; readonly count?: number }[],
): RiskRow {
  const items = attention
    .map((item) => describeRisk(item.code, activity, item.count))
    .filter((item): item is RiskItem => item !== null);
  const critical = items.filter((item) => item.severity === "critical").length;
  const warning = items.length - critical;
  const status: RiskRowStatus =
    activity.status === "draft"
      ? "preparing"
      : activity.status === "closed"
        ? "closed"
        : critical > 0
          ? "blocked"
          : warning > 0
            ? "attention"
            : "ready";
  return { activity, status, critical, warning, items };
}

export function deriveRiskSummary(rows: readonly RiskRow[]): Record<RiskRowStatus, number> {
  return rows.reduce<Record<RiskRowStatus, number>>(
    (summary, row) => ({ ...summary, [row.status]: summary[row.status] + 1 }),
    { blocked: 0, attention: 0, preparing: 0, ready: 0, closed: 0 },
  );
}
