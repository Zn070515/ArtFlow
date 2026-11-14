import { Outlet, useLocation } from "@tanstack/react-router";

import { ConsoleShell } from "../components/shell/ConsoleShell.js";
import { JudgeShell } from "../components/shell/JudgeShell.js";
import { PortalShell } from "../components/shell/PortalShell.js";
import { getShellSurface } from "../components/shell/routeSurface.js";

export function RootLayout() {
  const { pathname } = useLocation();
  const content = <Outlet />;

  const surface = getShellSurface(pathname);
  if (surface === "console") return <ConsoleShell>{content}</ConsoleShell>;
  if (surface === "judge") return <JudgeShell>{content}</JudgeShell>;
  return <PortalShell>{content}</PortalShell>;
}
