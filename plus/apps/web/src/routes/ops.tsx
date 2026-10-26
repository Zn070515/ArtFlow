import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

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

  return (
    <section className="ops-page">
      <header className="ops-header">
        <div>
          <p className="eyebrow">OPS · 运营</p>
          <h1 className="display results-title">活动</h1>
        </div>
      </header>
      {query.data.length === 0 ? (
        <p className="state-copy">还没有活动。</p>
      ) : (
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
            {query.data.map((activity) => (
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
      )}
    </section>
  );
}
