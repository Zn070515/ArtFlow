import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { fetchMyCenter } from "../api/me.js";
import { RequireSession } from "../auth/RequireSession.js";
import { ACTIVITY_STATUS_LABELS, label, REGISTRATION_STATUS_LABELS } from "../components/format/labels.js";
import { MeMaterialList } from "../components/me/MeMaterialList.js";
import { MeResults } from "../components/me/MeResults.js";
import { MeSchedule } from "../components/me/MeSchedule.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";

export function MeEventPage() {
  return (
    <RequireSession>
      <MeEventContent />
    </RequireSession>
  );
}

function MeEventContent() {
  const { publicCode } = useParams({ from: "/me/$publicCode" });
  const query = useQuery({
    queryKey: ["my-center"],
    queryFn: ({ signal }) => fetchMyCenter(signal),
    staleTime: 0,
    retry: false,
  });
  const event = query.data?.events.find((item) => item.activity.publicCode === publicCode);
  useEffect(() => {
    document.title = event === undefined ? "我的 · ArtFlow" : `${event.activity.title} · 我的`;
  }, [event]);
  if (query.isPending) return <p className="me-state">正在加载…</p>;
  if (query.error !== null) {
    return <ErrorState description="活动暂时无法加载。" onRetry={() => void query.refetch()} />;
  }
  if (event === undefined) {
    return (
      <EmptyState
        title="没有找到这场活动的报名"
        description="请确认活动公开码，或从「我的」列表进入。"
        action={<Link className="ui-button ui-button--secondary ui-button--md" to="/me">返回我的</Link>}
      />
    );
  }
  return (
    <section className="me-page">
      <header className="me-header">
        <div>
          <Link to="/me" className="table-link">← 返回我的</Link>
          <h1 className="ui-page-title">{event.activity.title}</h1>
          <p className="ui-page-meta">
            {label(ACTIVITY_STATUS_LABELS, event.activity.status)} · 报名{" "}
            {label(REGISTRATION_STATUS_LABELS, event.registration.status)}
            {event.activity.venue ? ` · ${event.activity.venue}` : ""}
          </p>
        </div>
        {event.links.event === null ? null : (
          <a className="ui-button ui-button--secondary ui-button--md" href={event.links.event}>
            公开活动页
          </a>
        )}
      </header>
      <div className="me-detail">
        <section className="me-detail__section">
          <h2>报名</h2>
          <p>状态：{label(REGISTRATION_STATUS_LABELS, event.registration.status)}</p>
          {event.registration.reviewNote ? <p>审核备注：{event.registration.reviewNote}</p> : null}
          {event.registration.supplementKeys.length === 0 ? null : (
            <p>需要补交：{event.registration.supplementKeys.join("、")}</p>
          )}
          {event.links.edit === null ? null : (
            <a className="ui-button ui-button--primary ui-button--md" href={event.links.edit}>
              编辑报名 / 补充材料
            </a>
          )}
        </section>
        <MeMaterialList event={event} />
        <MeSchedule event={event} />
        <MeResults event={event} />
      </div>
    </section>
  );
}
