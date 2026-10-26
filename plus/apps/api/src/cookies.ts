/** Production is declared by either conventional variable, everywhere. */
export function isProductionEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" || env.APP_ENV === "production";
}

export function sessionCookie(
  name: string,
  value: string,
  expiresAt: string,
  secure: boolean,
  now = Date.now(),
): string {
  const maxAge = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
