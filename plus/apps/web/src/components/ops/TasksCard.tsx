import type { TaskAction, TaskResponse } from "@artflow-plus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError } from "../../api/client.js";
import { fetchOpsReadiness, fetchOpsTasks, mutateOpsTask } from "../../api/ops.js";

function taskStatusLabel(status: TaskResponse["status"]): string {
  return {
    pending: "待开始",
    in_progress: "进行中",
    blocked: "阻塞",
    done: "已完成",
  }[status];
}

function taskDate(value: string | null): string {
  if (value === null) return "未设置";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function humanError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "任务已被其他操作员更新，请刷新后重试。";
  }
  return error instanceof Error ? error.message : "任务操作失败，请稍后重试。";
}

function actionLabel(action: TaskAction): string {
  return { assign: "分配", start: "开始", block: "阻塞", complete: "完成", reopen: "重新打开" }[action];
}

export function TasksCard({ activityId, canManage }: { readonly activityId: string; readonly canManage: boolean }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [assignee, setAssignee] = useState("");
  const [dueAt, setDueAt] = useState("");
  const tasksQuery = useQuery({
    queryKey: ["ops-tasks", activityId],
    queryFn: () => fetchOpsTasks(activityId),
    retry: false,
  });
  const readinessQuery = useQuery({
    queryKey: ["ops-readiness", activityId],
    queryFn: () => fetchOpsReadiness(activityId),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: ({ task, action }: { readonly task: TaskResponse; readonly action: TaskAction }) => {
      const command = action === "assign"
        ? { assigneeActorId: assignee.trim() === "" ? null : assignee.trim(), dueAt: dueAt === "" ? null : new Date(dueAt).toISOString() }
        : action === "block" || action === "complete" || action === "reopen"
          ? { reason: reason.trim() }
          : {};
      return mutateOpsTask(activityId, task.id, action, task.revision, command);
    },
    onSuccess: () => {
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["ops-tasks", activityId] });
      void queryClient.invalidateQueries({ queryKey: ["ops-readiness", activityId] });
    },
  });

  const queryError = tasksQuery.error ?? readinessQuery.error;
  if (tasksQuery.isPending || readinessQuery.isPending) {
    return <section className="ops-card tasks-card"><p className="auth-loading">正在加载任务准备度…</p></section>;
  }
  if (queryError !== null && queryError !== undefined) {
    return <section className="ops-card tasks-card"><p className="form-error" role="alert">{humanError(queryError)}</p></section>;
  }

  const tasks = tasksQuery.data?.tasks ?? [];
  const summary = readinessQuery.data?.summary;
  return (
    <section className="ops-card tasks-card" data-testid="tasks-card">
      <div className="tasks-card-header">
        <div>
          <p className="eyebrow">TASKS · 执行准备度</p>
          <h2>执行任务</h2>
        </div>
        <span className="analytics-readonly">版本 {tasksQuery.data?.definitionVersion ?? "—"}</span>
      </div>
      {summary === undefined ? null : (
        <div className="tasks-readiness" aria-label="任务准备度">
          <span>总计 {summary.total}</span>
          <span>必需 {summary.required}</span>
          <span>已完成 {summary.done}</span>
          <span>阻塞 {summary.blocked}</span>
          <span>逾期 {summary.overdue}</span>
        </div>
      )}
      {summary === undefined || summary.total - summary.done === 0 ? (
        <p className="tasks-clear">当前没有未完成的任务。</p>
      ) : (
        <p className="tasks-attention">还有 {summary.total - summary.done} 个任务未完成</p>
      )}
      {tasks.length === 0 ? (
        <p className="tasks-empty">当前版本还没有同步任务模板。</p>
      ) : (
        <ul className="tasks-list">
          {tasks.map((task) => (
            <li key={task.id} className="task-row">
              <div className="task-row-main">
                <div>
                  <strong>{task.title}</strong>
                  <span className="state-copy">{task.sourceCapability} · {task.sourceKey}</span>
                </div>
                <span className={`status-badge status-${task.status}`}>{taskStatusLabel(task.status)}</span>
              </div>
              <dl className="task-facts">
                <div><dt>负责人</dt><dd>{task.assigneeActorId ?? "未分配"}</dd></div>
                <div><dt>截止</dt><dd>{taskDate(task.dueAt)}{task.status !== "done" && task.dueAt !== null && new Date(task.dueAt).getTime() < Date.now() ? " · 逾期" : ""}</dd></div>
                {task.blockedReason === null ? null : <div><dt>阻塞原因</dt><dd>{task.blockedReason}</dd></div>}
                {task.completionReason === null ? null : <div><dt>完成说明</dt><dd>{task.completionReason}</dd></div>}
              </dl>
              {canManage ? (
                <div className="task-actions">
                  {task.status === "pending" ? <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={() => mutation.mutate({ task, action: "start" })}>{actionLabel("start")}</button> : null}
                  {task.status === "in_progress" || task.status === "pending" ? <button type="button" className="secondary-button" disabled={mutation.isPending || reason.trim() === ""} onClick={() => mutation.mutate({ task, action: "block" })}>{actionLabel("block")}</button> : null}
                  {task.status === "in_progress" ? <button type="button" className="primary-button" disabled={mutation.isPending || reason.trim() === ""} onClick={() => mutation.mutate({ task, action: "complete" })}>{actionLabel("complete")}</button> : null}
                  {task.status === "blocked" || task.status === "done" ? <button type="button" className="secondary-button" disabled={mutation.isPending || reason.trim() === ""} onClick={() => mutation.mutate({ task, action: "reopen" })}>{actionLabel("reopen")}</button> : null}
                  <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={() => mutation.mutate({ task, action: "assign" })}>{actionLabel("assign")}</button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <div className="task-command-fields">
          <label>负责人<input value={assignee} onChange={(event) => setAssignee(event.target.value)} placeholder="actor id（可留空取消分配）" /></label>
          <label>截止时间<input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
          <label>操作说明<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="阻塞、完成或重新打开时必填" /></label>
        </div>
      ) : null}
      {mutation.error === null || mutation.error === undefined ? null : <p className="form-error" role="alert">{humanError(mutation.error)}</p>}
    </section>
  );
}
