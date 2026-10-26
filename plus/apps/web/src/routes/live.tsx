import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { fetchLiveActivities } from "../api/live.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasLiveAccess, useSession } from "../auth/SessionProvider.js";

export function LivePage() {
  return (
    <RequireSession>
      <LiveContent />
    </RequireSession>
  );
}

function LiveContent() {
  const { session } = useSession();
  const allowed = hasLiveAccess(session);
  const query = useQuery({
    queryKey: ["live-activities"],
    queryFn: fetchLiveActivities,
    enabled: allowed,
    retry: false,
  });

  if (!allowed) {
    return (
      <section className="result-state">
        <p className="eyebrow">LIVE</p>
        <h1 className="state-title">没有 Live 权限</h1>
        <p className="state-copy">当前账号缺少 competition.manage 或 judge.manage。</p>
      </section>
    );
  }
  if (query.isPending) return <p className="auth-loading">正在加载活动…</p>;
  if (query.error !== null) {
    return <p className="form-error" role="alert">活动列表暂时无法加载。</p>;
  }

  return (
    <section className="studio-page">
      <header className="studio-header">
        <div>
          <p className="eyebrow">LIVE · 现场控制</p>
          <h1 className="display results-title">活动</h1>
        </div>
      </header>
      {query.data.length === 0 ? (
        <p className="state-copy">还没有活动。</p>
      ) : (
        <table className="data-table">
          <caption>可执评的活动</caption>
          <thead>
            <tr>
              <th scope="col">活动</th>
              <th scope="col">公开码</th>
              <th scope="col">状态</th>
              <th scope="col">已启用 capability</th>
            </tr>
          </thead>
          <tbody>
            {query.data.map((activity) => (
              <tr key={activity.id}>
                <td>
                  <Link
                    to="/live/$activityId"
                    params={{ activityId: activity.id }}
                    className="table-link"
                  >
                    {activity.title}
                  </Link>
                </td>
                <td>{activity.publicCode}</td>
                <td>{activity.status}</td>
                <td>{activity.enabledCapabilities.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
