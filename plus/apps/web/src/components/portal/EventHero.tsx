import { Link } from "@tanstack/react-router";

export function formatEventTime(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "long", timeStyle: "short" }).format(date);
}

export interface EventHeroProps {
  readonly publicCode: string;
  readonly title: string;
  readonly status: "active" | "closed";
  readonly tagline: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly venue: string;
  readonly organizer: string;
  readonly registrationEnabled: boolean;
  readonly registrationOpen: boolean;
  readonly resultsAvailable: boolean;
  readonly preview?: boolean;
  readonly compact?: boolean;
}

export function EventHero(props: EventHeroProps) {
  const time = [formatEventTime(props.startsAt), formatEventTime(props.endsAt)]
    .filter(Boolean)
    .join(" – ");
  const meta = [time, props.venue, props.organizer].filter(Boolean);
  if (props.compact === true) {
    return (
      <header className="event-hero event-hero--compact">
        <p className="eyebrow">LIVE · 进行中</p>
        <h1 className="event-hero__title">{props.title}</h1>
        {meta.length === 0 ? null : <p className="event-hero__meta">{meta.join(" · ")}</p>}
      </header>
    );
  }
  const showResults = props.status === "closed" && props.resultsAvailable && props.preview !== true;
  const showJoin = props.status !== "closed" && props.registrationOpen && props.preview !== true;
  const mutedLabel = props.status === "closed"
    ? null
    : props.registrationOpen
      ? null
      : props.registrationEnabled
        ? "报名已截止"
        : "本活动无需报名";
  const showMuted = props.preview !== true && mutedLabel !== null;
  return (
    <header className="event-hero">
      <p className="eyebrow">EVENT · {props.status === "closed" ? "已结束" : "活动"}</p>
      <h1 className="event-hero__title">{props.title}</h1>
      {props.tagline === "" ? null : <p className="event-hero__tagline">{props.tagline}</p>}
      {meta.length === 0 ? null : <p className="event-hero__meta">{meta.join(" · ")}</p>}
      <div className="event-hero__actions">
        {showResults ? (
          <Link
            className="event-button event-button--primary"
            to="/results/$publicCode"
            params={{ publicCode: props.publicCode }}
          >
            查看赛果
          </Link>
        ) : null}
        {showJoin ? (
          <Link
            className="event-button event-button--primary"
            to="/join/$publicCode"
            params={{ publicCode: props.publicCode }}
          >
            立即报名
          </Link>
        ) : null}
        {showMuted ? (
          <span className="event-button event-button--muted">{mutedLabel}</span>
        ) : null}
      </div>
    </header>
  );
}
