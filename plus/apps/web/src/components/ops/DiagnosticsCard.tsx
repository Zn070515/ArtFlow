import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ExecutionStateView } from "../../api/diagnostics.js";
import {
  fetchExecutionState,
  fetchOutboxHealth,
  fetchRecentEvents,
  rebuildProjection,
  retryProjection,
} from "../../api/diagnostics.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
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
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["ops-execution-state", activityId] }),
      queryClient.invalidateQueries({ queryKey: ["ops-events", activityId] }),
      queryClient.invalidateQueries({ queryKey: ["ops-outbox-health"] }),
    ]);
  };
  const retry = useMutation({
    mutationFn: () => retryProjection(activityId, "formal"),
    onSuccess: refresh,
    onError: (error) => setActionError(error instanceof Error ? error.message : "重试投影失败。"),
  });
  const rebuild = useMutation({
    mutationFn: () => rebuildProjection(activityId, "formal"),
    onSuccess: refresh,
    onError: (error) => setActionError(error instanceof Error ? error.message : "重建投影失败。"),
  });

  if (!canManage) return null;
  const executionState = execution.data;
  return (
    <Card className="diagnostics-card" data-testid="diagnostics-card">
      <h2 className="ui-card__title">系统诊断</h2>
      {executionState === undefined ? (
        <p className="ui-card__description">诊断数据加载中…</p>
      ) : (
        <p className="ui-card__description">
          <Badge tone={stateTone(executionState)}>{stateLabel(executionState)}</Badge>
        </p>
      )}
      {executionState?.status === "blocked" ? (
        <div className="ui-card__actions">
          <p className="ui-card__description">正式投影已阻塞，可先重试当前事件；仍失败时重建投影。</p>
          <Button
            variant="secondary"
            size="sm"
            disabled={retry.isPending || rebuild.isPending}
            onClick={() => retry.mutate()}
          >
            重试投影
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={retry.isPending || rebuild.isPending}
            onClick={() => rebuild.mutate()}
          >
            重建投影
          </Button>
        </div>
      ) : null}
      {actionError === null ? null : <p className="ui-field__error" role="alert">{actionError}</p>}
      <details className="definition-raw">
        <summary>高级诊断</summary>
        <div className="tasks-readiness">
          <span>outbox 头 {outbox.data?.headSequence ?? "—"}</span>
          <span>已发布 {outbox.data?.publishedHeadSequence ?? "—"}</span>
          <span>待发布 {outbox.data?.pendingCount ?? "—"}</span>
          <span>事件头 {events.data?.headCursor ?? "—"}</span>
        </div>
        {executionState === undefined ? null : (
          <p className="ui-card__description">
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
      </details>
      {[events.error, execution.error, outbox.error].some((error) => error !== null && error !== undefined) ? (
        <p className="ui-field__error" role="alert">诊断数据暂时不可用。</p>
      ) : null}
    </Card>
  );
}
