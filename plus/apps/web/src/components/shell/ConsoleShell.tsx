import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { hasLiveAccess, hasOpsAccess, hasStudioAccess, hasWorkspaceAccess, useSession } from "../../auth/SessionProvider.js";
import { ThemeToggle } from "../../theme/ThemeToggle.js";
import { useTheme } from "../../theme/ThemeProvider.js";

interface ConsoleNavItem {
  readonly label: string;
  readonly to: "/ops" | "/studio" | "/live" | "/join" | "/workspace";
  readonly prefix: string;
  readonly visible: boolean;
}

export function ConsoleShell({ children }: { readonly children: ReactNode }) {
  const { pathname } = useLocation();
  const [isDrawer, setIsDrawer] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches,
  );
  const { session, logout } = useSession();
  const { theme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const items: readonly ConsoleNavItem[] = [
    { label: "Workspace", to: "/workspace", prefix: "/workspace", visible: hasWorkspaceAccess(session) },
    { label: "Ops", to: "/ops", prefix: "/ops", visible: hasOpsAccess(session) },
    { label: "Studio", to: "/studio", prefix: "/studio", visible: hasStudioAccess(session) },
    { label: "Live", to: "/live", prefix: "/live", visible: hasLiveAccess(session) },
    { label: "报名", to: "/join", prefix: "/join", visible: true },
  ];

  function closeMenu(): void {
    setMobileOpen(false);
  }

  function focusToggle(): void {
    // The topbar is inert while the drawer is open; wait for React to clear it.
    requestAnimationFrame(() => menuButtonRef.current?.focus());
  }

  function closeDrawer(): void {
    setMobileOpen(false);
    focusToggle();
  }

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = (): void => setIsDrawer(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setMobileOpen(false);
      focusToggle();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  const contextLabel = pathname.startsWith("/workspace")
    ? "工作台 · 活动"
    : pathname.startsWith("/ops")
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
    <div className="console-shell" data-shell="console" data-theme={theme}>
      <header className="console-topbar" inert={isDrawer && mobileOpen}>
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
          <ThemeToggle />
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
          {...(isDrawer ? { role: "dialog", "aria-modal": true } : {})}
        >
          {isDrawer && mobileOpen ? (
            <button
              type="button"
              className="console-drawer-close"
              aria-label="关闭 Console 导航"
              onClick={closeDrawer}
              autoFocus
            >
              ×
            </button>
          ) : null}
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
        {isDrawer && mobileOpen ? (
          <div className="console-drawer-backdrop" aria-hidden="true" onClick={closeDrawer} />
        ) : null}
        <main className="console-main" inert={isDrawer && mobileOpen}>
          <div className="console-page">{children}</div>
        </main>
      </div>
    </div>
  );
}
