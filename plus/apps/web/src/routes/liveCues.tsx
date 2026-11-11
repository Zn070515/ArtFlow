import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";

import { fetchHostProgramme } from "../api/programme.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasLiveAccess, hasOpsAccess, useSession } from "../auth/SessionProvider.js";
import { ProgrammeView } from "../components/programme/ProgrammeView.js";

export function LiveCuesPage() {
  return (
    <RequireSession>
      <LiveCuesContent />
    </RequireSession>
  );
}

function LiveCuesContent() {
  const { activityId } = useParams({ from: "/live/$activityId/cues" });
  const { session } = useSession();
  const allowed = hasLiveAccess(session) || hasOpsAccess(session);
  const query = useQuery({
    queryKey: ["host-programme", activityId],
    queryFn: () => fetchHostProgramme(activityId),
    enabled: allowed,
    retry: false,
  });

  if (!allowed) {
    return <p className="console-state form-error" role="alert">当前账号不能打开主持手卡。</p>;
  }
  if (query.isPending) return <p className="console-state auth-loading">正在加载主持手卡…</p>;
  if (query.error !== null || query.data === undefined) {
    return <p className="console-state form-error" role="alert">主持手卡暂时无法加载。</p>;
  }
  return (
    <section className="live-page cue-page">
      <header className="console-page-header">
        <div>
          <Link to="/live/$activityId" params={{ activityId }} className="table-link">
            ← 返回 Live
          </Link>
          <p className="eyebrow">CUE · 主持手卡</p>
          <h1 className="console-page-title">{query.data.activityTitle}</h1>
          <p className="state-copy">与公开节目单使用同一份已定稿顺序。</p>
        </div>
      </header>
      <ProgrammeView programme={query.data} variant="host" />
    </section>
  );
}
