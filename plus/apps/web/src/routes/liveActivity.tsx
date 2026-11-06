import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";

import { fetchLiveState } from "../api/live.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasLiveAccess, useSession } from "../auth/SessionProvider.js";
import { LiveRoundPanel } from "../components/live/LiveRoundPanel.js";
import { LiveSessionPanel } from "../components/live/LiveSessionPanel.js";
import { useRealtimeTopic } from "../realtime/useRealtimeTopic.js";

export function LiveActivityPage() {
  return (
    <RequireSession>
      <LiveActivityContent />
    </RequireSession>
  );
}

function LiveActivityContent() {
  const { activityId } = useParams({ from: "/live/$activityId" });
  const { session } = useSession();
  const queryClient = useQueryClient();
  const allowed = hasLiveAccess(session);

  const { fallback } = useRealtimeTopic<{ lastSequence: number }>(
    allowed ? `activity:${activityId}` : null,
    () => {
      void queryClient.invalidateQueries({ queryKey: ["live-state", activityId] });
    },
  );
  const query = useQuery({
    queryKey: ["live-state", activityId],
    queryFn: () => fetchLiveState(activityId),
    enabled: allowed,
    retry: false,
    refetchInterval: fallback ? 5000 : false,
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["live-state", activityId] });
    void queryClient.invalidateQueries({ queryKey: ["live-activities"] });
  }

  if (!allowed) {
    return <p className="console-state form-error" role="alert">当前账号缺少 competition.manage 或 judge.manage。</p>;
  }
  if (query.isPending) {
    return <p className="console-state auth-loading">正在加载 Live 状态…</p>;
  }
  if (query.error !== null) {
    return <p className="console-state form-error" role="alert">Live 状态暂时无法加载。</p>;
  }

  const state = query.data;
  const hasTicketing = state.activity.enabledCapabilities.includes("ticketing");

  return (
    <section className="live-page">
      <header className="console-page-header">
        <div>
          <Link to="/live" className="table-link">
            ← 返回活动列表
          </Link>
          <p className="eyebrow">LIVE · {state.activity.status}</p>
          <h1 className="console-page-title">{state.activity.title}</h1>
          <p className="state-copy">
            公开码 {state.activity.publicCode} · release v{state.activity.activeDefinitionVersion} ·
            {fallback ? " 5s 轮询" : " 实时推送"}
          </p>
          {hasTicketing ? null : (
            <p className="form-error" role="alert">
              该活动未启用 ticketing，无法生成评委入口链接。
            </p>
          )}
        </div>
      </header>
      <div className="live-workspace">
        <div className="live-main-column live-rounds">
          {state.rounds.map((live) => (
            <LiveRoundPanel
              key={live.config.key}
              state={state}
              live={live}
              sessionMode={state.session?.mode}
              onChanged={refresh}
            />
          ))}
        </div>
        <aside className="live-control-rail">
          <LiveSessionPanel state={state} onChanged={refresh} />
          <section className="ops-card live-roster-card">
            <p className="eyebrow">ROSTER · 选手</p>
            <h2 className="console-card-title">最终名单</h2>
            {state.participantIds.length === 0 ? (
              <p className="state-copy">尚未有最终名单。</p>
            ) : (
              <ul className="seat-list">
                {state.participantIds.map((participantId) => (
                  <li key={participantId}>{participantId}</li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
