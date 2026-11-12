import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";

import {
  fetchWorkspaceActivities,
  fetchWorkspaceAnalytics,
  fetchWorkspaceLiveState,
  fetchWorkspaceStudioState,
} from "../api/workspace.js";
import { RequireSession } from "../auth/RequireSession.js";
import {
  hasLiveAccess,
  hasOpsAccess,
  hasStudioAccess,
  hasWorkspaceAccess,
  useSession,
} from "../auth/SessionProvider.js";
import { ActivitySwitcher } from "../components/workspace/ActivitySwitcher.js";
import { WorkspaceNextAction } from "../components/workspace/WorkspaceNextAction.js";
import { WorkspaceProgress } from "../components/workspace/WorkspaceProgress.js";
import { buildWorkspaceProgress, pickWorkspaceNextAction } from "../components/workspace/workspaceState.js";

export function WorkspaceActivityPage() {
  return (
    <RequireSession>
      <WorkspaceActivityContent />
    </RequireSession>
  );
}

function WorkspaceActivityContent() {
  const { activityId } = useParams({ from: "/workspace/$activityId" });
  const { session } = useSession();
  const allowed = hasWorkspaceAccess(session);
  const activities = useQuery({
    queryKey: ["workspace-activities"],
    queryFn: fetchWorkspaceActivities,
    enabled: allowed,
    retry: false,
  });
  const activity = activities.data?.find((candidate) => candidate.id === activityId);
  const analytics = useQuery({
    queryKey: ["workspace-analytics", activityId],
    queryFn: () => fetchWorkspaceAnalytics(activityId),
    enabled: allowed && activity !== undefined,
    retry: false,
  });
  const studio = useQuery({
    queryKey: ["workspace-studio", activityId],
    queryFn: () => fetchWorkspaceStudioState(activityId),
    enabled: hasStudioAccess(session) && activity !== undefined,
    retry: false,
  });
  const live = useQuery({
    queryKey: ["workspace-live", activityId],
    queryFn: () => fetchWorkspaceLiveState(activityId),
    enabled: hasLiveAccess(session) && activity?.enabledCapabilities.includes("competition") === true,
    retry: false,
  });

  if (!allowed) {
    return (
      <section className="console-state">
        <p className="eyebrow">WORKSPACE · 主办方</p>
        <h1 className="console-page-title">没有主办方工作台权限</h1>
        <p className="state-copy">当前账号没有主办方工作台权限。</p>
        <Link className="secondary-button" to="/join">进入报名</Link>
      </section>
    );
  }
  if (activities.isPending) return <p className="console-state auth-loading">正在加载活动工作台…</p>;
  if (activities.error !== null) {
    return <p className="console-state form-error" role="alert">活动工作台暂时无法加载。</p>;
  }
  if (activity === undefined) {
    return (
      <section className="console-state">
        <p className="eyebrow">WORKSPACE · 主办方</p>
        <h1 className="console-page-title">活动不可用</h1>
        <p className="state-copy">这个活动不存在、已被移除，或当前账号无法访问。</p>
        <Link className="secondary-button" to="/workspace">返回活动工作台</Link>
      </section>
    );
  }

  const access = {
    studio: hasStudioAccess(session),
    ops: hasOpsAccess(session),
    live: hasLiveAccess(session),
  };
  const facts = {
    activity,
    analytics: analytics.data ?? null,
    studio: studio.data ?? null,
    live: live.data ?? null,
    access,
  };
  const progress = buildWorkspaceProgress(facts);
  const action = pickWorkspaceNextAction(facts);
  const hasResults = activity.status !== "draft" || (analytics.data?.publishing.resultReleases.byStatus.active ?? 0) > 0;

  return (
    <section className="workspace-page workspace-detail-page">
      <header className="console-page-header workspace-detail-header">
        <div>
          <Link className="table-link" to="/workspace">← 返回活动工作台</Link>
          <p className="eyebrow">ACTIVITY · {activity.status}</p>
          <h1 className="console-page-title">{activity.title}</h1>
          <p className="state-copy">公开码 {activity.publicCode} · revision {activity.revision}</p>
        </div>
        <ActivitySwitcher activities={activities.data ?? []} activeActivityId={activity.id} />
      </header>
      <div className="workspace-detail-grid">
        <div className="workspace-detail-main">
          {analytics.error !== null ? <p className="state-copy workspace-inline-warning">运营摘要暂不可用</p> : null}
          <WorkspaceProgress items={progress} />
        </div>
        <aside className="workspace-detail-rail" aria-label="活动快捷操作">
          <WorkspaceNextAction action={action} activity={activity} pending={analytics.isPending} />
          <section className="ops-card workspace-quick-links">
            <p className="eyebrow">SHORTCUTS · 快捷入口</p>
            <h2 className="console-card-title">进入工作区</h2>
            <div className="workspace-link-list">
              {access.studio ? <Link className="secondary-button" to="/studio/$activityId" params={{ activityId: activity.id }}>进入 Studio</Link> : null}
              {access.ops ? <Link className="secondary-button" to="/ops/$activityId" params={{ activityId: activity.id }}>进入 Ops</Link> : null}
              {access.live && activity.enabledCapabilities.includes("competition") ? <Link className="secondary-button" to="/live/$activityId" params={{ activityId: activity.id }}>进入 Live</Link> : null}
              {hasResults ? <Link className="secondary-button" to="/results/$publicCode" params={{ publicCode: activity.publicCode }}>查看公开赛果</Link> : null}
            </div>
            {activity.enabledCapabilities.includes("competition") && !access.live ? <p className="state-copy">该活动已启用 Live，但当前账号没有现场权限。</p> : null}
            {!activity.enabledCapabilities.includes("competition") ? <p className="state-copy">该活动未启用 Live。</p> : null}
          </section>
        </aside>
      </div>
    </section>
  );
}
