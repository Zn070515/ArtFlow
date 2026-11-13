import { useQuery } from "@tanstack/react-query";
import type { ExecutionStateView } from "../../api/diagnostics.js";
import { fetchExecutionState, fetchOutboxHealth, fetchRecentEvents } from "../../api/diagnostics.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Card } from "../ui/Card.js";

function stateTone(state: ExecutionStateView): BadgeTone {
  if (state.status === "blocked") return "warning";
  return state.stale ? "warning" : "success";
}

function stateLabel(state: ExecutionStateView): string {
  if (state.status === "blocked") return "投影阻塞";
  return state.stale ? "投影落后" : "投影正常";
}

export function DiagnosticsCard({
  activityId,
  canManage,
}: {
  readonly activityId: string;
  readonly canManage: boolean;
}) {
  const events = useQuery({
    queryKey: ["ops-events", activityId],
    queryFn: () => fetchRecentEvents(activityId, 20),
    enabled: canManage,
    retry: false,
  });
  const execution = useQuery({
    queryKey: ["ops-execution-state", activityId],
    queryFn: () => fetchExecutionState(activityId),
    enabled: canManage,
    retry: false,
  });
  const outbox = useQuery({
    queryKey: ["ops-outbox-health"],
    queryFn: fetchOutboxHealth,
    enabled: canManage,
    retry: false,
  });

  if (!canManage) return null;
  const executionState = execution.data;
  return (
    <Card className="diagnostics-card" data-testid="diagnostics-card">
      <h2 className="ui-card__title">只读诊断</h2>
      <div className="tasks-readiness">
        <span>outbox 头 {outbox.data?.headSequence ?? "—"}</span>
        <span>已发布 {outbox.data?.publishedHeadSequence ?? "—"}</span>
        <span>待发布 {outbox.data?.pendingCount ?? "—"}</span>
        <span>事件头 {events.data?.headCursor ?? "—"}</span>
      </div>
      {executionState === undefined ? null : (
        <p className="ui-card__description">
          <Badge tone={stateTone(executionState)}>{stateLabel(executionState)}</Badge>{" "}
          sequence {executionState.lastSequence}/{executionState.headSequence}
          {executionState.blockedReason === undefined ? "" : ` · ${executionState.blockedReason}`}
        </p>
      )}
      {events.data === undefined ? null : (
        <ul className="seat-list" aria-label="最近事件">
          {events.data.events.map((event) => (
            <li key={event.sequence} data-testid="diagnostic-event-row">
              #{event.sequence} · {event.type} · {event.capability}
              {event.mode === undefined ? "" : ` · ${event.mode}`}
            </li>
          ))}
        </ul>
      )}
      {[events.error, execution.error, outbox.error].some((error) => error !== null && error !== undefined) ? (
        <p className="ui-field__error" role="alert">诊断数据暂时不可用。</p>
      ) : null}
    </Card>
  );
}
