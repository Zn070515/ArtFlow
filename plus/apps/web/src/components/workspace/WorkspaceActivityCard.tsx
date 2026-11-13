import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
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

const statusLabels: Readonly<Record<string, string>> = {
  draft: "草稿",
  active: "进行中",
  closed: "已结束",
  archived: "已归档",
};

const statusTones: Readonly<Record<string, BadgeTone>> = {
  draft: "neutral",
  active: "success",
  closed: "warning",
  archived: "neutral",
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
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
  }, []);

  function report(state: "copied" | "failed"): void {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    setCopyState(state);
    resetTimer.current = setTimeout(() => setCopyState("idle"), 2000);
  }

  async function copyPublicCode(): Promise<void> {
    try {
      if (navigator.clipboard === undefined) throw new Error("Clipboard is unavailable.");
      await navigator.clipboard.writeText(activity.publicCode);
      report("copied");
    } catch {
      report("failed");
    }
  }

  return (
    <Card className="workspace-activity-card">
      <header className="workspace-card-header">
        <h2 className="ui-card__title">{activity.title}</h2>
        <Badge tone={statusTones[activity.status] ?? "neutral"}>
          {statusLabels[activity.status] ?? activity.status}
        </Badge>
      </header>
      <div className="workspace-public-code">
        <span>公开码</span>
        <code>{activity.publicCode}</code>
        <Button variant="secondary" size="sm" onClick={() => void copyPublicCode()}>
          复制公开码
        </Button>
        <span
          className={`workspace-copy-status is-${copyState}`}
          role="status"
          aria-live="polite"
        >
          {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : ""}
        </span>
      </div>
      <ul className="workspace-capabilities" aria-label="已启用能力">
        {activity.enabledCapabilities.length === 0 ? (
          <li><Badge tone="neutral">尚未配置能力</Badge></li>
        ) : null}
        {activity.enabledCapabilities.map((capability) => (
          <li key={capability}>
            <Badge tone="neutral">{capabilityLabels[capability] ?? capability}</Badge>
          </li>
        ))}
      </ul>
      <footer className="workspace-card-footer">
        <span className={attentionCount !== undefined && attentionCount > 0 ? "workspace-attention-count" : "ui-card__description"}>
          {attentionCount === undefined
            ? "打开工作台查看状态"
            : attentionCount > 0
              ? `${attentionCount} 项需要关注`
              : "暂无待处理事项"}
        </span>
        <div className="workspace-card-actions">
          {primaryAction === null ? null : (
            <Link className="ui-button ui-button--primary ui-button--md" {...actionTarget(primaryAction, activity)}>
              {primaryAction.label}
            </Link>
          )}
          <Link
            className="ui-button ui-button--secondary ui-button--md"
            to="/workspace/$activityId"
            params={{ activityId: activity.id }}
          >
            打开活动工作台
          </Link>
        </div>
      </footer>
    </Card>
  );
}
