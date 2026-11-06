import { Outlet, useLocation } from "@tanstack/react-router";

import { ConsoleShell } from "../components/shell/ConsoleShell.js";
import { PortalShell } from "../components/shell/PortalShell.js";
import { getShellSurface } from "../components/shell/routeSurface.js";

export function RootLayout() {
  const { pathname } = useLocation();
  const content = <Outlet />;

  return getShellSurface(pathname) === "console" ? (
    <ConsoleShell>{content}</ConsoleShell>
  ) : (
    <PortalShell>{content}</PortalShell>
  );
}
