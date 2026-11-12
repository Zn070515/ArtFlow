import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { fetchOpsActivities } from "../api/ops.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasOpsAccess, useSession } from "../auth/SessionProvider.js";
import { ConsolePagination } from "../components/console/ConsolePagination.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { Input } from "../components/ui/Input.js";
import { Select } from "../components/ui/Select.js";
import { Table } from "../components/ui/Table.js";
import { Toolbar } from "../components/ui/Toolbar.js";

const PAGE_SIZE = 25;

export function OpsPage() {
  return (
    <RequireSession>
      <OpsContent />
    </RequireSession>
  );
}

function OpsContent() {
  const { session } = useSession();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [searchTerm, statusFilter]);
  const allowed = hasOpsAccess(session);
  const query = useQuery({
    queryKey: ["ops-activities"],
    queryFn: fetchOpsActivities,
    enabled: allowed,
    retry: false,
  });

  if (!allowed) {
    return (
      <EmptyState
        title="没有运营权限"
        description="当前账号不能访问 Ops。"
      />
    );
  }
  if (query.isPending) return <p className="auth-loading">正在加载活动…</p>;
  if (query.error !== null) {
    return (
      <ErrorState
        description="活动列表暂时无法加载。"
        onRetry={() => { void query.refetch(); }}
      />
    );
  }
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
  const statuses = [...new Set(query.data.map((activity) => activity.status))].sort();
  const filteredActivities = query.data.filter((activity) => {
    const matchesSearch = normalizedSearch.length === 0 ||
      `${activity.title} ${activity.publicCode}`.toLocaleLowerCase().includes(normalizedSearch);
    return matchesSearch && (statusFilter.length === 0 || activity.status === statusFilter);
  });
  const totalPages = Math.max(1, Math.ceil(filteredActivities.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginatedActivities = filteredActivities.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <section className="ops-page">
      <header className="ops-header">
        <h1 className="ui-page-title">活动</h1>
        <p className="ui-page-meta">{query.data.length} 个活动 · {filteredActivities.length} 个匹配</p>
      </header>
      {query.data.length === 0 ? (
        <EmptyState title="还没有活动" description="创建第一个活动后从这里开始。" />
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
              {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
            </Select>
          </Toolbar>
          {filteredActivities.length === 0 ? (
            <EmptyState title="没有匹配的活动" description="调整搜索词或状态筛选。" />
          ) : (
            <Table caption="活动列表">
              <thead>
                <tr>
                  <th scope="col">活动</th>
                  <th scope="col">公开码</th>
                  <th scope="col">状态</th>
                </tr>
              </thead>
              <tbody>
                {paginatedActivities.map((activity) => (
                  <tr key={activity.id}>
                    <td data-label="活动">
                      <Link
                        to="/ops/$activityId"
                        params={{ activityId: activity.id }}
                        className="table-link"
                      >
                        {activity.title}
                      </Link>
                    </td>
                    <td data-label="公开码">{activity.publicCode}</td>
                    <td data-label="状态">{activity.status}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <ConsolePagination page={currentPage} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </section>
  );
}
