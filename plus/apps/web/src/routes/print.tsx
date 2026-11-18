import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { fetchPublicEvent } from "../api/publicEvent.js";
import { QrCard } from "../components/print/QrCard.js";

export function PrintPackPage() {
  const { publicCode } = useParams({ from: "/print/$publicCode" });
  const site = useQuery({
    queryKey: ["print-site", publicCode],
    queryFn: ({ signal }) => fetchPublicEvent(publicCode, signal),
    retry: false,
    staleTime: 60_000,
  });
  const title = site.data?.activity.title ?? publicCode;
  const base = window.location.origin;
  const entries = [
    {
      title: "活动主页",
      description: "公告、当前节目、节目单与赛果",
      url: `${base}/e/${encodeURIComponent(publicCode)}`,
    },
    {
      title: "报名入口",
      description: "参与者登录后填写报名表",
      url: `${base}/join/${encodeURIComponent(publicCode)}`,
    },
    {
      title: "节目单",
      description: "公开节目单与当前节目",
      url: `${base}/program/${encodeURIComponent(publicCode)}`,
    },
    {
      title: "正式赛果",
      description: "仅展示已核定的正式结果",
      url: `${base}/results/${encodeURIComponent(publicCode)}`,
    },
    {
      title: "现场大屏",
      description: "投影/电视用的当前节目与赛果",
      url: `${base}/screen/${encodeURIComponent(publicCode)}`,
    },
    {
      title: "主持手卡",
      description: "打印给主持人的流程与结果卡片",
      url: `${base}/host-card/${encodeURIComponent(publicCode)}`,
    },
  ];

  return (
    <main className="print-pack">
      <header className="print-pack__header">
        <p className="eyebrow">ARTFLOW · PRINT PACK</p>
        <h1>{title}</h1>
        <p>以下二维码只指向公开页面；公开码是定位符，不是授权凭证。</p>
        <button type="button" className="ui-button ui-button--primary no-print" onClick={() => window.print()}>
          打印这一页
        </button>
      </header>
      <section className="print-pack__grid">
        {entries.map((entry) => (
          <QrCard key={entry.title} {...entry} />
        ))}
      </section>
      <p className="print-pack__footnote">
        二维码应只从正式 HTTPS 域名打印；localhost、内网 IP 或临时隧道生成的码在活动现场无法打开。
      </p>
    </main>
  );
}
