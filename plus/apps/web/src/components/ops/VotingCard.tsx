import type { VotingSessionsSnapshot } from "@artflow-plus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as QRCode from "qrcode";
import { useEffect, useState } from "react";

import { ApiError } from "../../api/client.js";
import {
  closeExecution,
  closeVoteSession,
  confirmVoteResult,
  fetchExecutions,
  fetchPublishingState,
  fetchVotingSessions,
  openVoteSession,
  previewVoteResult,
  releaseVoteResult,
  startExecution,
} from "../../api/voting.js";
import type { VoteResultCandidateView } from "../../api/voting.js";
import { useRealtimeTopic } from "../../realtime/useRealtimeTopic.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";
import { Textarea } from "../ui/Textarea.js";

function humanError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "VOTE_SESSION_NOT_OPEN") return "投票场次还没有关闭。";
  if (code === "STALE_RESOLUTION_INPUT") return "票数在预览后变化了，请重新预览。";
  if (code === "NO_VALID_BALLOTS") return "没有有效票，不能发布。";
  if (code === "RESULT_NOT_CONFIRMED") return "先确认赛果再发布。";
  if (code === "SESSION_NOT_RUNNING") return "对应的执行会话还没有启动。";
  return error instanceof Error ? error.message : String(error);
}

function VoteLink({ sessionId }: { readonly sessionId: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const url = `${window.location.origin}/vote/${encodeURIComponent(sessionId)}`;

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, { width: 160, margin: 1 })
      .then((data) => {
        if (!cancelled) setQr(data);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="vote-link">
      <a href={url} target="_blank" rel="noreferrer">{url}</a>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(url);
        }}
      >
        复制链接
      </Button>
      {qr === null ? null : <img src={qr} alt="投票二维码" width={160} height={160} />}
    </div>
  );
}

