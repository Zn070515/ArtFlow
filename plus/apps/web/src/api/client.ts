import { withVisitor } from "./visitor.js";

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

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  query?: Readonly<Record<string, string | number | boolean | undefined>>,
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = withVisitor(init.headers);
  if (method !== "GET" && method !== "HEAD") {
    const csrf = csrfFromCookie();
    if (csrf !== undefined) headers.set("x-csrf-token", csrf);
  }
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  let target = path;
  if (query !== undefined) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const encoded = params.toString();
    if (encoded !== "") target += `?${encoded}`;
  }
  const response = await fetch(target, { ...init, headers, credentials: "same-origin" });
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
