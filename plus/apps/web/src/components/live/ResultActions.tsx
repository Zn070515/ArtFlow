import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { LiveState } from "../../api/live.js";
import { archiveActivity, closeActivity, unarchiveActivity } from "../../api/ops.js";
import {
  confirmPodiumResult,
  fetchExecutions,
  fetchPublishingState,
  recomputePodiumCandidate,
  releasePodiumResult,
  startExecution,
} from "../../api/voting.js";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

export function ResultActions({
  activityId,
  state,
  onChanged,
}: {
  readonly activityId: string;
  readonly state: LiveState;
  readonly onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [confirmedRevision, setConfirmedRevision] = useState<number | undefined>();
  const publishing = useQuery({
    queryKey: ["live-publishing", activityId],
    queryFn: () => fetchPublishingState(activityId),
    retry: false,
  });
  const executions = useQuery({
    queryKey: ["executions", activityId],
    queryFn: () => fetchExecutions(activityId),
    retry: false,
  });
  const publishingSession = executions.data?.find(
    (session) => session.scope === "publishing" && session.status === "running",
  );

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["live-publishing", activityId] });
    onChanged();
  };

  const roundIds = state.rounds
    .map((round) => round.round?.id)
    .filter((id): id is string => id !== undefined);
  const stageKey = publishing.data?.stages[0]?.key;
  const candidate = publishing.data?.podiumCandidate ?? null;
  const formal = state.session?.mode === "formal";

  const startPublishing = useMutation({
    mutationFn: () => startExecution(activityId, "publishing", "formal"),
    onSuccess: refresh,
  });
  const recompute = useMutation({
    mutationFn: () => recomputePodiumCandidate(activityId, roundIds),
    onSuccess: refresh,
  });
  const confirm = useMutation({
    mutationFn: () => {
      if (stageKey === undefined || candidate === null) throw new Error("没有可确认的赛果候选。");
      return confirmPodiumResult(activityId, stageKey, candidate);
    },
    onSuccess: (result) => {
      setConfirmedRevision(result.candidateRevision);
      refresh();
    },
  });
  const release = useMutation({
    mutationFn: () => {
      if (stageKey === undefined || confirmedRevision === undefined) throw new Error("先确认赛果。");
      return releasePodiumResult(activityId, stageKey, confirmedRevision, note.trim());
    },
    onSuccess: refresh,
  });
  const close = useMutation({
    mutationFn: () => closeActivity(activityId, state.activity.revision),
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: () => archiveActivity(activityId, state.activity.revision, note.trim()),
    onSuccess: refresh,
  });
  const unarchive = useMutation({
    mutationFn: () => unarchiveActivity(activityId, state.activity.revision, note.trim()),
    onSuccess: refresh,
  });

  const busy =
    recompute.isPending ||
    confirm.isPending ||
    release.isPending ||
    close.isPending ||
    archive.isPending ||
    unarchive.isPending;
  const error =
    recompute.error ?? confirm.error ?? release.error ?? close.error ?? archive.error ?? unarchive.error;

  return (
    <section className="ops-card result-actions-card" data-testid="live-result-actions">
      <p className="eyebrow">RESULT · 赛果</p>
      <h2 className="console-card-title">排名与公示</h2>
      <p className="state-copy">
        {formal ? "正式评分会话" : "彩排会话只能生成候选前的排名；正式赛果需要 formal 会话。"}
      </p>
      {candidate === null ? (
        <p className="state-copy">还没有领奖候选。</p>
      ) : (
        <>
          <p className="state-copy">候选 #{candidate.revision} · {candidate.status === "candidate" ? "可确认" : "暂不可确认"}</p>
          <ol className="seat-list">
            {candidate.placements.map((placement) => (
              <li key={`${placement.place}-${placement.contestantId}`}>
                第 {placement.place} 名 · {state.participantNames[placement.contestantId] ?? placement.contestantId} · {placement.total}
              </li>
            ))}
          </ol>
        </>
      )}
      <div className="task-actions">
        <button type="button" className="secondary-button" disabled={busy || !formal || roundIds.length === 0} onClick={() => recompute.mutate()}>
          生成领奖候选
        </button>
        {publishingSession === undefined ? (
          <button type="button" className="secondary-button" disabled={busy} onClick={() => startPublishing.mutate()}>
            启动发布会话
          </button>
        ) : (
          <span className="state-copy">发布会话运行中</span>
        )}
        <button type="button" className="secondary-button" disabled={busy || publishingSession === undefined || candidate?.status !== "candidate"} onClick={() => confirm.mutate()}>
          确认评委赛果
        </button>
        <button type="button" className="primary-button" disabled={busy || publishingSession === undefined || confirmedRevision === undefined || note.trim() === ""} onClick={() => release.mutate()}>
          发布赛果
        </button>
      </div>
      <label className="field">
        <span>发布 / 归档说明</span>
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="发布和归档都需要说明" />
      </label>
      <div className="task-actions">
        <button type="button" className="secondary-button" disabled={busy || state.activity.status === "archived"} onClick={() => close.mutate()}>
          关闭活动
        </button>
        <button type="button" className="secondary-button" disabled={busy || state.activity.status !== "closed" || note.trim() === ""} onClick={() => archive.mutate()}>
          归档活动
        </button>
        {state.activity.status === "archived" ? (
          <button
            type="button"
            className="secondary-button"
            disabled={busy || note.trim() === ""}
            onClick={() => unarchive.mutate()}
          >
            取消归档
          </button>
        ) : null}
      </div>
      {publishing.error === null || publishing.error === undefined ? null : <p className="form-error" role="alert">赛果状态暂时不可用。</p>}
      {error === null || error === undefined ? null : <p className="form-error" role="alert">{errorText(error)}</p>}
    </section>
  );
}
