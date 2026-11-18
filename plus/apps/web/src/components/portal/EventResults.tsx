import { Link } from "@tanstack/react-router";

import type { PublicEventSite } from "../../api/publicEvent.js";

export function EventResults({ site }: { readonly site: PublicEventSite }) {
  const results = site.results;
  if (results === null || results.results.length === 0) return null;
  const latest = [...results.results].sort(
    (left, right) =>
      right.releasedAt.localeCompare(left.releasedAt) ||
      left.stageKey.localeCompare(right.stageKey),
  )[0];
  if (latest === undefined) return null;
  return (
    <section className="event-section" id="results" aria-labelledby="event-results-title">
      <div className="event-section__head">
        <h2 className="event-section__title" id="event-results-title">
          赛果
        </h2>
        <Link
          className="event-link"
          to="/results/$publicCode"
          params={{ publicCode: site.activity.publicCode }}
        >
          查看完整赛果 →
        </Link>
      </div>
      <p className="event-results__stage">{latest.publicTitle}</p>
      <ol className="event-results__list">
        {latest.decisions.slice(0, 3).map((decision) => (
          <li key={`${decision.rank}-${decision.contestantName}`}>
            <span className="event-results__rank">{String(decision.rank).padStart(2, "0")}</span>
            <span>{decision.contestantName}</span>
            <span className="event-results__score">
              {decision.unit === "percent" ? `${decision.score}%` : decision.score}
            </span>
          </li>
        ))}
      </ol>
      {latest.awards.length === 0 ? null : (
        <ul className="event-results__awards">
          {latest.awards.map((award) => (
            <li key={`${award.award}-${award.contestantName}`}>
              <span>{award.award}</span>
              <strong>{award.contestantName}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
