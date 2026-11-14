import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  advanceSchedule,
  fetchSchedule,
  releaseSchedule,
  removeScheduleEntry,
  reorderSchedule,
  revokeScheduleRelease,
  upsertScheduleEntry,
  type ScheduleMode,
} from "../../api/schedule.js";
import { closeExecution, fetchExecutions, startExecution } from "../../api/voting.js";
import { apiErrorText } from "../ui/apiError.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { ConfirmDialog } from "../ui/Dialog.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";

const MODE_LABELS: Readonly<Record<ScheduleMode, string>> = {
  test: "测试",
  rehearsal: "彩排",
  formal: "正式",
};

export function ScheduleCard({
  activityId,
  canManage,
}: {
  readonly activityId: string;
  readonly canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ScheduleMode>("formal");
  const [slotKey, setSlotKey] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<{ readonly kind: "remove" | "release" | "revoke"; readonly id?: string } | null>(null);

  const schedule = useQuery({
    queryKey: ["schedule", activityId, mode],
    queryFn: () => fetchSchedule(activityId, mode),
    retry: false,
  });
  const executions = useQuery({
    queryKey: ["executions", activityId],
    queryFn: () => fetchExecutions(activityId),
    retry: false,
  });
  const running = executions.data?.find(
    (session) => session.scope === "schedule" && session.status === "running",
  );
  const data = schedule.data;

  useEffect(() => {
    if (data !== undefined && slotKey === "" && data.slots[0] !== undefined) {
      setSlotKey(data.slots[0].key);
    }
  }, [data, slotKey]);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["schedule", activityId, mode] });
    void queryClient.invalidateQueries({ queryKey: ["executions", activityId] });
  };

  const add = useMutation({
    mutationFn: () =>
      upsertScheduleEntry(activityId, {
        mode,
        expectedRevision: data?.revision ?? 0,
        slotKey,
        title,
        note,
      }),
    onSuccess: () => {
      setTitle("");
      setNote("");
      refresh();
    },
  });
  const reorder = useMutation({
    mutationFn: (orderedIds: readonly string[]) =>
      reorderSchedule(activityId, { mode, expectedRevision: data?.revision ?? 0, orderedIds }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (entryId: string) =>
      removeScheduleEntry(activityId, { mode, expectedRevision: data?.revision ?? 0, entryId }),
    onSuccess: refresh,
  });
  const release = useMutation({
    mutationFn: () =>
      releaseSchedule(activityId, { mode, expectedRevision: data?.revision ?? 0, note }),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (releaseId: string) =>
      revokeScheduleRelease(activityId, releaseId, data?.revision ?? 0, note),
    onSuccess: refresh,
  });
  const advance = useMutation({ mutationFn: () => advanceSchedule(activityId), onSuccess: refresh });
  const start = useMutation({
    mutationFn: () => startExecution(activityId, "schedule", mode),
    onSuccess: refresh,
  });
  const close = useMutation({
    mutationFn: () => {
      if (running === undefined) throw new Error("没有运行中的排期会话。");
      return closeExecution(activityId, running.id, running.revision);
    },
    onSuccess: refresh,
  });

  const error =
    schedule.error ??
    add.error ??
    reorder.error ??
    remove.error ??
    release.error ??
    revoke.error ??
    advance.error ??
    start.error ??
    close.error;
  const entries = data?.entries ?? [];

  function move(index: number, delta: number): void {
    if (data === undefined) return;
    const target = index + delta;
    if (target < 0 || target >= entries.length) return;
    const ids = entries.map((entry) => entry.id);
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.splice(target, 0, moved);
    reorder.mutate(ids);
  }

  return (
    <Card className="schedule-card" data-testid="schedule-card">
      <div className="studio-card-head">
        <h2 className="ui-card__title">节目排期</h2>
        <Select label="排期模式" value={mode} onChange={(event) => setMode(event.target.value as ScheduleMode)}>
          {(["test", "rehearsal", "formal"] as const).map((item) => (
            <option key={item} value={item}>{MODE_LABELS[item]}</option>
          ))}
        </Select>
      </div>
      {schedule.isPending ? <p className="auth-loading">正在加载排期…</p> : null}
      {schedule.error !== null ? <p className="form-error" role="alert">排期暂时无法加载。</p> : null}
      {data === undefined ? null : (
        <>
          <ul className="seat-list" aria-label="节目条目">
            {entries.map((entry, index) => (
              <li key={entry.id} data-testid="schedule-entry">
                <span>
                  {entry.position + 1}. {entry.title} · {entry.slotLabel} · {entry.note || "—"}
                </span>
                {canManage ? (
                  <span className="task-actions">
                    <Button variant="secondary" size="sm" disabled={index === 0} onClick={() => move(index, -1)}>上移</Button>
                    <Button variant="secondary" size="sm" disabled={index === entries.length - 1} onClick={() => move(index, 1)}>下移</Button>
                    <Button variant="secondary" size="sm" onClick={() => setConfirm({ kind: "remove", id: entry.id })}>删除</Button>
                  </span>
                ) : null}
              </li>
            ))}
            {entries.length === 0 ? <li className="ui-card__description">还没有节目条目。</li> : null}
          </ul>
          {canManage ? (
            <div className="editor-grid">
              <Select label="节目类型" value={slotKey} onChange={(event) => setSlotKey(event.target.value)}>
                {data.slots.map((slot) => (
                  <option key={slot.key} value={slot.key}>{slot.label}（{slot.durationMinutes} 分钟）</option>
                ))}
              </Select>
              <Input label="节目名称" value={title} onChange={(event) => setTitle(event.target.value)} />
              <Input label="备注" value={note} onChange={(event) => setNote(event.target.value)} />
              <Button
                variant="primary"
                disabled={add.isPending || title.trim() === "" || slotKey === ""}
                onClick={() => add.mutate()}
              >
                添加节目
              </Button>
            </div>
          ) : null}
          <div className="task-actions">
            {running === undefined ? (
              <Button variant="secondary" disabled={!canManage || start.isPending} onClick={() => start.mutate()}>
                启动排期会话
              </Button>
            ) : (
              <Button variant="secondary" disabled={!canManage || close.isPending} onClick={() => close.mutate()}>
                关闭排期会话
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={!canManage || running === undefined || advance.isPending}
              onClick={() => advance.mutate()}
            >
              下一位
            </Button>
            <Button
              variant="primary"
              disabled={!canManage || entries.length === 0 || note.trim() === "" || release.isPending}
              onClick={() => setConfirm({ kind: "release" })}
            >
              发布节目单
            </Button>
          </div>
          {data.currentEntryId === null ? null : (
            <p className="ui-card__description">
              当前：{entries.find((entry) => entry.id === data.currentEntryId)?.title ?? "—"}
            </p>
          )}
          {data.releases.length === 0 ? null : (
            <ul className="seat-list" aria-label="节目单版本">
              {data.releases.map((item) => (
                <li key={item.id}>
                  <span>第 {item.version} 版 · {item.revokedAt === null ? "生效" : "已撤销"} · {item.note || "—"}</span>
                  {canManage && item.revokedAt === null ? (
                    <Button variant="secondary" size="sm" onClick={() => setConfirm({ kind: "revoke", id: item.id })}>
                      撤销发布
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {error === null || error === undefined ? null : (
            <p className="ui-field__error" role="alert">
              {apiErrorText(error, "排期操作失败，请稍后重试。", "排期已更新，请刷新后重试。")}
            </p>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === "remove"
            ? "删除这个节目？"
            : confirm?.kind === "release"
              ? "发布节目单？"
              : "撤销这一版节目单？"
        }
        description={
          confirm?.kind === "remove"
            ? "删除后需要重新添加；已发布的版本不会被改写。"
            : confirm?.kind === "release"
              ? "发布会冻结当前顺序，生成一个新的公开节目单版本。"
              : "撤销后公开页不再返回这一版；需要重新发布。"
        }
        confirmLabel={confirm?.kind === "remove" ? "删除" : confirm?.kind === "release" ? "发布" : "撤销"}
        danger={confirm?.kind !== "release"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm;
          setConfirm(null);
          if (action?.kind === "remove" && action.id !== undefined) remove.mutate(action.id);
          if (action?.kind === "release") release.mutate();
          if (action?.kind === "revoke" && action.id !== undefined) revoke.mutate(action.id);
        }}
      />
    </Card>
  );
}
