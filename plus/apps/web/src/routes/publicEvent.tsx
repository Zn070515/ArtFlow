import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ApiError } from "../api/client.js";
import { fetchPublicEvent, PublicEventNotFound } from "../api/publicEvent.js";
import { fetchPublicCurrent, fetchPublicVoteEntry } from "../api/tickets-public.js";
import { AnnouncementBanner } from "../components/portal/AnnouncementBanner.js";
import { EventAbout } from "../components/portal/EventAbout.js";
import {
  CalendarButton,
  EventAnnouncements,
  EventFaq,
  EventLinks,
  EventParticipants,
} from "../components/portal/EventContentBlocks.js";
import { EventHero } from "../components/portal/EventHero.js";
import { EventProgram } from "../components/portal/EventProgram.js";
import { EventResults } from "../components/portal/EventResults.js";
import { FeedbackForm } from "../components/portal/FeedbackForm.js";
import { NowNextCard } from "../components/portal/NowNextCard.js";
import { OnsiteActions } from "../components/portal/OnsiteActionPanel.js";
import { deriveOnsiteActions, matchCurrentProgramOrder } from "../components/portal/onsiteActions.js";
import { useOnlineStatus } from "../hooks/useOnlineStatus.js";

function setHeadMeta(key: string, content: string): void {
  const isProperty = key.startsWith("og:");
  const selector = isProperty ? `meta[property="${key}"]` : `meta[name="${key}"]`;
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (element === null) {
    element = document.createElement("meta");
    element.setAttribute(isProperty ? "property" : "name", key);
    document.head.appendChild(element);
  }
  element.setAttribute("content", content);
}

function setCanonical(url: string): void {
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (link === null) {
    link = document.createElement("link");
    link.setAttribute("rel", "canonical");
    document.head.appendChild(link);
  }
  link.setAttribute("href", url);
}

