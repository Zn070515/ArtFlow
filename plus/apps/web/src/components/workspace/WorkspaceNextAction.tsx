import { Link } from "@tanstack/react-router";

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
  activity,
  pending,
}: {
  readonly action: NextAction | null;
  readonly activity: WorkspaceActivity | null;
  readonly pending: boolean;
}) {
  return (
    <section className="ops-card workspace-next-action" aria-labelledby="workspace-next-action-title">
      <p className="eyebrow">NEXT · 下一步</p>
      <h2 className="console-card-title" id="workspace-next-action-title">
        {pending ? "正在判断下一步" : action?.label ?? "暂无待处理事项"}
      </h2>
      {pending ? <p className="auth-loading">正在读取活动状态…</p> : null}
      {pending || action === null || activity === null ? null : (
        <>
          <p className="state-copy">{action.description}</p>
          <Link className="primary-button workspace-action-link" {...targetLink(action, activity)}>
            {action.label}
          </Link>
        </>
      )}
      {!pending && action === null ? <p className="state-copy">当前没有需要优先处理的事项。</p> : null}
    </section>
  );
}
