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
import { Card } from "../components/ui/Card.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";
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
      <EmptyState
        title="没有主办方工作台权限"
        description="当前账号没有主办方工作台权限。"
        action={<Link className="ui-button ui-button--secondary ui-button--md" to="/join">进入报名</Link>}
      />
    );
  }
  if (activities.isPending) return <p className="auth-loading">正在加载活动工作台…</p>;
  if (activities.error !== null) {
    return (
      <ErrorState
        description="活动工作台暂时无法加载。"
        onRetry={() => { void activities.refetch(); }}
      />
    );
  }
  if (activity === undefined) {
    return (
      <EmptyState
        title="活动不可用"
        description="这个活动不存在、已被移除，或当前账号无法访问。"
        action={<Link className="ui-button ui-button--secondary ui-button--md" to="/workspace">返回活动工作台</Link>}
      />
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
  const hasResults =
    activity.enabledCapabilities.includes("publishing") &&
    (analytics.data?.publishing.resultReleases.byStatus.active ?? 0) > 0;

  return (
    <section className="workspace-page workspace-detail-page">
      <header className="workspace-detail-header">
        <div>
          <Link className="table-link" to="/workspace">← 返回活动工作台</Link>
          <h1 className="ui-page-title">{activity.title}</h1>
          <p className="ui-page-meta">公开码 {activity.publicCode} · revision {activity.revision}</p>
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
          <Card className="workspace-quick-links">
            <h2 className="ui-card__title">进入工作区</h2>
            <div className="workspace-link-list">
              {access.studio ? <Link className="ui-button ui-button--secondary ui-button--md" to="/studio/$activityId" params={{ activityId: activity.id }}>进入 Studio</Link> : null}
              {access.ops ? <Link className="ui-button ui-button--secondary ui-button--md" to="/ops/$activityId" params={{ activityId: activity.id }}>进入 Ops</Link> : null}
              {access.live && activity.enabledCapabilities.includes("competition") ? <Link className="ui-button ui-button--secondary ui-button--md" to="/live/$activityId" params={{ activityId: activity.id }}>进入 Live</Link> : null}
              {hasResults ? <Link className="ui-button ui-button--secondary ui-button--md" to="/results/$publicCode" params={{ publicCode: activity.publicCode }}>查看公开赛果</Link> : null}
            </div>
            {activity.enabledCapabilities.includes("competition") && !access.live ? <p className="ui-card__description">该活动已启用 Live，但当前账号没有现场权限。</p> : null}
            {!activity.enabledCapabilities.includes("competition") ? <p className="ui-card__description">该活动未启用 Live。</p> : null}
          </Card>
        </aside>
      </div>
    </section>
  );
}
