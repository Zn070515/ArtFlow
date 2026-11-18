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
  readonly mfaEnabled?: boolean;
}

export async function fetchMe(): Promise<SessionResponse | null> {
  try {
    return await apiFetch<SessionResponse>("/api/auth/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export type LoginResult =
  | SessionResponse
  | { readonly mfaRequired: true; readonly challenge: string };

export function login(username: string, password: string): Promise<LoginResult> {
  return apiFetch<LoginResult>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function verifyMfa(challenge: string, code: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>("/api/auth/mfa", {
    method: "POST",
    body: JSON.stringify({ challenge, code }),
  });
}

export function registerParticipant(
  username: string,
  password: string,
  email?: string,
): Promise<SessionResponse> {
  return apiFetch<SessionResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password, ...(email === undefined ? {} : { email }) }),
  });
}

export function fetchOidcConfig(): Promise<{ enabled: boolean; label?: string }> {
  return apiFetch("/api/auth/oidc/config");
}

export function forgotPassword(identifier: string): Promise<{ ok: boolean }> {
  return apiFetch("/api/auth/password/forgot", {
    method: "POST",
    body: JSON.stringify({ identifier }),
  });
}

export function resetPassword(token: string, password: string): Promise<{ ok: boolean }> {
  return apiFetch("/api/auth/password/reset", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
}

export interface MfaEnrollment {
  readonly secret: string;
  readonly otpauthUrl: string;
}

export function enrollMfa(): Promise<MfaEnrollment> {
  return apiFetch("/api/auth/mfa/enroll", { method: "POST", body: "{}" });
}

export function confirmMfa(code: string): Promise<{ ok: boolean }> {
  return apiFetch("/api/auth/mfa/confirm", { method: "POST", body: JSON.stringify({ code }) });
}

export function disableMfa(password: string, code: string): Promise<{ ok: boolean }> {
  return apiFetch("/api/auth/mfa/disable", { method: "POST", body: JSON.stringify({ password, code }) });
}

export interface InvitePreview {
  readonly username: string;
  readonly expiresAt: string;
}

export function previewInvite(token: string): Promise<InvitePreview> {
  return apiFetch<InvitePreview>("/api/auth/invite-preview", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function claimInvite(token: string, password: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>("/api/auth/claim-invite", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
}

export async function logout(): Promise<void> {
  await apiFetch<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}
