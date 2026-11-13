import type { CSSProperties } from "react";

import type { PublicAward, PublicDecision, PublicResults } from "../../api/public-results.js";

export function formatReleasedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

function scoreText(decision: PublicDecision): string {
  return decision.unit === "percent" ? `${decision.score}%` : decision.score;
}

function supportsSiblingIndex(): boolean {
  return typeof CSS !== "undefined" && CSS.supports("animation-delay: calc(sibling-index() * 0.1s)");
}

function RankRow({
  decision,
  index,
  fallbackSiblingIndex,
}: {
  readonly decision: PublicDecision;
  readonly index: number;
  readonly fallbackSiblingIndex: boolean;
}) {
  const champion = decision.rank === 1;
  const style = fallbackSiblingIndex
    ? ({ "--sibling-index": index + 1 } as CSSProperties)
    : undefined;
  return (
    <li className={champion ? "rank-row is-champion" : "rank-row"} style={style}>
      <span className="rank-number" aria-hidden="true">
        {String(decision.rank).padStart(2, "0")}
      </span>
      <span className="rank-contestant">{decision.contestantName}</span>
      <span className="rank-score">{scoreText(decision)}</span>
      <span className="sr-only">
        第 {decision.rank} 名，{decision.contestantName}，
        {decision.unit === "percent" ? scoreText(decision) : `${decision.score} 分`}
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
          <span className="award-owner">{award.contestantName}</span>
        </li>
      ))}
    </ul>
  );
}

export function ResultsView({ data }: { readonly data: PublicResults }) {
  const fallbackSiblingIndex = !supportsSiblingIndex();
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
            {result.decisions.map((decision, index) => (
              <RankRow
                decision={decision}
                index={index}
                fallbackSiblingIndex={fallbackSiblingIndex}
                key={`${decision.rank}-${decision.contestantId}`}
              />
            ))}
          </ol>
          <AwardChips awards={result.awards} />
        </section>
      ))}
    </article>
  );
}
