import type { MyEvent } from "../../api/me.js";

export function MeResults({ event }: { readonly event: MyEvent }) {
  return (
    <section className="me-detail__section">
      <h2>我的赛果</h2>
      {event.results.length === 0 ? (
        <p className="state-copy">赛果尚未发布</p>
      ) : (
        <ul className="me-results-list">
          {event.results.map((result) => (
            <li key={`${result.stageKey}-${result.releasedAt}`}>
              <span>{result.publicTitle}</span>
              <strong>第 {result.rank} 名</strong>
              <span>{result.unit === "percent" ? `${result.score}%` : result.score}</span>
              {result.awards.length === 0 ? null : <span>{result.awards.join(" / ")}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
