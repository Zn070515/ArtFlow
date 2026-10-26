export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function csrfFromCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const prefix = "artflow_csrf=";
  const match = document.cookie.split("; ").find((row) => row.startsWith(prefix));
  return match?.slice(prefix.length);
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") {
    const csrf = csrfFromCookie();
    if (csrf !== undefined) headers.set("x-csrf-token", csrf);
  }
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    let body: { code?: string; message?: string; details?: unknown } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Non-JSON errors fall back to the status message.
    }
    throw new ApiError(
      response.status,
      body.code ?? "REQUEST_FAILED",
      body.message ?? `请求失败（${response.status}）`,
      body.details,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}
