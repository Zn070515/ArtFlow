import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  acknowledgeIncident,
  fetchIncidents,
  openIncident,
  reopenIncident,
  resolveIncident,
  type IncidentCategory,
  type IncidentMode,
  type IncidentSeverity,
} from "../../api/incidents.js";
import { apiErrorText } from "../ui/apiError.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";
import { Textarea } from "../ui/Textarea.js";

const SEVERITY_LABELS: Readonly<Record<IncidentSeverity, string>> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "紧急",
};
const SEVERITY_TONES: Readonly<Record<IncidentSeverity, BadgeTone>> = {
  low: "neutral",
  medium: "info",
  high: "warning",
  critical: "danger",
};
const CATEGORY_LABELS: Readonly<Record<IncidentCategory, string>> = {
  participant: "参与者",
  judge: "评委",
  stage: "舞台",
  technical: "技术",
  safety: "安全",
  other: "其他",
};
const STATUS_LABELS = { open: "待处理", acknowledged: "处理中", resolved: "已解决" } as const;
const MODE_LABELS: Readonly<Record<IncidentMode, string>> = {
  test: "测试",
  rehearsal: "彩排",
  formal: "正式",
};

export function IncidentCard({
  activityId,
  canManage,
}: {
  readonly activityId: string;
  readonly canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<IncidentMode>("formal");
  const [severity, setSeverity] = useState<IncidentSeverity>("medium");
  const [category, setCategory] = useState<IncidentCategory>("stage");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [location, setLocation] = useState("");
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [reopeningId, setReopeningId] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const query = useQuery({
    queryKey: ["incidents", activityId, mode],
    queryFn: () => fetchIncidents(activityId, mode),
    retry: false,
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["incidents", activityId, mode] });
  };
  const open = useMutation({
    mutationFn: () => openIncident(activityId, { mode, severity, category, title, detail, location }),
    onSuccess: () => {
      setTitle("");
      setDetail("");
      setLocation("");
      refresh();
    },
  });
  const acknowledge = useMutation({
    mutationFn: (id: string) => acknowledgeIncident(activityId, id, query.data?.find((item) => item.id === id)?.revision ?? 0),
    onSuccess: refresh,
  });
  const resolve = useMutation({
    mutationFn: (item: { readonly id: string; readonly revision: number }) =>
      resolveIncident(activityId, item.id, item.revision, resolution),
    onSuccess: () => {
      setResolvingId(null);
      setResolution("");
      refresh();
    },
  });
  const reopen = useMutation({
    mutationFn: (item: { readonly id: string; readonly revision: number }) =>
      reopenIncident(activityId, item.id, item.revision, reason),
    onSuccess: () => {
      setReopeningId(null);
      setReason("");
      refresh();
    },
  });
  const incidents = query.data ?? [];
  const error = query.error ?? open.error ?? acknowledge.error ?? resolve.error ?? reopen.error;

  return (
    <Card className="incident-card" data-testid="incident-card">
      <div className="studio-card-head">
        <h2 className="ui-card__title">现场事故</h2>
        <Select label="事故模式" value={mode} onChange={(event) => setMode(event.target.value as IncidentMode)}>
          {(["test", "rehearsal", "formal"] as const).map((item) => (
            <option key={item} value={item}>{MODE_LABELS[item]}</option>
          ))}
        </Select>
      </div>
      {query.isPending ? <p className="auth-loading">正在加载事故…</p> : null}
      <ul className="seat-list" aria-label="事故列表">
        {incidents.map((incident) => (
          <li key={incident.id} data-testid="incident-row">
            <div>
              <Badge tone={SEVERITY_TONES[incident.severity]}>{SEVERITY_LABELS[incident.severity]}</Badge>{" "}
              <strong>{incident.title}</strong>{" "}
              <span className="state-copy">
                {CATEGORY_LABELS[incident.category]} · {STATUS_LABELS[incident.status]}
                {incident.location === "" ? "" : ` · ${incident.location}`}
              </span>
              {incident.detail === "" ? null : <p className="ui-card__description">{incident.detail}</p>}
              {incident.resolution === "" ? null : <p className="ui-card__description">处理：{incident.resolution}</p>}
            </div>
            {canManage ? (
              <div className="task-actions">
                {incident.status === "open" ? (
                  <Button variant="secondary" size="sm" disabled={acknowledge.isPending} onClick={() => acknowledge.mutate(incident.id)}>
                    确认
                  </Button>
                ) : null}
                {incident.status !== "resolved" ? (
                  <Button variant="primary" size="sm" onClick={() => setResolvingId(incident.id)}>
                    解决
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => setReopeningId(incident.id)}>
                    重开
                  </Button>
                )}
              </div>
            ) : null}
            {resolvingId === incident.id ? (
              <div className="editor-grid">
                <Textarea label="处理结果" rows={2} value={resolution} onChange={(event) => setResolution(event.target.value)} />
                <Button
                  variant="primary"
                  disabled={resolution.trim() === "" || resolve.isPending}
                  onClick={() => resolve.mutate({ id: incident.id, revision: incident.revision })}
                >
                  确认解决
                </Button>
              </div>
            ) : null}
            {reopeningId === incident.id ? (
              <div className="editor-grid">
                <Input label="重开原因" value={reason} onChange={(event) => setReason(event.target.value)} />
                <Button
                  variant="secondary"
                  disabled={reason.trim() === "" || reopen.isPending}
                  onClick={() => reopen.mutate({ id: incident.id, revision: incident.revision })}
                >
                  确认重开
                </Button>
              </div>
            ) : null}
          </li>
        ))}
        {incidents.length === 0 ? <li className="ui-card__description">当前没有事故记录。</li> : null}
      </ul>
      {canManage ? (
        <div className="editor-grid">
          <Input label="事故标题" value={title} onChange={(event) => setTitle(event.target.value)} />
          <div className="editor-row">
            <Select label="严重程度" value={severity} onChange={(event) => setSeverity(event.target.value as IncidentSeverity)}>
              {(["low", "medium", "high", "critical"] as const).map((item) => (
                <option key={item} value={item}>{SEVERITY_LABELS[item]}</option>
              ))}
            </Select>
            <Select label="分类" value={category} onChange={(event) => setCategory(event.target.value as IncidentCategory)}>
              {(["participant", "judge", "stage", "technical", "safety", "other"] as const).map((item) => (
                <option key={item} value={item}>{CATEGORY_LABELS[item]}</option>
              ))}
            </Select>
            <Input label="位置" value={location} onChange={(event) => setLocation(event.target.value)} />
          </div>
          <Textarea label="详细描述" rows={2} value={detail} onChange={(event) => setDetail(event.target.value)} />
          <Button variant="primary" disabled={title.trim() === "" || open.isPending} onClick={() => open.mutate()}>
            记录事故
          </Button>
        </div>
      ) : null}
      {error === null || error === undefined ? null : (
        <p className="ui-field__error" role="alert">
          {apiErrorText(error, "事故操作失败，请稍后重试。", "事故已更新，请刷新后重试。")}
        </p>
      )}
    </Card>
  );
}
