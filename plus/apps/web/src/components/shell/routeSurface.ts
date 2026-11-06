const consolePrefixes = ["/ops", "/studio", "/live", "/judge", "/join", "/login"] as const;

export type ShellSurface = "portal" | "console";

export function getShellSurface(pathname: string): ShellSurface {
  return consolePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
    ? "console"
    : "portal";
}
