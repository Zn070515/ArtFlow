import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { fetchPublicEvents, type PublicEventSummary } from "../api/publicEvent.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { Input } from "../components/ui/Input.js";

function formatEventDate(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatRange(event: PublicEventSummary): string {
  const start = formatEventDate(event.startsAt);
  const end = formatEventDate(event.endsAt);
  if (start === "") return end;
  return end === "" ? start : `${start} – ${end}`;
}

function matches(event: PublicEventSummary, needle: string): boolean {
  if (needle === "") return true;
  return [event.title, event.tagline, event.venue, event.organizer]
    .some((value) => value.toLocaleLowerCase("zh-CN").includes(needle));
}

export function EventsPage() {
  const [query, setQuery] = useState("");
  const events = useQuery({
    queryKey: ["public-events"],
    queryFn: ({ signal }) => fetchPublicEvents(signal),
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    document.title = "活动目录 · ArtFlow";
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return (events.data ?? []).filter((event) => matches(event, needle));
  }, [events.data, query]);

  return (
    <section className="events-page">
      <header className="events-header">
        <p className="eyebrow">EVENTS · 活动目录</p>
        <h1 className="display events-title">找到下一场活动。</h1>
        <p className="lede">
          公开活动由主办方选择列入目录；进入活动主页查看节目、公告与赛果。
        </p>
      </header>
      <div className="events-search">
        <Input
          label="搜索活动"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按名称、地点或主办方搜索"
        />
      </div>
      {events.isPending ? <p className="ui-state__copy">正在加载活动…</p> : null}
      {events.error !== null ? (
        <ErrorState
          description="活动目录暂时无法加载。"
          onRetry={() => { void events.refetch(); }}
        />
      ) : null}
      {events.data !== undefined ? (
        filtered.length === 0 ? (
          <p className="ui-state__copy">
            {events.data.length === 0 ? "暂时没有公开活动。" : "没有匹配的活动。"}
          </p>
        ) : (
          <ul className="events-grid">
            {filtered.map((event) => (
              <li className="event-card" key={event.publicCode}>
                <div className="event-card__head">
                  <span className={`event-card__badge event-card__badge--${event.status}`}>
                    {event.status === "active" ? "进行中" : "已结束"}
                  </span>
                  {event.organizer === "" ? null : (
                    <span className="event-card__organizer">{event.organizer}</span>
                  )}
                </div>
                <h2 className="event-card__title">
                  <Link to="/e/$publicCode" params={{ publicCode: event.publicCode }}>
                    {event.title}
                  </Link>
                </h2>
                {event.tagline === "" ? null : (
                  <p className="event-card__tagline">{event.tagline}</p>
                )}
                <p className="event-card__meta">
                  {[formatRange(event), event.venue].filter(Boolean).join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
