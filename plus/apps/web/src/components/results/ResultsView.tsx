import type { PublicAward, PublicDecision, PublicResults } from "../../api/public-results.js";

export function formatReleasedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

function RankRow({ decision }: { readonly decision: PublicDecision }) {
  const champion = decision.rank === 1;
  return (
    <li className={champion ? "rank-row is-champion" : "rank-row"}>
      <span className="rank-number" aria-hidden="true">
        {String(decision.rank).padStart(2, "0")}
      </span>
      <span className="rank-contestant">{decision.contestantId}</span>
      <span className="rank-score">{decision.score}</span>
      <span className="sr-only">
        第 {decision.rank} 名，{decision.contestantId}，{decision.score} 分
      </span>
    </li>
  );
}

function AwardChips({ awards }: { readonly awards: readonly PublicAward[] }) {
  if (awards.length === 0) return null;
  return (
    <ul className="award-list" aria-label="奖项">
      {awards.map((award) => (
        <li className="award-chip" key={`${award.award}-${award.contestantId}`}>
          <span className="award-name">{award.award}</span>
          <span className="award-owner">{award.contestantId}</span>
        </li>
      ))}
    </ul>
  );
}

export function ResultsView({ data }: { readonly data: PublicResults }) {
  return (
    <article className="results">
      <header className="results-hero">
        <p className="eyebrow">OFFICIAL RESULTS · 正式赛果</p>
        <h1 className="display results-title">{data.activityTitle}</h1>
      </header>
      {data.results.map((result) => (
        <section className="result-stage" key={result.releaseId}>
          <div className="stage-head">
            <h2>{result.publicTitle}</h2>
            <time dateTime={result.releasedAt}>{formatReleasedAt(result.releasedAt)}</time>
          </div>
          <ol className="rank-list">
            {result.decisions.map((decision) => (
              <RankRow decision={decision} key={`${decision.rank}-${decision.contestantId}`} />
            ))}
          </ol>
          <AwardChips awards={result.awards} />
        </section>
      ))}
    </article>
  );
}
