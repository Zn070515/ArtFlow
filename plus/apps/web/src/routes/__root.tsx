import { Outlet, useLocation } from "@tanstack/react-router";

import { ConsoleShell } from "../components/shell/ConsoleShell.js";
import { JudgeShell } from "../components/shell/JudgeShell.js";
import { PortalShell } from "../components/shell/PortalShell.js";
import { getShellSurface } from "../components/shell/routeSurface.js";

export function RootLayout() {
  const { pathname } = useLocation();
  const content = <Outlet />;

  // Embeddable widgets and on-site presentation surfaces render without the
  // portal chrome: a projector, a printed host card and a QR sheet.
  if (
    pathname.startsWith("/embed/") ||
    pathname.startsWith("/screen/") ||
    pathname.startsWith("/host-card/") ||
    pathname.startsWith("/print/")
  ) {
    return content;
  }

  const surface = getShellSurface(pathname);
  if (surface === "console") return <ConsoleShell>{content}</ConsoleShell>;
  if (surface === "judge") return <JudgeShell>{content}</JudgeShell>;
  return <PortalShell>{content}</PortalShell>;
}