export function VotingCard(props: {
  readonly activityId: string;
  readonly canManageVotes: boolean;
  readonly canManageResults: boolean;
  readonly canManageSessions: boolean;
}) {
  const queryClient = useQueryClient();
  const [candidateText, setCandidateText] = useState("");
  const [preview, setPreview] = useState<VoteResultCandidateView | null>(null);
  const [stageKey, setStageKey] = useState("vote_result");
  const [note, setNote] = useState("");
  const [startMode, setStartMode] = useState<"rehearsal" | "formal">("rehearsal");

  const onRealtimeData = (data: VotingSessionsSnapshot): void => {
    queryClient.setQueryData(["voting-sessions", props.activityId], data);
  };
  const { fallback } = useRealtimeTopic<VotingSessionsSnapshot>(
    props.canManageVotes ? `voting:${props.activityId}` : null,
    onRealtimeData,
  );
  const sessionsQuery = useQuery({
    queryKey: ["voting-sessions", props.activityId],
    queryFn: () => fetchVotingSessions(props.activityId),
    retry: false,
    refetchInterval: fallback ? 5000 : false,
  });
  const executionsQuery = useQuery({
    queryKey: ["executions", props.activityId],
    queryFn: () => fetchExecutions(props.activityId),
    retry: false,
  });
  const publishingQuery = useQuery({
    queryKey: ["publishing-state", props.activityId],
    queryFn: () => fetchPublishingState(props.activityId),
    retry: false,
    enabled: props.canManageResults,
  });

  const sessions = sessionsQuery.data?.sessions ?? [];
  const executions = executionsQuery.data ?? [];
  const stages = publishingQuery.data?.stages ?? [];
  const effectiveStage = stages.some((stage) => stage.key === stageKey)
    ? stageKey
    : stages[0]?.key ?? "vote_result";

  const running = (scope: string) =>
    executions.find((session) => session.scope === scope && session.status === "running");

  const start = useMutation({
    mutationFn: (scope: string) => startExecution(props.activityId, scope, startMode),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["executions", props.activityId] });
    },
  });
  const closeExecutionMutation = useMutation({
    mutationFn: (session: { readonly id: string; readonly revision: number }) =>
      closeExecution(props.activityId, session.id, session.revision),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["executions", props.activityId] });
    },
  });
  const open = useMutation({
    mutationFn: () =>
      openVoteSession(
        props.activityId,
        candidateText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    onSuccess: () => {
      setCandidateText("");
      void queryClient.invalidateQueries({ queryKey: ["voting-sessions", props.activityId] });
    },
  });
  const closeSession = useMutation({
    mutationFn: (session: { readonly id: string; readonly revision: number }) =>
      closeVoteSession(props.activityId, session.id, session.revision),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["voting-sessions", props.activityId] });
    },
  });
  const loadPreview = useMutation({
    mutationFn: (sessionId: string) => previewVoteResult(props.activityId, sessionId),
    onSuccess: (candidate) => setPreview(candidate),
  });
  const confirm = useMutation({
    mutationFn: (candidate: VoteResultCandidateView) =>
      confirmVoteResult(props.activityId, effectiveStage, candidate),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["publishing-state", props.activityId] });
    },
  });
  const release = useMutation({
    mutationFn: (candidateRevision: number) =>
      releaseVoteResult(props.activityId, effectiveStage, candidateRevision, note),
    onSuccess: () => {
      setNote("");
      void queryClient.invalidateQueries({ queryKey: ["publishing-state", props.activityId] });
    },
  });

  const error =
    sessionsQuery.error ??
    executionsQuery.error ??
    start.error ??
    closeExecutionMutation.error ??
    open.error ??
    closeSession.error ??
    loadPreview.error ??
    confirm.error ??
    release.error;

  if (!props.canManageVotes) return null;
  if (sessionsQuery.isLoading) {
    return (
      <Card className="voting-card">
        <p className="auth-loading">正在读取投票…</p>
      </Card>
    );
  }

  const voteSession = running("voting");
  const publishingSession = running("publishing");

  return (
    <Card className="voting-card">
      <h2 className="ui-card__title">投票与发布</h2>

      <div className="voting-sessions">
        {(["voting", "publishing"] as const).map((scope) => {
          const session = running(scope);
          return (
            <div key={scope} className="voting-session-row">
              <span>{scope} 会话</span>
              <span>{session === undefined ? "未启动" : `运行中 · ${session.mode === "formal" ? "正式" : session.mode === "test" ? "测试" : "彩排"}`}</span>
              {props.canManageSessions ? (
                session === undefined ? (
                  <>
                    <select
                      className="ui-select"
                      aria-label="启动模式"
                      value={startMode}
                      onChange={(event) => setStartMode(event.target.value as "rehearsal" | "formal")}
                    >
                      <option value="rehearsal">彩排</option>
                      <option value="formal">正式</option>
                    </select>
                    <Button variant="secondary" size="sm" onClick={() => start.mutate(scope)}>
                      启动
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => closeExecutionMutation.mutate(session)}
                  >
                    关闭会话
                  </Button>
                )
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="voting-new">
        <Textarea
          label="候选（每行一个）"
          rows={4}
          value={candidateText}
          onChange={(event) => setCandidateText(event.target.value)}
        />
        <Button
          variant="primary"
          disabled={voteSession === undefined || open.isPending || candidateText.trim() === ""}
          onClick={() => open.mutate()}
        >
          开启投票
        </Button>
        {voteSession === undefined ? (
          <p className="ui-card__description">先启动 voting 会话。</p>
        ) : null}
      </div>

      <ul className="voting-list">
        {sessions.map((session) => (
          <li key={session.id} className="voting-session">
            <div>
              <strong>{session.id}</strong>
              <span className="ui-card__description">
                {session.status === "open" ? "进行中" : "已关闭"} · {session.candidateCount} 个候选
                {fallback && session.live !== null ? " · 轮询中" : ""}
              </span>
            </div>
            {session.status === "open" ? (
              <ul className="voting-candidates">
                {session.candidates.map((candidate) => (
                  <li key={candidate.optionId}>
                    {candidate.candidateId} · {session.live?.counts[candidate.optionId] ?? 0} 票
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="voting-actions">
              {session.status === "open" ? (
                <Button variant="secondary" size="sm" onClick={() => closeSession.mutate(session)}>
                  关闭场次
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => loadPreview.mutate(session.id)}>
                  预览结果
                </Button>
              )}
            </div>
            {session.status === "open" && session.mode === "formal" ? (
              <VoteLink sessionId={session.id} />
            ) : null}
          </li>
        ))}
      </ul>

      {preview === null ? null : (
        <div className="voting-preview">
          <h3 className="ui-card__title">结果预览</h3>
          <table>
            <thead>
              <tr><th>名次</th><th>候选</th><th>票数</th><th>占比</th></tr>
            </thead>
            <tbody>
              {preview.decisions.map((decision) => (
                <tr key={decision.contestantId}>
                  <td>{decision.rank}</td>
                  <td>{decision.contestantId}</td>
                  <td>{decision.count}</td>
                  <td>{decision.score}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.status === "hold" ? (
            <p className="ui-card__description">没有有效票，无法发布。</p>
          ) : null}
          {props.canManageResults ? (
            <div className="voting-publish">
              <Select
                label="阶段"
                value={effectiveStage}
                onChange={(event) => setStageKey(event.target.value)}
              >
                {stages.map((stage) => (
                  <option key={stage.key} value={stage.key}>{stage.label}</option>
                ))}
              </Select>
              <Button
                variant="primary"
                disabled={confirm.isPending || publishingSession === undefined || preview.status === "hold"}
                onClick={() => confirm.mutate(preview)}
              >
                确认赛果
              </Button>
              <Input
                label="发布备注"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <Button
                variant="primary"
                disabled={release.isPending || note.trim() === "" || confirm.data === undefined}
                onClick={() =>
                  confirm.data === undefined ? undefined : release.mutate(confirm.data.candidateRevision)
                }
              >
                发布结果
              </Button>
              {publishingSession === undefined ? (
                <p className="ui-card__description">先启动 publishing 会话。</p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {error === null || error === undefined ? null : (
        <p className="ui-field__error" role="alert">{humanError(error)}</p>
      )}
    </Card>
  );
}
