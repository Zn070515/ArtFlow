const STORAGE_KEY = "artflow_visitor";
let memoryId: string | undefined;

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Stable, non-secret browser identity for public rate limits. It solves venue
 * NAT (hundreds of visitors share one address); it is not an authorization
 * credential and carries no user data.
 */
export function visitorId(): string {
  if (memoryId !== undefined) return memoryId;
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored !== null && stored !== undefined && stored.length >= 8) {
      memoryId = stored;
      return stored;
    }
    const created = randomId();
    globalThis.localStorage?.setItem(STORAGE_KEY, created);
    memoryId = created;
    return created;
  } catch {
    memoryId = randomId();
    return memoryId;
  }
}

export function withVisitor(headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  if (!next.has("x-artflow-visitor")) next.set("x-artflow-visitor", visitorId());
  return next;
}
