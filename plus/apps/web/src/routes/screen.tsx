import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import * as QRCode from "qrcode";
import { useEffect, useState } from "react";

import { fetchPublicEvent } from "../api/publicEvent.js";
import { fetchPublicCurrent } from "../api/tickets-public.js";

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
}

function ScreenQr({ publicCode }: { readonly publicCode: string }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    const url = `${window.location.origin}/e/${encodeURIComponent(publicCode)}`;
    let cancelled = false;
    void QRCode.toDataURL(url, { margin: 1, width: 220 }).then((data) => {
      if (!cancelled) setImage(data);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [publicCode]);
  return (
    <div className="screen-qr">
      {image === null ? null : <img src={image} alt="活动二维码" width={220} height={220} />}
      <p>扫码查看活动</p>
    </div>
  );
}

export function ScreenPage() {
  const { publicCode } = useParams({ from: "/screen/$publicCode" });
  const clock = useClock();
  const site = useQuery({
    queryKey: ["screen-site", publicCode],
    queryFn: ({ signal }) => fetchPublicEvent(publicCode, signal),
    refetchInterval: 60_000,
    retry: false,
  });
  const current = useQuery({
    queryKey: ["screen-current", publicCode],
    queryFn: ({ signal }) => fetchPublicCurrent(publicCode, signal),
    refetchInterval: 10_000,
    retry: false,
  });

  useEffect(() => {
    document.title = site.data === undefined ? "现场大屏 · ArtFlow" : `${site.data.activity.title} · 现场大屏`;
  }, [site.data]);

  const activity = site.data?.activity;
  const closed = activity?.status === "closed";
  const now = current.data?.current ?? null;
  const next = current.data?.next ?? [];
  const results = site.data?.results?.results ?? [];
  const latest = results[0];
  const announcement = site.data?.profile.announcements[0] ?? null;

  return (
    <main className="screen-page">
      <header className="screen-header">
        <div>
          <p className="screen-kicker">{site.data?.profile.organizer ?? "ARTFLOW"}</p>
          <h1 className="screen-title">{activity?.title ?? publicCode}</h1>
          <p className="screen-meta">{site.data?.profile.venue ?? ""}</p>
        </div>
        <div className="screen-status">
          <span>{closed ? "已结束" : "进行中"}</span>
          <strong>{clock}</strong>
          <button
            type="button"
            className="screen-fullscreen no-print"
            onClick={() => {
              if (document.fullscreenElement === null) void document.documentElement.requestFullscreen();
              else void document.exitFullscreen();
            }}
          >
            全屏
          </button>
        </div>
      </header>

      {announcement === null ? null : (
        <section className="screen-announcement">
          <strong>{announcement.title}</strong>
          <span>{announcement.body}</span>
        </section>
      )}

      <section className="screen-grid">
        <div className="screen-now">
          <p className="screen-label">{closed ? "FINAL" : "NOW"}</p>
          <h2>{closed ? "活动已结束" : now?.title ?? "等待开始"}</h2>
          <p className="screen-sub">
            {closed
              ? "赛果以正式发布为准"
              : [now?.slotLabel, now?.note].filter((value) => value !== undefined && value !== "").join(" · ")}
          </p>
        </div>

        <aside className="screen-next">
          <p className="screen-label">NEXT</p>
          {next.length === 0 ? (
            <p className="screen-empty">暂无后续节目</p>
          ) : (
            <ol>
              {next.slice(0, 4).map((entry) => (
                <li key={`${entry.order}-${entry.title}`}>
                  <span>{entry.slotLabel}</span>
                  <strong>{entry.title}</strong>
                </li>
              ))}
            </ol>
          )}
        </aside>

        <section className="screen-results">
          <p className="screen-label">RESULTS</p>
          {latest === undefined ? (
            <p className="screen-empty">正式赛果尚未发布</p>
          ) : (
            <>
              <h2>{latest.publicTitle}</h2>
              <ol>
                {latest.decisions.slice(0, 5).map((decision) => (
                  <li key={`${decision.rank}-${decision.contestantName}`}>
                    <span>{decision.rank}</span>
                    <strong>{decision.contestantName}</strong>
                    <em>{decision.unit === "percent" ? `${decision.score}%` : decision.score}</em>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>

        <ScreenQr publicCode={publicCode} />
      </section>
    </main>
  );
}
