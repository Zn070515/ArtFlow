import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  cancelBooking,
  confirmBooking,
  createBooking,
  fetchResources,
  updateBooking,
  type ResourceBooking,
} from "../../api/resources.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";
import { apiErrorText } from "../ui/apiError.js";

const STATUS_LABELS: Readonly<Record<ResourceBooking["status"], string>> = {
  draft: "草稿",
  confirmed: "已确认",
  cancelled: "已取消",
};

function formatWindow(booking: ResourceBooking): string {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${formatter.format(new Date(booking.startsAt))} – ${formatter.format(new Date(booking.endsAt))}`;
}

function toIso(value: string): string {
  return new Date(value).toISOString();
}

function toLocalInput(value: string): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ResourcesCard({
  activityId,
  permissions,
}: {
  readonly activityId: string;
  readonly permissions: readonly string[];
}) {
  const canManage = permissions.includes("*") || permissions.includes("resources.manage");
  const queryClient = useQueryClient();
  const [resourceKey, setResourceKey] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [editing, setEditing] = useState<ResourceBooking | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["resources", activityId],
    queryFn: () => fetchResources(activityId),
    enabled: canManage,
    retry: false,
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["resources", activityId] });
  };

  const create = useMutation({
    mutationFn: () => {
      if (editing !== null) {
        return updateBooking(activityId, editing, crypto.randomUUID(), {
          title: title.trim(),
          note: note.trim(),
          startsAt: toIso(startsAt),
          endsAt: toIso(endsAt),
        });
      }
      const selected = resourceKey === "" ? query.data?.resources[0]?.key ?? "" : resourceKey;
      return createBooking(activityId, crypto.randomUUID(), {
        resourceKey: selected,
        title: title.trim(),
        ...(note.trim() === "" ? {} : { note: note.trim() }),
        startsAt: toIso(startsAt),
        endsAt: toIso(endsAt),
      });
    },
    onSuccess: async () => {
      setEditing(null);
      setTitle("");
      setNote("");
      setStartsAt("");
      setEndsAt("");
      setError(null);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "创建预约失败。", "时间或资源冲突，请刷新后重试。")),
  });

  const confirm = useMutation({
    mutationFn: (booking: ResourceBooking) => confirmBooking(activityId, booking, crypto.randomUUID()),
    onSuccess: async () => {
      setError(null);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "确认预约失败。", "该资源在这个时段已被确认。")),
  });

  const cancel = useMutation({
    mutationFn: (booking: ResourceBooking) => cancelBooking(activityId, booking, cancelReason.trim(), crypto.randomUUID()),
    onSuccess: async () => {
      setCancelReason("");
      setError(null);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "取消预约失败。", "预约已被其他人修改，请刷新后重试。")),
  });

  if (!canManage) return null;
  const resources = query.data?.resources ?? [];
  const bookings = query.data?.bookings ?? [];
  const canSubmit = title.trim() !== "" && startsAt !== "" && endsAt !== "" && new Date(endsAt) > new Date(startsAt);

  return (
    <Card className="resources-card" data-testid="resources-card">
      <h2 className="ui-card__title">资源与排练</h2>
      {query.error !== null ? <p className="ui-field__error" role="alert">{apiErrorText(query.error, "资源暂时无法加载。", "刷新后重试。")}</p> : null}
      {resources.length === 0 ? (
        <p className="ui-card__description">当前 release 没有定义资源；在 Studio 的资源定义中加入场地、设备或人员。</p>
      ) : (
        <>
          <ul className="seat-list">
            {resources.map((resource) => (
              <li key={resource.key}>
                <strong>{resource.name}</strong>
                <span> · {resource.kind === "venue" ? "场地" : resource.kind === "equipment" ? "设备" : "人员"}</span>
                {resource.capacity === undefined ? null : <span> · 容量 {resource.capacity}</span>}
                {resource.notes === "" ? null : <span> · {resource.notes}</span>}
              </li>
            ))}
          </ul>

          <div className="auth-form">
            {editing === null ? (
              <label className="ui-field">
                <span className="ui-field__label">资源</span>
                <select className="ui-input" value={resourceKey} onChange={(event) => setResourceKey(event.target.value)}>
                  {resources.map((resource) => (
                    <option key={resource.key} value={resource.key}>{resource.name}</option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="ui-card__description">编辑：{editing.resourceName}（资源不可更换）</p>
            )}
            <Input label="用途 / 标题" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
            <Input label="开始" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
            <Input label="结束" type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
            <Input label="预约说明" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} />
            <Button variant="secondary" onClick={() => create.mutate()} disabled={create.isPending || !canSubmit}>
              {editing === null ? "添加预约" : "保存修改"}
            </Button>
            {editing === null ? null : (
              <Button variant="secondary" onClick={() => {
                setEditing(null);
                setTitle("");
                setNote("");
                setStartsAt("");
                setEndsAt("");
              }}>
                取消编辑
              </Button>
            )}
          </div>

          <h3 className="ui-card__title">预约</h3>
          {bookings.length === 0 ? <p className="ui-card__description">还没有预约。</p> : (
            <ul className="seat-list">
              {bookings.map((booking) => (
                <li key={booking.id} data-testid="resource-booking-row">
                  <strong>{booking.resourceName}</strong> · {booking.title} · {formatWindow(booking)} · {STATUS_LABELS[booking.status]}
                  {booking.cancelReason === undefined ? null : <span> · 原因：{booking.cancelReason}</span>}
                  {booking.status === "cancelled" ? null : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setEditing(booking);
                        setTitle(booking.title);
                        setNote(booking.note);
                        setStartsAt(toLocalInput(booking.startsAt));
                        setEndsAt(toLocalInput(booking.endsAt));
                      }}
                    >
                      编辑
                    </Button>
                  )}
                  {booking.status === "draft" ? (
                    <Button variant="secondary" size="sm" onClick={() => confirm.mutate(booking)} disabled={confirm.isPending}>
                      确认
                    </Button>
                  ) : null}
                  {booking.status === "cancelled" ? null : (
                    <>
                      <Input label="取消原因" value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} maxLength={1000} />
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => cancel.mutate(booking)}
                        disabled={cancel.isPending || cancelReason.trim() === ""}
                      >
                        取消
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}
    </Card>
  );
}
