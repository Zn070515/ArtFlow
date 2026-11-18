import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { ApiError } from "../api/client.js";
import { fetchPublicEvent, PublicEventNotFound } from "../api/publicEvent.js";
import { fetchPublicCurrent } from "../api/tickets-public.js";

function formatEntry(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function EmbedPage() {
  const { publicCode } = useParams({ from: "/embed/$publicCode" });
  const siteQuery = useQuery({
    queryKey: ["embed-site", publicCode],
    queryFn: ({ signal }) => fetchPublicEvent(publicCode, signal),
    retry: false,
    staleTime: 60_000,
    refetchInterval: (query) =>
      query.state.error instanceof PublicEventNotFound ? false : 60_000,
  });
  const siteStatus = siteQuery.data?.activity.status;
  const currentQuery = useQuery({
    queryKey: ["embed-current", publicCode],
    queryFn: ({ signal }) => fetchPublicCurrent(publicCode, signal),
    enabled: siteStatus === "active",
    refetchInterval: (query) =>
      query.state.error instanceof ApiError && query.state.error.status === 404 ? false : 15_000,
    staleTime: 10_000,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 1,
  });

  useEffect(() => {
    document.title = siteQuery.data === undefined
      ? `活动 · ${publicCode}`
      : `${siteQuery.data.activity.title} · 嵌入`;
  }, [publicCode, siteQuery.data]);

  if (siteQuery.isPending) {
    return <main className="embed-page"><p className="embed-page__state">正在加载活动…</p></main>;
  }
  if (siteQuery.error instanceof PublicEventNotFound) {
    return <main className="embed-page"><p className="embed-page__state">活动不存在或尚未公开。</p></main>;
  }
  if (siteQuery.error !== null || siteQuery.data === undefined) {
    return <main className="embed-page"><p className="embed-page__state">活动暂时无法加载。</p></main>;
  }

  const site = siteQuery.data;
  const current = currentQuery.data?.current ?? null;
  const next = currentQuery.data?.next ?? [];
  const sortedResults = site.results === null
    ? []
    : [...site.results.results].sort(
        (left, right) => right.releasedAt.localeCompare(left.releasedAt),
      );
  const latestResult = sortedResults[0] ?? null;
  const isActive = site.activity.status === "active";
  const status = isActive ? "进行中" : "已结束";
  const meta = [formatEntry(site.profile.startsAt), site.profile.venue]
    .filter((value) => value !== "")
    .join(" · ");

  const nowCard = isActive && current !== null
    ? (
      <section className="embed-now" aria-labelledby="embed-now-title">
        <p className="embed-page__eyebrow" id="embed-now-title">现在</p>
        <p className="embed-now__name">{current.title}</p>
        {current.slotLabel === "" ? null : <p className="embed-now__song">{current.slotLabel}</p>}
        {next.length === 0 ? null : (
          <p className="embed-now__next">
            下一个：{next.slice(0, 2).map((entry) => entry.title).join(" · ")}
          </p>
        )}
      </section>
    )
    : null;

  const idleCard = isActive && current === null
    ? (
      <section className="embed-now" aria-labelledby="embed-idle-title">
        <p className="embed-page__eyebrow" id="embed-idle-title">现场</p>
        <p className="embed-now__next">暂无进行中的节目。</p>
        {next.length === 0 ? null : (
          <ol className="embed-list">
            {next.slice(0, 3).map((entry) => (
              <li key={`${entry.order}-${entry.title}`}>
                <span>{entry.title}</span>
                <span>{entry.slotLabel}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    )
    : null;

  const resultsCard = latestResult === null
    ? null
    : (
      <section className="embed-results" aria-labelledby="embed-results-title">
        <p className="embed-page__eyebrow" id="embed-results-title">{latestResult.publicTitle}</p>
        <ol className="embed-list">
          {latestResult.decisions.slice(0, 3).map((decision) => (
            <li key={`${decision.rank}-${decision.contestantName}`}>
              <span>{String(decision.rank).padStart(2, "0")} {decision.contestantName}</span>
              <span>{decision.unit === "percent" ? `${decision.score}%` : decision.score}</span>
            </li>
          ))}
        </ol>
      </section>
    );

  return (
    <main className="embed-page">
      <header className="embed-page__head">
        <p className="embed-page__eyebrow">ARTFLOW · {status}</p>
        <h1 className="embed-page__title">{site.activity.title}</h1>
        {site.profile.tagline === "" ? null : (
          <p className="embed-page__tagline">{site.profile.tagline}</p>
        )}
        {meta === "" ? null : <p className="embed-page__meta">{meta}</p>}
      </header>
      {nowCard}
      {idleCard}
      {resultsCard}
      <a
        className="embed-page__link"
        href={`/e/${encodeURIComponent(site.activity.publicCode)}`}
        target="_top"
      >
        查看完整活动 →
      </a>
    </main>
  );
}
