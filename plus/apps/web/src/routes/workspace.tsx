import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  fetchWorkspaceActivities,
  fetchWorkspaceAnalytics,
  type WorkspaceActivity,
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
import { WorkspaceActivityCard } from "../components/workspace/WorkspaceActivityCard.js";
import { buildWorkspaceProgress, pickWorkspaceNextAction } from "../components/workspace/workspaceState.js";

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
      <section className="console-state">
        <p className="eyebrow">WORKSPACE · 主办方</p>
        <h1 className="console-page-title">没有主办方工作台权限</h1>
        <p className="state-copy">当前账号没有主办方工作台权限。</p>
        <Link className="secondary-button" to="/join">
          进入报名
        </Link>
      </section>
    );
  }
  if (query.isPending) return <p className="console-state auth-loading">正在加载活动工作台…</p>;
  if (query.error !== null) {
    return (
      <section className="console-state">
        <p className="eyebrow">WORKSPACE · 主办方</p>
        <h1 className="console-page-title">活动列表暂时不可用</h1>
        <p className="form-error" role="alert">活动列表暂时无法加载。</p>
        <button className="secondary-button" type="button" onClick={() => void query.refetch()}>
          重试
        </button>
      </section>
    );
  }

  return (
    <section className="workspace-page">
      <header className="console-page-header workspace-header">
        <div>
          <p className="eyebrow">WORKSPACE · 主办方</p>
          <h1 className="console-page-title">活动工作台</h1>
          <p className="state-copy">从这里继续配置、运营和发布你的活动。</p>
        </div>
        {hasStudioAccess(session) ? (
          <Link className="primary-button" to="/studio/new">
            新建活动
          </Link>
        ) : null}
      </header>
      {activities.length === 0 ? (
        <section className="ops-card workspace-empty-state">
          <p className="eyebrow">ACTIVITIES · 活动</p>
          <h2 className="console-card-title">还没有活动，先新建一个。</h2>
          <p className="state-copy">
            {hasStudioAccess(session) ? "创建后，活动会出现在这里。" : "当前账号还没有创建活动的权限。"}
          </p>
          {hasStudioAccess(session) ? (
            <Link className="primary-button" to="/studio/new">
              新建活动
            </Link>
          ) : null}
        </section>
      ) : (
        <>
          <div className="console-table-toolbar workspace-toolbar" role="search" aria-label="活动筛选">
            <label className="console-filter-field">
              搜索活动
              <input
                type="search"
                aria-label="搜索活动"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="搜索名称或公开码"
              />
            </label>
            <label className="console-filter-field">
              按状态筛选
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">全部状态</option>
                {statuses.map((status) => <option key={status} value={status}>{statusLabels[status] ?? status}</option>)}
              </select>
            </label>
          </div>
          {filteredActivities.length === 0 ? (
            <p className="state-copy">没有匹配的活动。</p>
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
