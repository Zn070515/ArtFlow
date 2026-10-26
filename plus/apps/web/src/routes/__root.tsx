import { Link, Outlet } from "@tanstack/react-router";

import { AuroraScene } from "../components/hero/AuroraScene.js";
import { useReducedMotion } from "../hooks/useReducedMotion.js";

export function RootLayout() {
  const reducedMotion = useReducedMotion();

  return (
    <div className="app-shell">
      <AuroraScene reducedMotion={reducedMotion} />
      <header className="site-header">
        <Link to="/" className="brand" aria-label="ArtFlow 赛果公示首页">
          <span className="brand-mark" aria-hidden="true">
            AF
          </span>
          <span className="brand-text">
            ARTFLOW
            <small>赛果公示</small>
          </span>
        </Link>
      </header>
      <main className="site-main">
        <Outlet />
      </main>
      <footer className="site-footer">
        <span>ArtFlow</span>
        <span>活动运营平台</span>
      </footer>
    </div>
  );
}
