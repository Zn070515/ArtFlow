import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ThemeToggle } from "../../theme/ThemeToggle.js";

/** A judge is not an organizer: no Console navigation, no account switcher,
 * no participant links. The page keeps only the brand, the judgment context,
 * and the theme control. */
export function JudgeShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="judge-shell" data-shell="judge">
      <header className="console-topbar">
        <Link to="/" className="console-brand" aria-label="ArtFlow 首页">
          <span className="console-brand-mark" aria-hidden="true">
            AF
          </span>
          <span className="console-brand-copy">
            <strong>ARTFLOW</strong>
            <small>评委评分</small>
          </span>
        </Link>
        <span className="console-context">评委评分</span>
        <div className="console-topbar-actions">
          <ThemeToggle />
        </div>
      </header>
      <main className="console-main">
        <div className="console-page">{children}</div>
      </main>
    </div>
  );
}
