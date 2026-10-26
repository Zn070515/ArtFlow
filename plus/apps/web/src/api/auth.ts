import { apiFetch, ApiError } from "./client.js";

export interface SessionActor {
  readonly actorId: string;
  readonly actorType: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface SessionResponse {
  readonly actor: SessionActor;
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly token?: string;
}

export async function fetchMe(): Promise<SessionResponse | null> {
  try {
    return await apiFetch<SessionResponse>("/api/auth/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function login(username: string, password: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function registerParticipant(username: string, password: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export async function logout(): Promise<void> {
  await apiFetch<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}
