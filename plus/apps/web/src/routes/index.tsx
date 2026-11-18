import { Link } from "@tanstack/react-router";
import { useEffect } from "react";

import { CodeEntry } from "../components/CodeEntry.js";

export function Landing() {
  useEffect(() => {
    document.title = "ArtFlow · 赛果公示";
  }, []);

  return (
    <section className="landing">
      <p className="eyebrow">RESULTS · 结果公示</p>
      <h1 className="display landing-title">
        <span>赛果，</span>
        <em>在此揭晓。</em>
      </h1>
      <p className="lede">输入活动公开码，查看正式发布的赛果与奖项。</p>
      <CodeEntry />
      <p className="landing-directory">
        <Link className="event-link" to="/events">浏览全部活动 →</Link>
      </p>
      <p className="footnote">公开结果来自发布快照，不使用编辑字段。</p>
    </section>
  );
}
