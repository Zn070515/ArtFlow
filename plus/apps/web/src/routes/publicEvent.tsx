import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { fetchPublicEvent, PublicEventNotFound } from "../api/publicEvent.js";
import { fetchPublicCurrent, fetchPublicVoteEntry } from "../api/tickets-public.js";
import { EventAbout } from "../components/portal/EventAbout.js";
import { EventLive } from "../components/portal/EventLive.js";
import { EventHero } from "../components/portal/EventHero.js";
import { EventProgram } from "../components/portal/EventProgram.js";
import { EventResults } from "../components/portal/EventResults.js";
import { EventShare } from "../components/portal/EventShare.js";

export function PublicEventPage() {
  const { publicCode } = useParams({ from: "/e/$publicCode" });
  const query = useQuery({
    queryKey: ["public-event", publicCode],
    queryFn: ({ signal }) => fetchPublicEvent(publicCode, signal),
    retry: false,
    staleTime: 60_000,
  });
  const current = useQuery({
    queryKey: ["public-current", publicCode],
    queryFn: ({ signal }) => fetchPublicCurrent(publicCode, signal),
    enabled: query.data?.activity.status === "active",
    refetchInterval: 30_000,
    retry: false,
  });
  const vote = useQuery({
    queryKey: ["public-vote-entry", publicCode],
    queryFn: ({ signal }) => fetchPublicVoteEntry(publicCode, signal),
    enabled: query.data?.activity.status === "active",
    refetchInterval: 30_000,
    retry: false,
  });

  useEffect(() => {
    document.title =
      query.data === undefined ? `活动 · ${publicCode}` : `${query.data.activity.title} · 活动主页`;
    if (query.data === undefined) return;
    const meta = document.querySelector('meta[name="description"]')
      ?? (() => {
        const element = document.createElement("meta");
        element.setAttribute("name", "description");
        document.head.appendChild(element);
        return element;
      })();
    meta.setAttribute("content", query.data.profile.description.slice(0, 160));
  }, [publicCode, query.data]);

  if (query.isPending) return <p className="event-state">正在加载活动…</p>;
  if (query.error instanceof PublicEventNotFound) {
    return (
      <section className="event-state">
        <p className="eyebrow">EVENT</p>
        <h1 className="event-state__title">活动不存在或尚未公开</h1>
        <p className="event-state__copy">请确认公开码，或联系活动主办方。</p>
      </section>
    );
  }
  if (query.error !== null) {
    return (
      <section className="event-state">
        <h1 className="event-state__title">活动暂时无法加载</h1>
        <button
          type="button"
          className="event-button event-button--primary"
          onClick={() => void query.refetch()}
        >
          重试
        </button>
      </section>
    );
  }
  const site = query.data;
  if (site === undefined) return null;
  const hasAbout = site.profile.description.trim() !== "";
  const hasProgram = site.schedule !== null
    || (site.program !== null && site.program.entries.length > 0);
  const hasResults = site.results !== null && site.results.results.length > 0;
  const hasLive = site.activity.status === "active" &&
    (current.data?.current != null ||
      (current.data?.next.length ?? 0) > 0 ||
      vote.data != null);
  return (
    <article className="event-page">
      <EventHero
        publicCode={site.activity.publicCode}
        title={site.activity.title}
        status={site.activity.status}
        tagline={site.profile.tagline}
        startsAt={site.profile.startsAt}
        endsAt={site.profile.endsAt}
        venue={site.profile.venue}
        organizer={site.profile.organizer}
        registrationEnabled={site.activity.registrationEnabled}
        registrationOpen={site.activity.registrationOpen}
        resultsAvailable={hasResults}
      />
      {site.profile.announcement.trim() === "" ? null : (
        <p className="event-announcement" role="note">
          {site.profile.announcement}
        </p>
      )}
      <nav className="event-anchor-nav" aria-label="活动导航">
        {hasAbout ? <a href="#about">概览</a> : null}
        {hasLive ? <a href="#live">现场</a> : null}
        {hasProgram ? <a href="#program">节目单</a> : null}
        {hasResults ? <a href="#results">赛果</a> : null}
      </nav>
      <EventLive current={current.data} vote={vote.data} />
      <EventAbout description={site.profile.description} />
      <EventProgram site={site} />
      <EventResults site={site} />
      <footer className="event-footer">
        <span>{site.profile.organizer || "主办方"}</span>
        {site.profile.contact === "" ? null : <span>{site.profile.contact}</span>}
        <span>公开码 {site.activity.publicCode}</span>
        <EventShare title={site.activity.title} publicCode={site.activity.publicCode} />
      </footer>
    </article>
  );
}
