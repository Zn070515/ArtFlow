import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { fetchStudioActivities } from "../api/studio.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasStudioAccess, useSession } from "../auth/SessionProvider.js";

export function StudioPage() {
  return (
    <RequireSession>
      <StudioContent />
    </RequireSession>
  );
}

function StudioContent() {
  const { session } = useSession();
  const allowed = hasStudioAccess(session);
  const query = useQuery({
    queryKey: ["studio-activities"],
    queryFn: fetchStudioActivities,
    enabled: allowed,
    retry: false,
  });

  if (!allowed) {
    return (
      <section className="console-state">
        <p className="eyebrow">STUDIO</p>
        <h1 className="console-page-title">没有 Studio 权限</h1>
        <p className="state-copy">当前账号缺少 studio.manage。</p>
      </section>
    );
  }
  if (query.isPending) return <p className="auth-loading">正在加载活动…</p>;
  if (query.error !== null) {
    return <p className="form-error" role="alert">活动列表暂时无法加载。</p>;
  }

  return (
    <section className="studio-page">
      <header className="studio-header console-page-header">
        <div>
          <p className="eyebrow">STUDIO · 设计</p>
          <h1 className="console-page-title">活动</h1>
        </div>
        <Link to="/studio/new" className="primary-button">
          新建活动
        </Link>
      </header>
      {query.data.length === 0 ? (
        <p className="state-copy">还没有活动，先新建一个。</p>
      ) : (
        <div className="console-table-wrap">
          <table className="data-table">
            <caption>活动列表</caption>
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
                      to="/studio/$activityId"
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
        </div>
      )}
    </section>
  );
}
