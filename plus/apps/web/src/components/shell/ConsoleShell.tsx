import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { hasLiveAccess, hasOpsAccess, hasStudioAccess, useSession } from "../../auth/SessionProvider.js";

interface ConsoleNavItem {
  readonly label: string;
  readonly to: "/ops" | "/studio" | "/live" | "/join";
  readonly prefix: string;
  readonly visible: boolean;
}

export function ConsoleShell({ children }: { readonly children: ReactNode }) {
  const { pathname } = useLocation();
  const { session, logout } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const items: readonly ConsoleNavItem[] = [
    { label: "Ops", to: "/ops", prefix: "/ops", visible: hasOpsAccess(session) },
    { label: "Studio", to: "/studio", prefix: "/studio", visible: hasStudioAccess(session) },
    { label: "Live", to: "/live", prefix: "/live", visible: hasLiveAccess(session) },
    { label: "报名", to: "/join", prefix: "/join", visible: true },
  ];

  function closeMenu(): void {
    setMobileOpen(false);
  }

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setMobileOpen(false);
      menuButtonRef.current?.focus();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  const contextLabel = pathname.startsWith("/ops")
    ? "Ops · 运营"
    : pathname.startsWith("/studio")
      ? "Studio · 规则"
      : pathname.startsWith("/live")
        ? "Live · 现场"
        : pathname.startsWith("/judge")
          ? "Judge · 评分"
          : pathname.startsWith("/join")
            ? "报名 · 参与者"
            : pathname.startsWith("/login")
              ? "登录"
              : "工作区";

  return (
    <div className="console-shell" data-shell="console" data-theme="signal">
      <header className="console-topbar">
        <Link to="/" className="console-brand" aria-label="ArtFlow Portal 首页">
          <span className="console-brand-mark" aria-hidden="true">
            AF
          </span>
          <span className="console-brand-copy">
            <strong>ARTFLOW</strong>
            <small>Console</small>
          </span>
        </Link>
        <span className="console-context" aria-label="当前工作区">
          {contextLabel}
        </span>
        <div className="console-topbar-actions">
          {session === null ? (
            <Link to="/login" search={{ next: pathname }} className="console-account-link">
              登录
            </Link>
          ) : (
            <button
              className="console-account-link"
              type="button"
              onClick={() => {
                void logout();
              }}
            >
              退出
            </button>
          )}
          <button
            ref={menuButtonRef}
            className="console-menu-toggle"
            type="button"
            aria-expanded={mobileOpen}
            aria-controls="console-sidebar"
            aria-label={mobileOpen ? "关闭 Console 导航" : "打开 Console 导航"}
            onClick={() => setMobileOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span>
          </button>
        </div>
      </header>
      <div className="console-layout">
        <aside
          id="console-sidebar"
          className={`console-sidebar${mobileOpen ? " is-open" : ""}`}
          aria-label="Console 侧栏"
        >
          <div className="console-sidebar-label">工作区</div>
          <nav className="console-nav" aria-label="Console 主导航">
            {items
              .filter((item) => item.visible)
              .map((item) => {
                const current = pathname === item.prefix || pathname.startsWith(`${item.prefix}/`);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`console-nav-link${current ? " is-current" : ""}`}
                    aria-current={current ? "page" : undefined}
                    onClick={closeMenu}
                  >
                    <span aria-hidden="true" className="console-nav-mark" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
          </nav>
          <Link to="/" className="console-return-link" onClick={closeMenu}>
            ← 返回公开门户
          </Link>
        </aside>
        <main className="console-main">
          <div className="console-page">{children}</div>
        </main>
      </div>
    </div>
  );
}
