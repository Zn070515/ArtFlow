import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  fetchWorkspaceActivities,
  fetchWorkspaceAnalytics,
} from "../api/workspace.js";
import { RequireSession } from "../auth/RequireSession.js";
import {
  hasLiveAccess,
  hasOpsAccess,
  hasStudioAccess,
  hasWorkspaceAccess,
  useSession,
} from "../auth/SessionProvider.js";
import { ConsolePagination } from "../components/console/ConsolePagination.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { Input } from "../components/ui/Input.js";
import { Select } from "../components/ui/Select.js";
import { Toolbar } from "../components/ui/Toolbar.js";
import { WorkspaceActivityCard } from "../components/workspace/WorkspaceActivityCard.js";
import { pickWorkspaceNextAction } from "../components/workspace/workspaceState.js";

const PAGE_SIZE = 12;

const statusLabels: Readonly<Record<string, string>> = {
  draft: "草稿",
  active: "进行中",
  closed: "已结束",
  archived: "已归档",
};

export function WorkspacePage() {
  return (
    <RequireSession>
      <WorkspaceContent />
    </RequireSession>
  );
}

function WorkspaceContent() {
  const { session } = useSession();
  const allowed = hasWorkspaceAccess(session);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["workspace-activities"],
    queryFn: fetchWorkspaceActivities,
    enabled: allowed,
    retry: false,
  });

  useEffect(() => setPage(1), [searchTerm, statusFilter]);

  const activities = query.data ?? [];
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
  const statuses = [...new Set(activities.map((activity) => activity.status))].sort();
  const filteredActivities = activities.filter((activity) => {
    const matchesSearch = normalizedSearch.length === 0 ||
      `${activity.title} ${activity.publicCode}`.toLocaleLowerCase().includes(normalizedSearch);
    return matchesSearch && (statusFilter.length === 0 || activity.status === statusFilter);
  });
  const totalPages = Math.max(1, Math.ceil(filteredActivities.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginatedActivities = filteredActivities.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const analyticsQueries = useQueries({
    queries: paginatedActivities.map((activity) => ({
      queryKey: ["workspace-analytics", activity.id],
      queryFn: () => fetchWorkspaceAnalytics(activity.id),
      enabled: allowed,
      retry: false,
    })),
  });
  const access = {
    studio: hasStudioAccess(session),
    ops: hasOpsAccess(session),
    live: hasLiveAccess(session),
  };

  if (!allowed) {
    return (
      <EmptyState
        title="没有主办方工作台权限"
        description="当前账号没有主办方工作台权限。"
        action={<Link className="ui-button ui-button--secondary ui-button--md" to="/join">进入报名</Link>}
      />
    );
  }
  if (query.isPending) return <p className="auth-loading">正在加载活动工作台…</p>;
  if (query.error !== null) {
    return (
      <ErrorState
        description="活动列表暂时无法加载。"
        onRetry={() => { void query.refetch(); }}
      />
    );
  }

  return (
    <section className="workspace-page">
      <header className="workspace-header">
        <div>
          <h1 className="ui-page-title">活动工作台</h1>
          <p className="ui-page-meta">从这里继续配置、运营和发布你的活动。</p>
        </div>
        {hasStudioAccess(session) ? (
          <Link className="ui-button ui-button--primary ui-button--md" to="/studio/new">
            新建活动
          </Link>
        ) : null}
      </header>
      {activities.length === 0 ? (
        <EmptyState
          title="还没有活动，先新建一个。"
          description={hasStudioAccess(session) ? "创建后，活动会出现在这里。" : "当前账号还没有创建活动的权限。"}
          action={hasStudioAccess(session) ? (
            <Link className="ui-button ui-button--primary ui-button--md" to="/studio/new">
              新建活动
            </Link>
          ) : undefined}
        />
      ) : (
        <>
          <Toolbar label="活动筛选">
            <Input
              type="search"
              label="搜索活动"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="搜索名称或公开码"
            />
            <Select
              label="按状态筛选"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">全部状态</option>
              {statuses.map((status) => <option key={status} value={status}>{statusLabels[status] ?? status}</option>)}
            </Select>
          </Toolbar>
          {filteredActivities.length === 0 ? (
            <EmptyState title="没有匹配的活动" description="调整搜索词或状态筛选。" />
          ) : (
            <div className="workspace-activity-grid">
              {paginatedActivities.map((activity, index) => {
                const analytics = analyticsQueries[index]?.data ?? null;
                const facts = {
                  activity,
                  analytics,
                  studio: null,
                  live: null,
                  access,
                };
                return (
                  <WorkspaceActivityCard
                    key={activity.id}
                    activity={activity}
                    attentionCount={analytics?.attention.length}
                    primaryAction={analytics === null ? null : pickWorkspaceNextAction(facts)}
                  />
                );
              })}
            </div>
          )}
          <ConsolePagination page={currentPage} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </section>
  );
}
