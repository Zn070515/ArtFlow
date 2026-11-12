import type { AttendanceRow } from "@artflow-plus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  addAttendanceStaff,
  checkInAttendance,
  createAttendancePoint,
  fetchAttendance,
  undoAttendance,
} from "../../api/attendance.js";
import { ApiError } from "../../api/client.js";
import { closeExecution, fetchExecutions, startExecution } from "../../api/voting.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";

type AttendanceTab = "participant" | "ticket" | "staff";

function tabLabel(tab: AttendanceTab): string {
  return { participant: "参赛者", ticket: "票据", staff: "工作人员" }[tab];
}

function statusLabel(status: AttendanceRow["status"]): string {
  return { present: "已到", undone: "已撤销", not_checked_in: "未到" }[status];
}

const STATUS_TONES: Readonly<Record<AttendanceRow["status"], BadgeTone>> = {
  present: "success",
  undone: "warning",
  not_checked_in: "neutral",
};

function humanError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "该主体已被其他操作员更新，请刷新后重试。";
  }
  return error instanceof Error ? error.message : "签到操作失败，请稍后重试。";
}

export function AttendanceCard({
  activityId,
  canManage,
  canManageSession,
}: {
  readonly activityId: string;
  readonly canManage: boolean;
  readonly canManageSession: boolean;
}) {
  const queryClient = useQueryClient();
  const [point, setPoint] = useState("");
  const [tab, setTab] = useState<AttendanceTab>("participant");
  const [search, setSearch] = useState("");
  const [note, setNote] = useState("");
  // Rehearsal has no attendance partition; default to the test partition so a
  // casual click cannot write formal attendance. The organizer must choose
  // formal explicitly.
  const [sessionMode, setSessionMode] = useState<"formal" | "test">("test");
  const [pointKey, setPointKey] = useState("");
  const [pointName, setPointName] = useState("");
  const [staffName, setStaffName] = useState("");
  const [ticketCredential, setTicketCredential] = useState("");
  const [ticketPoint, setTicketPoint] = useState("");

  const executions = useQuery({
    queryKey: ["attendance-executions", activityId],
    queryFn: () => fetchExecutions(activityId),
    enabled: canManageSession,
    retry: false,
  });
  const session = executions.data?.find(
    (item) => item.scope === "checkin" && item.status === "running",
  );
  const mode = session?.mode === "formal" ? "formal" : "test";

  const attendance = useQuery({
    queryKey: ["ops-attendance", activityId, point, tab, search, mode],
    queryFn: () => fetchAttendance(activityId, { point, subjectType: tab, query: search, mode }),
    retry: false,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["ops-attendance", activityId] });
    void queryClient.invalidateQueries({ queryKey: ["attendance-executions", activityId] });
  };

  const mutation = useMutation({
    mutationFn: ({ row, action }: { readonly row: AttendanceRow; readonly action: "checkin" | "undo" }) =>
      action === "checkin"
        ? checkInAttendance(activityId, row.subjectType === "ticket"
            ? {
                pointKey: row.pointKey,
                subjectType: "ticket",
                ticketId: row.subjectId,
                ...(note.trim() === "" ? {} : { note: note.trim() }),
              }
            : {
                pointKey: row.pointKey,
                subjectType: row.subjectType,
                subjectId: row.subjectId,
                ...(note.trim() === "" ? {} : { note: note.trim() }),
              })
        : undoAttendance(activityId, {
            pointKey: row.pointKey,
            subjectType: row.subjectType,
            subjectId: row.subjectId,
            ...(note.trim() === "" ? {} : { note: note.trim() }),
          }),
    onSuccess: () => {
      setNote("");
      refresh();
    },
  });

  const sessionMutation = useMutation({
    mutationFn: async (action: "open" | "close") => {
      if (action === "open") return startExecution(activityId, "checkin", sessionMode);
      if (session === undefined) throw new Error("没有运行中的签到 session。");
      return closeExecution(activityId, session.id, session.revision);
    },
    onSuccess: refresh,
  });

  const pointMutation = useMutation({
    mutationFn: () => createAttendancePoint(activityId, {
      key: pointKey,
      name: pointName,
      subjectTypes: ["participant", "ticket", "staff"],
    }),
    onSuccess: () => {
      setPointKey("");
      setPointName("");
      refresh();
    },
  });

  const staffMutation = useMutation({
    mutationFn: () => addAttendanceStaff(activityId, { displayName: staffName }),
    onSuccess: () => {
      setStaffName("");
      refresh();
    },
  });

  const ticketMutation = useMutation({
    mutationFn: () => checkInAttendance(activityId, {
      pointKey: ticketPoint !== "" ? ticketPoint : point,
      subjectType: "ticket",
      credential: ticketCredential.trim(),
      ...(note.trim() === "" ? {} : { note: note.trim() }),
    }),
    onSuccess: () => {
      setTicketCredential("");
      setNote("");
      refresh();
    },
  });

  if (attendance.isPending) {
    return (
      <Card className="attendance-card">
        <p className="auth-loading">正在加载签到…</p>
      </Card>
    );
  }
  if (attendance.error !== null && attendance.error !== undefined) {
    return (
      <Card className="attendance-card">
        <p className="ui-field__error" role="alert">{humanError(attendance.error)}</p>
      </Card>
    );
  }

  const data = attendance.data;
  const rows = data.rows.filter((row) => row.subjectType === tab);
  const summary = data.summary.find((item) => item.subjectType === tab);

  return (
    <Card className="attendance-card" data-testid="attendance-card">
      <div className="tasks-card-header">
        <div>
          <h2 className="ui-card__title">签到</h2>
        </div>
        {session !== undefined ? <span className="ui-card__description">签到已开放（{session.mode === "formal" ? "正式" : "测试"}）</span> : null}
      </div>

      {canManageSession ? (
        <div className="attendance-session" data-testid="attendance-session">
          <select
            className="ui-select"
            aria-label="签到分区"
            value={sessionMode}
            onChange={(event) => setSessionMode(event.target.value as "formal" | "test")}
            disabled={session !== undefined}
          >
            <option value="formal">正式</option>
            <option value="test">测试</option>
          </select>
          <p className="ui-card__description">彩排不写入签到；正式签到请显式选择“正式”。</p>
          {session === undefined ? (
            <Button variant="primary" size="sm" onClick={() => sessionMutation.mutate("open")} disabled={sessionMutation.isPending}>
              打开签到
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => sessionMutation.mutate("close")} disabled={sessionMutation.isPending}>
              关闭签到
            </Button>
          )}
        </div>
      ) : null}

      {canManage ? (
        <div className="attendance-management" data-testid="attendance-management">
          <Input label="签到点 key" value={pointKey} onChange={(event) => setPointKey(event.target.value)} placeholder="key（小写）" />
          <Input label="签到点名称" value={pointName} onChange={(event) => setPointName(event.target.value)} placeholder="签到点名称" />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => pointMutation.mutate()}
            disabled={pointKey === "" || pointName === "" || pointMutation.isPending}
          >
            新增签到点
          </Button>
          <Input label="工作人员姓名" value={staffName} onChange={(event) => setStaffName(event.target.value)} placeholder="工作人员姓名" />
          <Button variant="secondary" size="sm" onClick={() => staffMutation.mutate()} disabled={staffName === "" || staffMutation.isPending}>
            添加工作人员
          </Button>
        </div>
      ) : null}

      <div role="tablist" className="attendance-tabs">
        {(["participant", "ticket", "staff"] as const).map((item) => (
          <Button
            key={item}
            role="tab"
            aria-selected={tab === item}
            variant="ghost"
            size="sm"
            onClick={() => setTab(item)}
          >
            {tabLabel(item)}
          </Button>
        ))}
      </div>

      <div className="attendance-filters">
        <Select label="签到点" value={point} onChange={(event) => setPoint(event.target.value)}>
          <option value="">全部</option>
          {data.points.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
        </Select>
        <Input label="搜索" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索姓名 / 票据码" />
        <Input label="备注" value={note} onChange={(event) => setNote(event.target.value)} placeholder="备注（可选）" maxLength={500} />
      </div>

      {summary !== undefined ? (
        <p className="attendance-summary">
          应到 {summary.expected} · 已到 {summary.present} · 已撤销 {summary.undone}
        </p>
      ) : null}

      {tab === "ticket" && canManage ? (
        <div className="attendance-ticket-credential">
          <Select label="票据签到点" value={ticketPoint} onChange={(event) => setTicketPoint(event.target.value)}>
            <option value="">使用当前签到点</option>
            {data.points.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
          </Select>
          <Input
            label="票据 credential"
            value={ticketCredential}
            onChange={(event) => setTicketCredential(event.target.value)}
            placeholder="粘贴票据 credential"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => ticketMutation.mutate()}
            disabled={ticketCredential.trim() === "" || (ticketPoint === "" && point === "") || ticketMutation.isPending}
          >
            按凭证签到
          </Button>
        </div>
      ) : null}

      <ul className="attendance-rows">
        {rows.map((row) => (
          <li key={`${row.pointKey}:${row.subjectType}:${row.subjectId}`}>
            <span>{row.label}</span>
            <Badge tone={STATUS_TONES[row.status]}>{statusLabel(row.status)}</Badge>
            {!row.eligible ? <span className="attendance-ineligible">已不可签到</span> : null}
            {row.eligible && canManage && row.status !== "present" ? (
              <Button variant="primary" size="sm" onClick={() => mutation.mutate({ row, action: "checkin" })} disabled={mutation.isPending}>
                签到
              </Button>
            ) : null}
            {row.eligible && canManage && row.status === "present" ? (
              <Button variant="secondary" size="sm" onClick={() => mutation.mutate({ row, action: "undo" })} disabled={mutation.isPending}>
                撤销
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {rows.length === 0 ? <p className="auth-loading">当前筛选下没有主体。</p> : null}
      {mutation.error !== null && mutation.error !== undefined ? <p className="ui-field__error" role="alert">{humanError(mutation.error)}</p> : null}
      {sessionMutation.error !== null && sessionMutation.error !== undefined ? <p className="ui-field__error" role="alert">{humanError(sessionMutation.error)}</p> : null}
    </Card>
  );
}
