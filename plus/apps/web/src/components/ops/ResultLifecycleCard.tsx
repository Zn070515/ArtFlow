import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ApiError } from "../../api/client.js";
import {
  archiveActivity,
  closeActivity,
  confirmStageResult,
  downloadArchiveFile,
  fetchArchiveState,
  fetchPublishingDetail,
  previewPodium,
  recomputePodium,
  releaseStageResult,
  type PodiumPreviewView,
} from "../../api/results.js";
import { closeExecution, fetchExecutions, startExecution } from "../../api/voting.js";
import { declaredStageKey } from "./publishingStage.js";

export interface ResultLifecycleActivity {
  readonly id: string;
  readonly publicCode: string;
  readonly status: string;
  readonly revision: number;
  readonly hasCompetition: boolean;
  readonly hasPublishing: boolean;
  readonly hasArchive: boolean;
  readonly canManageResults: boolean;
  readonly canManageCompetition: boolean;
  readonly canManageSessions: boolean;
  readonly canClose: boolean;
  readonly canArchive: boolean;
}

function humanError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "FORMAL_MODE_REQUIRED") return "正式赛果只能在正式场次核定。请启动正式 publishing 会话。";
  if (code === "SESSION_NOT_RUNNING") return "先启动 publishing 正式会话。";
  if (code === "RESULT_CANDIDATE_HOLD") return "排名还不能核定。请锁定每一轮并裁决同分。";
  if (code === "ARCHIVE_RESULT_NOT_RELEASED") return "先公示正式赛果，再归档。";
  if (code === "ACTIVITY_HAS_RUNNING_SESSIONS") return "先关闭仍在运行的执行会话。";
  if (code === "STALE_REVISION") return "活动已更新，请刷新后重试。";
  if (code === "STALE_RESOLUTION_INPUT") return "排名在核定前变化了，请重试。";
  if (code === "RESULT_NOT_CONFIRMED") return "先核定赛果再公示。";
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

function blockedCopy(preview: PodiumPreviewView): string {
  if (preview.blockedReason === "unresolved_ties") return "还有未裁决的同分。请先在 Live 裁决，再核定赛果。";
  return "正式场次的排名还没有全部锁定。请在 Live 生成正式排名后再核定。";
}