export function PublicEventPage() {
  const { publicCode } = useParams({ from: "/e/$publicCode" });
  const online = useOnlineStatus();
  const [refreshing, setRefreshing] = useState(false);

  const siteQuery = useQuery({
    queryKey: ["public-event", publicCode],
    queryFn: ({ signal }) => fetchPublicEvent(publicCode, signal),
    retry: false,
    staleTime: 60_000,
    refetchInterval: (query) =>
      query.state.error instanceof PublicEventNotFound ? false : 60_000,
  });
  const siteStatus = siteQuery.data?.activity.status;
  const currentQuery = useQuery({
    queryKey: ["public-current", publicCode],
    queryFn: ({ signal }) => fetchPublicCurrent(publicCode, signal),
    enabled: siteStatus === "active",
    refetchInterval: (query) =>
      query.state.error instanceof ApiError && query.state.error.status === 404 ? false : 15_000,
    staleTime: 10_000,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 2,
  });
  const voteQuery = useQuery({
    queryKey: ["public-vote-entry", publicCode],
    queryFn: ({ signal }) => fetchPublicVoteEntry(publicCode, signal),
    enabled: siteStatus === "active",
    refetchInterval: 15_000,
    retry: 1,
  });

  useEffect(() => {
    document.title =
      siteQuery.data === undefined ? `活动 · ${publicCode}` : `${siteQuery.data.activity.title} · 活动主页`;
    if (siteQuery.data === undefined) return;
    const site = siteQuery.data;
    const description = site.profile.description.slice(0, 160) || site.profile.tagline;
    setHeadMeta("description", description);
    const url = new URL(
      `/e/${encodeURIComponent(site.activity.publicCode)}`,
      window.location.origin,
    ).toString();
    setHeadMeta("og:title", `${site.activity.title} · ArtFlow`);
    setHeadMeta("og:description", description);
    setHeadMeta("og:type", "website");
    setHeadMeta("og:url", url);
    setHeadMeta("twitter:card", "summary");
    setCanonical(url);
  }, [publicCode, siteQuery.data]);

  if (siteQuery.isPending) return <p className="event-state">正在加载活动…</p>;
  if (siteQuery.error instanceof PublicEventNotFound) {
    return (
      <section className="event-state">
        <p className="eyebrow">EVENT</p>
        <h1 className="event-state__title">活动不存在或尚未公开</h1>
        <p className="event-state__copy">请确认公开码，或联系活动主办方。</p>
      </section>
    );
  }
  if (siteQuery.error !== null && siteQuery.data === undefined) {
    return (
      <section className="event-state">
        <h1 className="event-state__title">活动暂时无法加载</h1>
        <button
          type="button"
          className="event-button event-button--primary"
          onClick={() => void siteQuery.refetch()}
        >
          重试
        </button>
      </section>
    );
  }
  const site = siteQuery.data;
  if (site === undefined) return null;

  const announcements = site.profile.announcements ?? [];
  const faq = site.profile.faq ?? [];
  const links = site.profile.links ?? [];
  const participants = site.participants ?? null;
  const hasAbout = site.profile.description.trim() !== "";
  const hasProgram = site.schedule !== null
    || (site.program !== null && site.program.entries.length > 0);
  const hasResults = site.results !== null && site.results.results.length > 0;
  const currentGone = currentQuery.error instanceof ApiError && currentQuery.error.status === 404;
  const liveStatus = currentQuery.data?.activity.status ?? site.activity.status;
  const current = currentGone ? null : currentQuery.data?.current ?? null;
  const next = currentGone ? [] : currentQuery.data?.next ?? [];
  const voteOpen = !voteQuery.isError && voteQuery.data?.status === "open";
  const actions = deriveOnsiteActions({
    siteStatus: site.activity.status,
    currentStatus: liveStatus,
    hasCurrent: current !== null,
    voteOpen,
    hasResults,
    registrationOpen: site.activity.registrationOpen,
  });
  const isActive = liveStatus === "active";
  const total = site.schedule?.entries.length ?? site.program?.entries.length ?? null;
  const programEntries = site.schedule !== null
    ? site.schedule.entries.map((entry) => ({ order: entry.order, name: entry.title, song: entry.slotLabel }))
    : site.program?.entries.map((entry) => ({ order: entry.order, name: entry.name, song: entry.song })) ?? [];
  const currentOrder = current === null ? null : matchCurrentProgramOrder(programEntries, current);
  const voteSessionId = voteQuery.data?.sessionId ?? null;

  function refresh(): void {
    setRefreshing(true);
    void Promise.all([currentQuery.refetch(), voteQuery.refetch()])
      .finally(() => setRefreshing(false));
  }

  return (
    <article className="event-page">
      {online ? null : (
        <p className="event-network" role="status">网络不稳定，展示的是最近一次数据。</p>
      )}
      {siteQuery.isError ? (
        <p className="event-network" role="status">更新失败，展示的是最近一次数据。</p>
      ) : null}
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
        compact={isActive}
      />
      {isActive ? (
        current === null ? (
          <section className="event-now event-now--idle" id="live" aria-labelledby="event-live-title">
            <h2 className="event-section__title" id="event-live-title">现场</h2>
            <p className="event-now__next">暂无进行中的节目。</p>
            {hasProgram ? <a className="event-link" href="#program">查看节目单 →</a> : null}
          </section>
        ) : (
          <NowNextCard
            current={current}
            next={next}
            total={total}
            updatedAt={currentQuery.dataUpdatedAt === 0 ? undefined : currentQuery.dataUpdatedAt}
            onRefresh={refresh}
            refreshing={refreshing}
          />
        )
      ) : null}
      {isActive && currentQuery.isError && !currentGone ? (
        <p className="event-now__error" role="status">
          更新失败，展示的是最近一次数据。
          <button type="button" className="event-link" onClick={refresh}>重试</button>
        </p>
      ) : null}
      <AnnouncementBanner
        publicCode={site.activity.publicCode}
        announcement={site.profile.announcement}
      />
      <nav className="event-anchor-nav" aria-label="活动导航">
        {hasAbout ? <a href="#about">概览</a> : null}
        {announcements.length > 0 ? <a href="#announcements">公告</a> : null}
        {current !== null ? <a href="#live">现场</a> : null}
        {hasProgram ? <a href="#program">节目单</a> : null}
        {(participants?.length ?? 0) > 0 ? <a href="#participants">参与者</a> : null}
        {hasResults ? <a href="#results">赛果</a> : null}
        {faq.length > 0 ? <a href="#faq">常见问题</a> : null}
        {links.length > 0 ? <a href="#links">链接</a> : null}
        {site.activity.status === "closed" ? <a href="#feedback">反馈</a> : null}
      </nav>
      <OnsiteActions
        primary={actions.primary}
        publicCode={site.activity.publicCode}
        eventTitle={site.activity.title}
        voteSessionId={voteSessionId}
        hasProgram={hasProgram}
      />
      <EventAbout description={site.profile.description} />
      <EventAnnouncements items={announcements} />
      <EventProgram site={site} currentOrder={currentOrder} />
      <EventParticipants items={participants} />
      <EventResults site={site} />
      <EventFaq items={faq} />
      <EventLinks items={links} />
      {site.activity.status === "closed" ? (
        <section className="event-section" id="feedback" aria-labelledby="event-feedback-title">
          <h2 className="event-section__title" id="event-feedback-title">活动反馈</h2>
          <p className="event-section__copy">活动已结束，欢迎留下你的评分与建议。</p>
          <FeedbackForm publicCode={site.activity.publicCode} />
        </section>
      ) : null}
      <footer className="event-footer">
        <span>{site.profile.organizer || "主办方"}</span>
        {site.profile.contact === "" ? null : <span>{site.profile.contact}</span>}
        <span>公开码 {site.activity.publicCode}</span>
        <CalendarButton site={site} />
      </footer>
    </article>
  );
}
