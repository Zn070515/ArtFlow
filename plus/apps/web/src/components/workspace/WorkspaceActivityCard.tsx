import { Link } from "@tanstack/react-router";
import { useState } from "react";

import type { WorkspaceActivity, WorkspaceNextAction as NextAction } from "./workspaceState.js";

const capabilityLabels: Readonly<Record<string, string>> = {
  registration: "报名",
  materials: "材料",
  competition: "比赛",
  publishing: "赛果",
  voting: "投票",
  grouping: "分组",
  attendance: "签到",
  tasks: "任务",
  archive: "归档",
};

function actionTarget(action: NextAction, activity: WorkspaceActivity) {
  switch (action.target) {
    case "studio":
      return { to: "/studio/$activityId" as const, params: { activityId: activity.id } };
    case "ops":
      return { to: "/ops/$activityId" as const, params: { activityId: activity.id } };
    case "live":
      return { to: "/live/$activityId" as const, params: { activityId: activity.id } };
    case "results":
      return { to: "/results/$publicCode" as const, params: { publicCode: activity.publicCode } };
  }
}

export function WorkspaceActivityCard({
  activity,
  attentionCount,
  primaryAction,
}: {
  readonly activity: WorkspaceActivity;
  readonly attentionCount?: number;
  readonly primaryAction: NextAction | null;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copyPublicCode(): Promise<void> {
    try {
      if (navigator.clipboard === undefined) throw new Error("Clipboard is unavailable.");
      await navigator.clipboard.writeText(activity.publicCode);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <article className="ops-card workspace-activity-card">
      <div className="workspace-card-header">
        <div>
          <p className="eyebrow">ACTIVITY · 活动</p>
          <h2 className="console-card-title">{activity.title}</h2>
        </div>
        <span className={`status-badge status-${activity.status}`}>{activity.status}</span>
      </div>
      <div className="workspace-public-code">
        <span>公开码</span>
        <code>{activity.publicCode}</code>
        <button className="secondary-button" type="button" onClick={() => void copyPublicCode()}>
          复制公开码
        </button>
        <span className="sr-only" role="status" aria-live="polite">
          {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : ""}
        </span>
      </div>
      <ul className="workspace-capabilities" aria-label="已启用能力">
        {activity.enabledCapabilities.length === 0 ? <li>尚未配置能力</li> : null}
        {activity.enabledCapabilities.map((capability) => (
          <li key={capability}>{capabilityLabels[capability] ?? capability}</li>
        ))}
      </ul>
      <div className="workspace-card-footer">
        <span className={attentionCount !== undefined && attentionCount > 0 ? "workspace-attention-count" : "state-copy"}>
          {attentionCount === undefined
            ? "打开工作台查看状态"
            : attentionCount > 0
              ? `${attentionCount} 项需要关注`
              : "暂无待处理事项"}
        </span>
        <div className="workspace-card-actions">
          {primaryAction === null ? null : (
            <Link className="primary-button" {...actionTarget(primaryAction, activity)}>
              {primaryAction.label}
            </Link>
          )}
          <Link
            className="secondary-button"
            to="/workspace/$activityId"
            params={{ activityId: activity.id }}
          >
            打开活动工作台
          </Link>
        </div>
      </div>
    </article>
  );
}
