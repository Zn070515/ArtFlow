const consolePrefixes = ["/ops", "/studio", "/live", "/join", "/login", "/workspace"] as const;
const judgePrefixes = ["/judge"] as const;

export type ShellSurface = "portal" | "console" | "judge";

export function getShellSurface(pathname: string): ShellSurface {
  if (judgePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return "judge";
  }
  return consolePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
    ? "console"
    : "portal";
}
