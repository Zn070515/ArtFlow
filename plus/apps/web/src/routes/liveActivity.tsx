import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Fragment } from "react";

import { fetchLiveState } from "../api/live.js";
import { RequireSession } from "../auth/RequireSession.js";
import {
  canManageCompetition,
  canManageCompetitionSetup,
  canManageLiveSession,
  canPrepareCompetitionRound,
  canResolveCompetition,
  hasLiveAccess,
  useSession,
} from "../auth/SessionProvider.js";
import { LiveExceptionPanel } from "../components/live/LiveExceptionPanel.js";
import { LiveRoundPanel } from "../components/live/LiveRoundPanel.js";
import { LiveTieAdvancementPanel } from "../components/live/LiveTieAdvancementPanel.js";
import { LiveSessionPanel } from "../components/live/LiveSessionPanel.js";
import { AttendanceSummary } from "../components/live/AttendanceSummary.js";
import { ResultActions } from "../components/live/ResultActions.js";
import { Card } from "../components/ui/Card.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";
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
      void queryClient.invalidateQueries({ queryKey: ["round-scores", activityId] });
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
    void queryClient.invalidateQueries({ queryKey: ["round-scores", activityId] });
    void queryClient.invalidateQueries({ queryKey: ["live-activities"] });
  }

  if (!allowed) {
    return (
      <EmptyState
        title="没有 Live 权限"
        description="当前账号缺少 competition.manage、competition.score.write 或 judge.manage。"
      />
    );
  }
  if (query.isPending) {
    return <p className="auth-loading">正在加载 Live 状态…</p>;
  }
  if (query.error !== null) {
    return (
      <ErrorState
        description="Live 状态暂时无法加载。"
        onRetry={() => { void query.refetch(); }}
      />
    );
  }

  const state = query.data;
  const canPrepare = canPrepareCompetitionRound(session);
  const canManageSetup = canManageCompetitionSetup(session);
  const canResolve = canResolveCompetition(session);
  const canManageSession = canManageLiveSession(session);
  const hasTicketing = state.activity.enabledCapabilities.includes("ticketing");

  return (
    <section className="live-page">
      <header>
        <div>
          <Link to="/live" className="table-link">
            ← 返回活动列表
          </Link>
          <h1 className="ui-page-title">{state.activity.title}</h1>
          <p className="ui-page-meta">
            公开码 {state.activity.publicCode} · release v{state.activity.activeDefinitionVersion} ·
            {fallback ? " 5s 轮询" : " 实时推送"}
          </p>
          {hasTicketing || !canManageSession ? null : (
            <p className="ui-field__error" role="alert">
              该活动未启用 ticketing，无法生成评委入口链接。
            </p>
          )}
        </div>
      </header>
      <div className="live-workspace">
        <div className="live-main-column live-rounds">
          {state.rounds.map((live) => (
            <Fragment key={live.config.key}>
              <LiveRoundPanel
                state={state}
                live={live}
                sessionMode={state.session?.mode}
                onChanged={refresh}
                canPrepare={canPrepare}
                canManageSetup={canManageSetup}
                canResolve={canResolve}
              />
              {canManageCompetition(session) ? (
                <>
                  <LiveExceptionPanel
                    activityId={activityId}
                    live={live}
                    state={state}
                    canManageSetup={canManageSetup}
                    onChanged={refresh}
                  />
                  <LiveTieAdvancementPanel
                    activityId={activityId}
                    live={live}
                    state={state}
                    onChanged={refresh}
                  />
                </>
              ) : null}
            </Fragment>
          ))}
        </div>
        <aside className="live-control-rail">
          {canManageSession ? <LiveSessionPanel state={state} onChanged={refresh} /> : null}
          {state.activity.enabledCapabilities.includes("attendance") ? (
            <AttendanceSummary
              activityId={activityId}
              mode={state.session?.mode === "test" ? "test" : "formal"}
              rehearsal={state.session?.mode === "rehearsal"}
            />
          ) : null}
          {session !== null &&
          (session.actor.permissions.includes("*") ||
            session.actor.permissions.includes("result.manage") ||
            session.actor.roles.includes("admin")) ? (
            <ResultActions activityId={activityId} state={state} onChanged={refresh} />
          ) : null}
          <Card className="live-roster-card">
            <h2 className="ui-card__title">最终名单</h2>
            {state.participantIds.length === 0 ? (
              <p className="ui-card__description">尚未有最终名单。</p>
            ) : (
              <ul className="seat-list">
                {state.participantIds.map((participantId) => (
                  <li key={participantId}>{state.participantNames[participantId] ?? participantId}</li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </section>
  );
}
