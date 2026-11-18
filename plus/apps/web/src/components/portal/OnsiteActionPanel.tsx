import { Link } from "@tanstack/react-router";

import { EventShare } from "./EventShare.js";

export interface OnsiteActionsProps {
  readonly primary: "vote" | "results" | "join" | null;
  readonly publicCode: string;
  readonly eventTitle: string;
  readonly voteSessionId: string | null;
  readonly hasProgram: boolean;
}

export function OnsiteActions(props: OnsiteActionsProps) {
  return (
    <section className="event-onsite-actions" aria-label="现场操作">
      {props.primary === "vote" && props.voteSessionId !== null ? (
        <a
          className="event-button event-button--primary"
          href={`/vote/${encodeURIComponent(props.voteSessionId)}`}
        >
          投票进行中 · 去投票
        </a>
      ) : null}
      {props.primary === "results" ? (
        <Link
          className="event-button event-button--primary"
          to="/results/$publicCode"
          params={{ publicCode: props.publicCode }}
        >
          查看赛果
        </Link>
      ) : null}
      {props.primary === "join" ? (
        <Link
          className="event-button event-button--primary"
          to="/join/$publicCode"
          params={{ publicCode: props.publicCode }}
        >
          立即报名
        </Link>
      ) : null}
      {props.hasProgram ? (
        <a className="event-button event-button--ghost" href="#program">节目单</a>
      ) : null}
      <EventShare title={props.eventTitle} publicCode={props.publicCode} />
    </section>
  );
}
