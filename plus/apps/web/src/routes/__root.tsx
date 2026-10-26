import { Link, Outlet } from "@tanstack/react-router";

import { hasOpsAccess, useSession } from "../auth/SessionProvider.js";
import { AuroraScene } from "../components/hero/AuroraScene.js";
import { useReducedMotion } from "../hooks/useReducedMotion.js";

export function RootLayout() {
  const reducedMotion = useReducedMotion();
  const { session, logout } = useSession();

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
        <nav className="nav-links" aria-label="主导航">
          <Link to="/join" className="nav-link">
            报名
          </Link>
          {hasOpsAccess(session) ? (
            <Link to="/ops" className="nav-link">
              Ops
            </Link>
          ) : null}
          {session === null ? (
            <Link to="/login" search={{ next: undefined }} className="nav-link">
              登录
            </Link>
          ) : (
            <button
              className="nav-link"
              type="button"
              onClick={() => {
                void logout();
              }}
            >
              退出
            </button>
          )}
        </nav>
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
