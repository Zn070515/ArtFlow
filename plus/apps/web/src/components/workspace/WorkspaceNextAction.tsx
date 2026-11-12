import { Link } from "@tanstack/react-router";

import { Card } from "../ui/Card.js";
import type { WorkspaceActivity, WorkspaceNextAction as NextAction } from "./workspaceState.js";

function targetLink(action: NextAction, activity: WorkspaceActivity) {
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

export function WorkspaceNextAction({
  action,
  activity = null,
  pending,
}: {
  readonly action: NextAction | null;
  readonly activity?: WorkspaceActivity | null;
  readonly pending: boolean;
}) {
  return (
    <Card className="workspace-next-action" aria-labelledby="workspace-next-action-title">
      <h2 className="ui-card__title" id="workspace-next-action-title">
        {pending ? "正在判断下一步" : action?.label ?? "暂无待处理事项"}
      </h2>
      {pending ? <p className="ui-card__description">正在读取活动状态…</p> : null}
      {pending || action === null || activity === null ? null : (
        <>
          <p className="ui-card__description">{action.description}</p>
          <Link className="ui-button ui-button--primary ui-button--md workspace-action-link" {...targetLink(action, activity)}>
            {action.label}
          </Link>
        </>
      )}
      {!pending && action === null ? <p className="ui-card__description">当前没有需要优先处理的事项。</p> : null}
    </Card>
  );
}
