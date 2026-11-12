import type { TaskAction, TaskResponse } from "@artflow-plus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError } from "../../api/client.js";
import { fetchReadiness, fetchTasks, mutateTask, syncTasks } from "../../api/tasks.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";

function taskStatusLabel(status: TaskResponse["status"]): string {
  return {
    pending: "待开始",
    in_progress: "进行中",
    blocked: "阻塞",
    done: "已完成",
  }[status];
}

const TASK_STATUS_TONES: Readonly<Record<TaskResponse["status"], BadgeTone>> = {
  pending: "neutral",
  in_progress: "info",
  blocked: "warning",
  done: "success",
};

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
    queryFn: () => fetchTasks(activityId),
    retry: false,
  });
  const readinessQuery = useQuery({
    queryKey: ["ops-readiness", activityId],
    queryFn: () => fetchReadiness(activityId),
    retry: false,
  });
  const syncMutation = useMutation({
    mutationFn: () => {
      const definitionVersion = tasksQuery.data?.definitionVersion;
      if (definitionVersion === undefined) throw new Error("任务定义版本不可用。");
      return syncTasks(activityId, definitionVersion);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ops-tasks", activityId] });
      void queryClient.invalidateQueries({ queryKey: ["ops-readiness", activityId] });
    },
  });
  const mutation = useMutation({
    mutationFn: ({ task, action }: { readonly task: TaskResponse; readonly action: TaskAction }) => {
      const command = action === "assign"
        ? { assigneeActorId: assignee.trim() === "" ? null : assignee.trim(), dueAt: dueAt === "" ? null : new Date(dueAt).toISOString() }
        : action === "block" || action === "complete" || action === "reopen"
          ? { reason: reason.trim() }
          : {};
      return mutateTask(activityId, task.id, action, { expectedRevision: task.revision, ...command });
    },
    onSuccess: () => {
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["ops-tasks", activityId] });
      void queryClient.invalidateQueries({ queryKey: ["ops-readiness", activityId] });
    },
  });

  const queryError = tasksQuery.error ?? readinessQuery.error;
  if (tasksQuery.isPending || readinessQuery.isPending) {
    return (
      <Card className="tasks-card">
        <p className="auth-loading">正在加载任务准备度…</p>
      </Card>
    );
  }
  if (queryError !== null && queryError !== undefined) {
    return (
      <Card className="tasks-card">
        <p className="ui-field__error" role="alert">{humanError(queryError)}</p>
      </Card>
    );
  }

  const tasks = tasksQuery.data?.tasks ?? [];
  const summary = readinessQuery.data?.summary;
  return (
    <Card className="tasks-card" data-testid="tasks-card">
      <div className="tasks-card-header">
        <div>
          <h2 className="ui-card__title">执行任务</h2>
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
      {tasks.length === 0 ? (
        <div className="tasks-empty-block">
          <p className="ui-card__description">当前版本还没有同步任务模板。</p>
          {canManage ? (
            <Button
              variant="primary"
              disabled={syncMutation.isPending || tasksQuery.data?.definitionVersion === undefined}
              onClick={() => syncMutation.mutate()}
            >
              同步任务模板
            </Button>
          ) : null}
        </div>
      ) : summary === undefined || summary.total - summary.done === 0 ? (
        <p className="tasks-clear">当前没有未完成的任务。</p>
      ) : (
        <p className="tasks-attention">还有 {summary.total - summary.done} 个任务未完成</p>
      )}
      {tasks.length === 0 ? null : (
        <ul className="tasks-list">
          {tasks.map((task) => (
            <li key={task.id} className="task-row">
              <div className="task-row-main">
                <div>
                  <strong>{task.title}</strong>
                  <span className="ui-card__description">{task.sourceCapability} · {task.sourceKey}</span>
                </div>
                <Badge tone={TASK_STATUS_TONES[task.status]}>{taskStatusLabel(task.status)}</Badge>
              </div>
              <dl className="task-facts">
                <div><dt>负责人</dt><dd>{task.assigneeActorId ?? "未分配"}</dd></div>
                <div><dt>截止</dt><dd>{taskDate(task.dueAt)}{task.status !== "done" && task.dueAt !== null && new Date(task.dueAt).getTime() < Date.now() ? " · 逾期" : ""}</dd></div>
                {task.blockedReason === null ? null : <div><dt>阻塞原因</dt><dd>{task.blockedReason}</dd></div>}
                {task.completionReason === null ? null : <div><dt>完成说明</dt><dd>{task.completionReason}</dd></div>}
              </dl>
              {canManage ? (
                <div className="task-actions">
                  {task.status === "pending" ? <Button variant="secondary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate({ task, action: "start" })}>{actionLabel("start")}</Button> : null}
                  {task.status === "in_progress" || task.status === "pending" ? <Button variant="secondary" size="sm" disabled={mutation.isPending || reason.trim() === ""} onClick={() => mutation.mutate({ task, action: "block" })}>{actionLabel("block")}</Button> : null}
                  {task.status === "in_progress" ? <Button variant="primary" size="sm" disabled={mutation.isPending || reason.trim() === ""} onClick={() => mutation.mutate({ task, action: "complete" })}>{actionLabel("complete")}</Button> : null}
                  {task.status === "blocked" || task.status === "done" ? <Button variant="secondary" size="sm" disabled={mutation.isPending || reason.trim() === ""} onClick={() => mutation.mutate({ task, action: "reopen" })}>{actionLabel("reopen")}</Button> : null}
                  <Button variant="secondary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate({ task, action: "assign" })}>{actionLabel("assign")}</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <div className="task-command-fields">
          <Input label="负责人" value={assignee} onChange={(event) => setAssignee(event.target.value)} placeholder="actor id（可留空取消分配）" />
          <Input label="截止时间" type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
          <Input label="操作说明" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="阻塞、完成或重新打开时必填" />
        </div>
      ) : null}
      {mutation.error === null || mutation.error === undefined ? null : <p className="ui-field__error" role="alert">{humanError(mutation.error)}</p>}
      {syncMutation.error === null || syncMutation.error === undefined ? null : <p className="ui-field__error" role="alert">{humanError(syncMutation.error)}</p>}
    </Card>
  );
}
