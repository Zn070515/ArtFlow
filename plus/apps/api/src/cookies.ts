/** Production is declared by either conventional variable, everywhere. */
export function isProductionEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" || env.APP_ENV === "production";
}

export function sessionCookie(
  name: string,
  value: string,
  expiresAt: string,
  secure: boolean,
  options: { readonly httpOnly?: boolean; readonly sameSite?: "Lax" | "Strict" } = {},
  now = Date.now(),
): string {
  const parsedExpiry = Date.parse(expiresAt);
  const maxAge = Number.isFinite(parsedExpiry)
    ? Math.max(0, Math.ceil((parsedExpiry - now) / 1000))
    : 0;
  const httpOnly = options.httpOnly ?? true;
  const sameSite = options.sameSite ?? "Strict";
  return `${name}=${encodeURIComponent(value)}; Path=/;${httpOnly ? " HttpOnly;" : ""} SameSite=${sameSite}; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
