import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { fetchPublicEvent } from "../api/publicEvent.js";
import { fetchPublicCurrent } from "../api/tickets-public.js";

function programRows(program: readonly { order: number; name: string; song: string; note: string }[]) {
  return program.map((entry) => (
    <li key={`program-${entry.order}-${entry.name}`}>
      <strong>{entry.order}</strong> {entry.name}
      {entry.song === "" ? null : <span> · {entry.song}</span>}
      {entry.note === "" ? null : <span> · {entry.note}</span>}
    </li>
  ));
}

export function HostCardPage() {
  const { publicCode } = useParams({ from: "/host-card/$publicCode" });
  const site = useQuery({
    queryKey: ["host-card", publicCode],
    queryFn: ({ signal }) => fetchPublicEvent(publicCode, signal),
    refetchInterval: 60_000,
    retry: false,
  });
  const current = useQuery({
    queryKey: ["host-card-current", publicCode],
    queryFn: ({ signal }) => fetchPublicCurrent(publicCode, signal),
    refetchInterval: 15_000,
    retry: false,
  });

  useEffect(() => {
    document.title = site.data === undefined ? "主持手卡 · ArtFlow" : `${site.data.activity.title} · 主持手卡`;
  }, [site.data]);

  const siteData = site.data;
  const schedule = siteData?.schedule?.entries ?? [];
  const program = siteData?.program?.entries ?? [];
  const results = siteData?.results?.results ?? [];
  const now = current.data?.current ?? null;
  const next = current.data?.next ?? [];

  return (
    <main className="host-card">
      <header className="host-card__header">
        <p className="eyebrow">ARTFLOW · HOST CARD</p>
        <h1>{siteData?.activity.title ?? publicCode}</h1>
        <p>
          {[siteData?.profile.venue, siteData?.profile.startsAt].filter((value) => value !== undefined && value !== "").join(" · ")}
        </p>
        <button type="button" className="ui-button ui-button--secondary no-print" onClick={() => window.print()}>
          打印手卡
        </button>
      </header>

      <section className="host-card__section">
        <h2>当前</h2>
        <p className="host-card__now">{now?.title ?? "等待开始"}</p>
        <p>{[now?.slotLabel, now?.note].filter((value) => value !== undefined && value !== "").join(" · ")}</p>
      </section>

      <section className="host-card__section">
        <h2>下一个</h2>
        {next.length === 0 ? <p>暂无后续节目</p> : (
          <ol>
            {next.slice(0, 5).map((entry) => (
              <li key={`${entry.order}-${entry.title}`}>
                <strong>{entry.slotLabel}</strong> {entry.title}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="host-card__section host-card__break">
        <h2>流程 / 节目单</h2>
        {schedule.length === 0 && program.length === 0 ? <p>节目单尚未发布</p> : (
          <ol>
            {schedule.map((entry) => (
              <li key={`slot-${entry.order}-${entry.title}`}>
                <strong>{entry.slotLabel}</strong> {entry.title}
                {entry.note === "" ? null : <span> · {entry.note}</span>}
              </li>
            ))}
            {programRows(program)}
          </ol>
        )}
      </section>

      <section className="host-card__section host-card__break">
        <h2>正式赛果</h2>
        {results.length === 0 ? <p>正式赛果尚未发布</p> : results.map((result) => (
          <article key={`${result.stageKey}-${result.releasedAt}`} className="host-card__result">
            <h3>{result.publicTitle}</h3>
            <ol>
              {result.decisions.map((decision) => (
                <li key={`${decision.rank}-${decision.contestantName}`}>
                  <span>{decision.rank}.</span> <strong>{decision.contestantName}</strong>
                  <span> {decision.unit === "percent" ? `${decision.score}%` : decision.score}</span>
                </li>
              ))}
            </ol>
            {result.awards.length === 0 ? null : (
              <p>{result.awards.map((award) => `${award.award}：${award.contestantName}`).join(" · ")}</p>
            )}
          </article>
        ))}
      </section>

      <section className="host-card__section host-card__break">
        <h2>公告</h2>
        {siteData?.profile.announcement === undefined || siteData.profile.announcement === "" ? (
          <p>暂无公告</p>
        ) : <p>{siteData.profile.announcement}</p>}
      </section>
    </main>
  );
}
