import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { hasLiveAccess, hasOpsAccess, hasStudioAccess, useSession } from "../../auth/SessionProvider.js";
import { AuroraScene } from "../hero/AuroraScene.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { loadPortalFonts } from "../../styles/portalFonts.js";

export function PortalShell({ children }: { readonly children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  const { pathname } = useLocation();
  const { session, logout } = useSession();

  useEffect(() => {
    void loadPortalFonts();
  }, []);
  const isEventPage = pathname.startsWith("/e/");
  const isEventsPage = pathname === "/events";
  const subtitle = isEventPage ? "活动主页" : isEventsPage ? "活动目录" : "赛果公示";
  const showAurora = pathname === "/" || pathname === "/results" || pathname.startsWith("/results/");
  const showStaticBackdrop = pathname.startsWith("/vote/") || isEventPage || isEventsPage;

  return (
    <div className="app-shell" data-shell="portal" data-theme="afterglow">
      {showAurora || showStaticBackdrop ? (
        <AuroraScene reducedMotion={reducedMotion || showStaticBackdrop} />
      ) : null}
      <header className="site-header">
        <Link to="/" className="brand" aria-label="ArtFlow 首页">
          <span className="brand-mark" aria-hidden="true">
            AF
          </span>
          <span className="brand-text">
            ARTFLOW
            <small>{subtitle}</small>
          </span>
        </Link>
        <nav className="nav-links" aria-label="主导航">
          <Link to="/events" className="nav-link">
            活动
          </Link>
          <Link to="/join" className="nav-link">
            报名
          </Link>
          <Link to="/me" className="nav-link">
            我的
          </Link>
          {hasOpsAccess(session) ? (
            <Link to="/ops" className="nav-link">
              Ops
            </Link>
          ) : null}
          {hasStudioAccess(session) ? (
            <Link to="/studio" className="nav-link">
              Studio
            </Link>
          ) : null}
          {hasLiveAccess(session) ? (
            <Link to="/live" className="nav-link">
              Live
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
      <main className="site-main">{children}</main>
      <footer className="site-footer">
        <span>ArtFlow</span>
        <span>活动运营平台</span>
      </footer>
    </div>
  );
}
