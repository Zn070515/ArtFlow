import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { fetchOpsActivities } from "../api/ops.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasOpsAccess, useSession } from "../auth/SessionProvider.js";

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
  const allowed = hasOpsAccess(session);
  const query = useQuery({
    queryKey: ["ops-activities"],
    queryFn: fetchOpsActivities,
    enabled: allowed,
    retry: false,
  });

  if (!allowed) {
    return (
      <section className="result-state">
        <p className="eyebrow">OPS</p>
        <h1 className="state-title">没有运营权限</h1>
        <p className="state-copy">当前账号不能访问 Ops。</p>
      </section>
    );
  }
  if (query.isPending) return <p className="auth-loading">正在加载活动…</p>;
  if (query.error !== null) {
    return <p className="form-error" role="alert">活动列表暂时无法加载。</p>;
  }
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
  const statuses = [...new Set(query.data.map((activity) => activity.status))].sort();
  const filteredActivities = query.data.filter((activity) => {
    const matchesSearch = normalizedSearch.length === 0 ||
      `${activity.title} ${activity.publicCode}`.toLocaleLowerCase().includes(normalizedSearch);
    return matchesSearch && (statusFilter.length === 0 || activity.status === statusFilter);
  });

  return (
    <section className="ops-page">
      <header className="ops-header console-page-header">
        <div>
          <p className="eyebrow">OPS · 运营</p>
          <h1 className="console-page-title">活动</h1>
        </div>
      </header>
      {query.data.length === 0 ? (
        <p className="state-copy">还没有活动。</p>
      ) : (
        <>
          <div className="console-table-toolbar" role="search" aria-label="活动筛选">
            <label className="console-filter-field">
              搜索活动
              <input
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="搜索名称或公开码"
              />
            </label>
            <label className="console-filter-field">
              按状态筛选
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">全部状态</option>
                {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
          </div>
          {filteredActivities.length === 0 ? (
            <p className="state-copy">没有匹配的活动。</p>
          ) : (
            <div className="console-table-wrap">
              <table className="data-table">
                <caption>活动列表</caption>
                <thead>
                  <tr>
                    <th scope="col">活动</th>
                    <th scope="col">公开码</th>
                    <th scope="col">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredActivities.map((activity) => (
                    <tr key={activity.id}>
                      <td>
                        <Link
                          to="/ops/$activityId"
                          params={{ activityId: activity.id }}
                          className="table-link"
                        >
                          {activity.title}
                        </Link>
                      </td>
                      <td>{activity.publicCode}</td>
                      <td>{activity.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
