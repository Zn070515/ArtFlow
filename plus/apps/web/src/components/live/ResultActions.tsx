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
  revokeResultRelease,
  startExecution,
  unlockStageResult,
} from "../../api/voting.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

function releaseStatusText(status: "active" | "revoked" | "superseded"): string {
  switch (status) {
    case "active":
      return "生效";
    case "revoked":
      return "已撤销";
    case "superseded":
      return "已替代";
  }
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
  const [status, setStatus] = useState<string | null>(null);
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
  const stageResult = publishing.data?.stageResults.find((item) => item.stageKey === stageKey);
  const effectiveConfirmedRevision =
    publishing.data === undefined
      ? confirmedRevision
      : stageResult?.status === "confirmed"
        ? stageResult.candidateRevision
        : undefined;
  const stageLabel =
    publishing.data?.stages.find((stage) => stage.key === stageKey)?.label ?? stageKey ?? "";
  const stageReleases = publishing.data?.releases.filter((item) => item.stageKey === stageKey) ?? [];
  const activeReleases = stageReleases.filter((item) => item.status === "active");
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
      if (stageKey === undefined || effectiveConfirmedRevision === undefined) throw new Error("先确认赛果。");
      return releasePodiumResult(activityId, stageKey, effectiveConfirmedRevision, note.trim());
    },
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (releaseId: string) => revokeResultRelease(activityId, releaseId, note.trim()),
    onSuccess: () => {
      setStatus("已撤销发布，可重新发布。");
      refresh();
    },
  });
  const unlock = useMutation({
    mutationFn: (revision: number) => {
      if (stageKey === undefined) throw new Error("没有可解锁的赛段。");
      return unlockStageResult(activityId, stageKey, revision, note.trim());
    },
    onSuccess: () => {
      setConfirmedRevision(undefined);
      setStatus("已解锁赛果，请重新确认后再发布。");
      refresh();
    },
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
    revoke.isPending ||
    unlock.isPending ||
    close.isPending ||
    archive.isPending ||
    unarchive.isPending;
  const error =
    recompute.error ??
    confirm.error ??
    release.error ??
    revoke.error ??
    unlock.error ??
    close.error ??
    archive.error ??
    unarchive.error;

  return (
    <Card className="result-actions-card" data-testid="live-result-actions">
      <h2 className="ui-card__title">排名与公示</h2>
      <p className="ui-card__description">
        {formal ? "正式评分会话" : "彩排会话只能生成候选前的排名；正式赛果需要 formal 会话。"}
      </p>
      {candidate === null ? (
        <p className="ui-card__description">还没有领奖候选。</p>
      ) : (
        <>
          <p className="ui-card__description">候选 #{candidate.revision} · {candidate.status === "candidate" ? "可确认" : "暂不可确认"}</p>
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
        <Button variant="secondary" disabled={busy || !formal || roundIds.length === 0} onClick={() => recompute.mutate()}>
          生成领奖候选
        </Button>
        {publishingSession === undefined ? (
          <Button variant="secondary" disabled={busy} onClick={() => startPublishing.mutate()}>
            启动发布会话
          </Button>
        ) : (
          <span className="ui-card__description">发布会话运行中</span>
        )}
        <Button variant="secondary" disabled={busy || publishingSession === undefined || candidate?.status !== "candidate"} onClick={() => confirm.mutate()}>
          确认评委赛果
        </Button>
        <Button variant="primary" disabled={busy || publishingSession === undefined || effectiveConfirmedRevision === undefined || activeReleases.length > 0 || note.trim() === ""} onClick={() => release.mutate()}>
          发布赛果
        </Button>
        {stageReleases.length === 0 ? null : (
          <ul className="seat-list">
            {stageReleases.map((item) => (
              <li key={item.id} data-testid="release-status" data-release-status={item.status}>
                {stageLabel} · {releaseStatusText(item.status)} ·{" "}
                {new Date(item.releasedAt).toLocaleString("zh-CN")}
              </li>
            ))}
          </ul>
        )}
        {activeReleases.map((item) => (
          <Button key={item.id} variant="secondary" disabled={busy || publishingSession === undefined || note.trim() === ""} onClick={() => revoke.mutate(item.id)}>
            撤销发布
          </Button>
        ))}
        {stageResult?.status === "confirmed" ? (
          <Button variant="secondary" disabled={busy || note.trim() === "" || publishingSession === undefined} onClick={() => unlock.mutate(stageResult.candidateRevision)}>
            解锁赛果
          </Button>
        ) : null}
      </div>
      <Input
        label="发布 / 归档说明"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="发布和归档都需要说明"
      />
      <div className="task-actions">
        <Button variant="secondary" disabled={busy || state.activity.status === "archived"} onClick={() => close.mutate()}>
          关闭活动
        </Button>
        <Button variant="secondary" disabled={busy || state.activity.status !== "closed" || note.trim() === ""} onClick={() => archive.mutate()}>
          归档活动
        </Button>
        {state.activity.status === "archived" ? (
          <Button variant="secondary" disabled={busy || note.trim() === ""} onClick={() => unarchive.mutate()}>
            取消归档
          </Button>
        ) : null}
      </div>
      {status === null ? null : <p className="ui-card__description" role="status">{status}</p>}
      {publishing.error === null || publishing.error === undefined ? null : <p className="ui-field__error" role="alert">赛果状态暂时不可用。</p>}
      {error === null || error === undefined ? null : <p className="ui-field__error" role="alert">{errorText(error)}</p>}
    </Card>
  );
}
