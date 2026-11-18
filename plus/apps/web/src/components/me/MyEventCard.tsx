import { Link } from "@tanstack/react-router";

import type { MyEvent } from "../../api/me.js";
import { ACTIVITY_STATUS_LABELS, label, REGISTRATION_STATUS_LABELS } from "../format/labels.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Card } from "../ui/Card.js";

function registrationTone(status: MyEvent["registration"]["status"]): BadgeTone {
  if (status === "approved") return "success";
  if (status === "need_supplement") return "warning";
  if (status === "rejected") return "danger";
  if (status === "submitted") return "info";
  return "neutral";
}

export function MyEventCard({ event }: { readonly event: MyEvent }) {
  const code = event.activity.publicCode;
  const total = event.materials.length;
  const approved = event.materials.filter((material) => material.status === "approved").length;
  const needsSupplement = event.materials.some((material) => material.status === "needs_supplement");
  return (
    <Card className="me-event-card">
      <header className="me-event-card__head">
        <div>
          <h2 className="ui-card__title">
            <Link to="/me/$publicCode" params={{ publicCode: code }}>{event.activity.title}</Link>
          </h2>
          <p className="ui-card__description">
            {label(ACTIVITY_STATUS_LABELS, event.activity.status)} ·{" "}
            {label(REGISTRATION_STATUS_LABELS, event.registration.status)} · 更新{" "}
            {new Date(event.registration.updatedAt).toLocaleString("zh-CN")}
          </p>
        </div>
        <Badge tone={registrationTone(event.registration.status)}>
          {label(REGISTRATION_STATUS_LABELS, event.registration.status)}
        </Badge>
      </header>
      {event.registration.reviewNote ? (
        <p className="me-event-card__note">审核备注：{event.registration.reviewNote}</p>
      ) : null}
      <p className="ui-card__description">
        材料 {approved}/{total}{needsSupplement ? " · 有材料需要补交" : ""}
      </p>
      {event.schedule.length === 0 ? null : (
        <ul className="me-event-card__mini" aria-label="我的赛程">
          {event.schedule.slice(0, 3).map((entry) => (
            <li key={`${entry.order}-${entry.title}`}>
              {entry.slotLabel} · {entry.title}
            </li>
          ))}
        </ul>
      )}
      {event.results.length === 0 ? null : (
        <ul className="me-event-card__mini" aria-label="我的赛果">
          {event.results.slice(0, 2).map((result) => (
            <li key={`${result.stageKey}-${result.releasedAt}`}>
              {result.publicTitle} · 第 {result.rank} 名
              {result.awards.length === 0 ? "" : ` · ${result.awards.join(" / ")}`}
            </li>
          ))}
        </ul>
      )}
      <footer className="me-event-card__actions">
        <Link className="ui-button ui-button--primary ui-button--md" to="/me/$publicCode" params={{ publicCode: code }}>
          查看详情
        </Link>
        {event.links.event === null ? null : (
          <a className="ui-button ui-button--secondary ui-button--md" href={event.links.event}>查看活动</a>
        )}
        {event.links.edit === null ? null : (
          <a className="ui-button ui-button--secondary ui-button--md" href={event.links.edit}>编辑报名 / 补充材料</a>
        )}
        {event.archived ? <Badge tone="neutral">已归档</Badge> : null}
      </footer>
    </Card>
  );
}