export function ResultLifecycleCard({ activity }: { readonly activity: ResultLifecycleActivity }) {
  const queryClient = useQueryClient();
  const [stageKey, setStageKey] = useState("");
  const [note, setNote] = useState("");
  const [archiveNote, setArchiveNote] = useState("");
  const [revision, setRevision] = useState(activity.revision);
  const [confirmedRevision, setConfirmedRevision] = useState<{ readonly stageKey: string; readonly revision: number } | null>(null);
  const activityId = activity.id;

  useEffect(() => {
    setRevision(activity.revision);
  }, [activity.revision]);

  const executionsQuery = useQuery({
    queryKey: ["executions", activityId],
    queryFn: () => fetchExecutions(activityId),
    enabled: activity.canManageSessions || activity.canClose || activity.canManageResults,
    retry: false,
  });
  const executions = executionsQuery.data ?? [];
  const publishingSession = executions.find((session) => session.scope === "publishing" && session.status === "running");
  const runningSessions = executions.filter((session) => session.status === "running");

  const publishingQuery = useQuery({
    queryKey: ["publishing-detail", activityId],
    queryFn: () => fetchPublishingDetail(activityId),
    enabled: activity.hasPublishing && activity.canManageResults,
    retry: false,
  });
  const stages = publishingQuery.data?.stages ?? [];
  const stage = declaredStageKey(stages, stageKey);
  const stageLabel = stages.find((item) => item.key === stage)?.label ?? stage ?? "";
  const confirmed = publishingQuery.data?.stageResults.find((item) => item.stageKey === stage && item.status === "confirmed");
  const activeRelease = publishingQuery.data?.releases.some((item) => item.stageKey === stage && item.status === "active") ?? false;

  const previewQuery = useQuery({
    queryKey: ["podium-preview", activityId, publishingSession?.id ?? "none"],
    queryFn: () => previewPodium(activityId, "publishing"),
    enabled: activity.hasCompetition && activity.canManageCompetition && publishingSession?.mode === "formal",
    retry: false,
  });

  const archiveQuery = useQuery({
    queryKey: ["archive-state", activityId],
    queryFn: () => fetchArchiveState(activityId),
    enabled: activity.hasArchive && activity.canArchive,
    retry: false,
  });
  const hasPackage = archiveQuery.data?.packages.some((item) => item.isCurrent) ?? false;

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["executions", activityId] });
    void queryClient.invalidateQueries({ queryKey: ["publishing-detail", activityId] });
    void queryClient.invalidateQueries({ queryKey: ["podium-preview", activityId] });
    void queryClient.invalidateQueries({ queryKey: ["archive-state", activityId] });
    void queryClient.invalidateQueries({ queryKey: ["ops-activities"] });
    void queryClient.invalidateQueries({ queryKey: ["ops-analytics", activityId] });
  }

  const startPublishing = useMutation({
    mutationFn: () => startExecution(activityId, "publishing", "formal"),
    onSuccess: refresh,
  });
  const closeSession = useMutation({
    mutationFn: (session: { readonly id: string; readonly revision: number }) =>
      closeExecution(activityId, session.id, session.revision),
    onSuccess: refresh,
  });
  const confirm = useMutation({
    mutationFn: async () => {
      const preview = previewQuery.data;
      const selectedStage = stage;
      if (preview === undefined || selectedStage === null) {
        throw new Error("还没有可核定的正式赛果。");
      }
      const stored = await recomputePodium(activityId, {
        scope: "publishing",
        roundIds: preview.roundIds,
        expectedInputFingerprint: preview.inputFingerprint,
      });
      if (stored.status !== "candidate") throw new Error("排名还不能核定。");
      const confirmed = await confirmStageResult(activityId, selectedStage, {
        expectedSourceRevision: stored.revision,
        expectedInputFingerprint: stored.inputFingerprint,
      });
      return { stageKey: selectedStage, candidateRevision: confirmed.candidateRevision };
    },
    onSuccess: (result) => {
      setConfirmedRevision({ stageKey: result.stageKey, revision: result.candidateRevision });
      refresh();
    },
  });
  const release = useMutation({
    mutationFn: (candidateRevision: number) => {
      if (stage === null) throw new Error("发布定义里没有赛果阶段。");
      return releaseStageResult(activityId, stage, candidateRevision, note.trim());
    },
    onSuccess: () => {
      setNote("");
      refresh();
    },
  });
  const close = useMutation({
    mutationFn: () => closeActivity(activityId, revision),
    onSuccess: (saved) => {
      setRevision(saved.revision);
      refresh();
    },
  });
  const archive = useMutation({
    mutationFn: () => archiveActivity(activityId, revision, archiveNote.trim()),
    onSuccess: () => {
      setArchiveNote("");
      refresh();
    },
  });
  const download = useMutation({ mutationFn: () => downloadArchiveFile(activityId) });

  const error = confirm.error ?? release.error ?? close.error ?? archive.error ?? download.error
    ?? startPublishing.error ?? closeSession.error ?? previewQuery.error;
  const releaseRevision = confirmedRevision?.stageKey === stage
    ? confirmedRevision.revision
    : confirmed?.candidateRevision ?? null;
  const preview = previewQuery.data;
  const canConfirm = activity.canManageResults && stage !== null && preview?.status === "candidate"
    && publishingSession?.mode === "formal";

  return (
    <section className="ops-card result-lifecycle-card" data-testid="result-lifecycle-card">
      <p className="eyebrow">RESULTS · 赛果与归档</p>
      <h2>核定、公示与归档</h2>
      <p className="state-copy">
        公开结果页{" "}
        <a className="table-link" href={`/results/${encodeURIComponent(activity.publicCode)}`}>
          /results/{activity.publicCode}
        </a>
      </p>

      {activity.hasPublishing && activity.canManageSessions ? (
        <div className="voting-session-row">
          <span>publishing 会话</span>
          <span>{publishingSession === undefined ? "未启动" : `运行中 · ${publishingSession.mode}`}</span>
          {publishingSession === undefined ? (
            <button type="button" className="secondary-button" disabled={startPublishing.isPending} onClick={() => startPublishing.mutate()}>
              启动正式会话
            </button>
          ) : (
            <button type="button" className="secondary-button" disabled={closeSession.isPending} onClick={() => closeSession.mutate(publishingSession)}>
              关闭会话
            </button>
          )}
        </div>
      ) : null}

      {activity.hasPublishing && activity.canManageResults ? (
        <div className="voting-publish">
          {stages.length === 0 ? (
            <p className="state-copy">发布定义里还没有赛果阶段。</p>
          ) : (
            <label>
              阶段
              <select value={stage ?? ""} onChange={(event) => setStageKey(event.target.value)}>
                {stages.map((item) => (
                  <option key={item.key} value={item.key}>{item.label}</option>
                ))}
              </select>
            </label>
          )}
          {stageLabel === "" ? null : <p className="state-copy">将写入阶段「{stageLabel}」。</p>}
          {activity.hasCompetition && preview?.status === "candidate" ? (
            <table>
              <caption>评委赛果候选</caption>
              <thead>
                <tr><th>名次</th><th>选手</th><th>总分</th></tr>
              </thead>
              <tbody>
                {preview.placements.map((placement) => (
                  <tr key={placement.contestantId}>
                    <td>{placement.place}</td>
                    <td>{placement.contestantId}</td>
                    <td>{placement.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {activity.hasCompetition && preview?.status === "hold" ? <p className="state-copy">{blockedCopy(preview)}</p> : null}
          {publishingSession === undefined ? <p className="state-copy">先启动 publishing 正式会话，再核定并公示。</p> : null}
          {publishingSession !== undefined && publishingSession.mode !== "formal" ? (
            <p className="state-copy">当前 publishing 会话不是正式场次，不能核定或公示。</p>
          ) : null}
          {activity.hasCompetition ? (
            <button type="button" className="primary-button" disabled={!canConfirm || confirm.isPending} onClick={() => confirm.mutate()}>
              核定赛果
            </button>
          ) : null}
          <label>
            发布备注
            <input value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={release.isPending || stage === null || note.trim() === "" || typeof releaseRevision !== "number" || publishingSession?.mode !== "formal"}
            onClick={() => {
              if (typeof releaseRevision !== "number") return;
              release.mutate(releaseRevision);
            }}
          >
            公示
          </button>
          {activeRelease ? <p className="state-copy">该阶段已有生效的公示。</p> : null}
        </div>
      ) : null}

      {activity.canClose && activity.status === "active" ? (
        <div className="voting-publish">
          {runningSessions.length === 0 ? null : (
            <div>
              <p className="state-copy">关闭活动前，先结束这些执行会话。</p>
              <ul className="voting-list">
                {runningSessions.map((session) => (
                  <li key={session.id}>
                    <span>{session.scope} · {session.mode}</span>
                    {activity.canManageSessions ? (
                      <button type="button" className="secondary-button" disabled={closeSession.isPending} onClick={() => closeSession.mutate(session)}>
                        关闭会话
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={close.isPending || runningSessions.length > 0}
            onClick={() => close.mutate()}
          >
            关闭活动
          </button>
        </div>
      ) : null}

      {activity.hasArchive && activity.canArchive ? (
        <div className="voting-publish">
          {activity.status === "closed" ? (
            <>
              <label>
                归档说明
                <input value={archiveNote} onChange={(event) => setArchiveNote(event.target.value)} />
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={archive.isPending || archiveNote.trim() === ""}
                onClick={() => archive.mutate()}
              >
                归档
              </button>
            </>
          ) : activity.status === "active" ? (
            <p className="state-copy">先关闭活动，再归档。</p>
          ) : null}
          {hasPackage ? (
            <button type="button" className="secondary-button" disabled={download.isPending} onClick={() => download.mutate()}>
              下载归档包
            </button>
          ) : null}
        </div>
      ) : null}

      {error === null || error === undefined ? null : <p className="form-error" role="alert">{humanError(error)}</p>}
    </section>
  );
}
