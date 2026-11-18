import { useEffect, useState } from "react";

import type { PublicScheduleEntry } from "../../api/tickets-public.js";
import { formatFreshness } from "./onsiteActions.js";

export interface NowNextCardProps {
  readonly current: PublicScheduleEntry;
  readonly next: readonly PublicScheduleEntry[];
  readonly total: number | null;
  readonly updatedAt: number | undefined;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}

export function NowNextCard(props: NowNextCardProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const position = String(props.current.order).padStart(2, "0");
  const total = props.total !== null && props.total > 0 ? ` / ${props.total}` : "";
  const freshness = formatFreshness(props.updatedAt, now);
  const upcoming = props.next.slice(0, 2);
  return (
    <section className="event-now" id="live" aria-labelledby="event-now-label">
      <div className="event-now__head">
        <p className="eyebrow" id="event-now-label">NOW · 现场</p>
        {freshness === "" ? null : <span className="event-now__freshness">{freshness}</span>}
      </div>
      <p className="event-now__position">NOW · {position}{total}</p>
      <p className="event-now__name" aria-live="polite">{props.current.title}</p>
      {props.current.slotLabel === "" ? null : (
        <p className="event-now__song">{props.current.slotLabel}</p>
      )}
      {upcoming.length === 0 ? null : (
        <p className="event-now__next">
          下一个：{upcoming.map((entry) => entry.title).join(" · ")}
        </p>
      )}
      <button
        type="button"
        className="event-button event-button--ghost event-now__refresh"
        onClick={props.onRefresh}
        disabled={props.refreshing}
      >
        {props.refreshing ? "刷新中…" : "刷新"}
      </button>
    </section>
  );
}
