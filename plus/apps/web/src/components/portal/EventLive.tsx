import type { PublicCurrentProgram, PublicVoteEntry } from "../../api/tickets-public.js";

export function EventLive({
  current,
  vote,
}: {
  readonly current: PublicCurrentProgram | undefined;
  readonly vote: PublicVoteEntry | undefined;
}) {
  const currentEntry = current?.current ?? null;
  const next = current?.next ?? [];
  if (currentEntry === null && next.length === 0 && (vote === null || vote === undefined)) {
    return null;
  }
  return (
    <section className="event-section event-live" id="live" aria-labelledby="event-live-title">
      <h2 className="event-section__title" id="event-live-title">现场</h2>
      {currentEntry === null ? null : (
        <p className="event-live__current">
          当前：{currentEntry.title} · {currentEntry.slotLabel}
        </p>
      )}
      {next.length === 0 ? null : (
        <p className="event-live__next">
          接下来：{next.slice(0, 3).map((entry) => entry.title).join(" · ")}
        </p>
      )}
      {vote === null || vote === undefined ? null : (
        <a className="event-button event-button--primary" href={`/vote/${encodeURIComponent(vote.sessionId)}`}>
          投票进行中 · 去投票
        </a>
      )}
    </section>
  );
}
