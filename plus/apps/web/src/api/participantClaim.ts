import { apiFetch } from "./client.js";

export interface ParticipantClaimIssue {
  readonly token: string | null;
  readonly activityId: string;
  readonly publicCode: string;
  readonly title: string;
  readonly expiresAt: string;
}

export interface ParticipantClaimActor {
  readonly actorId: string;
  readonly actorType: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface ParticipantClaimConsumeResult {
  readonly actor: ParticipantClaimActor;
  readonly publicCode: string;
  readonly csrfToken?: string;
  readonly expiresAt?: string;
}

export function issueParticipantClaim(
  activityId: string,
  registrationId: string,
  commandId: string,
): Promise<ParticipantClaimIssue> {
  return apiFetch<ParticipantClaimIssue>(
    `/api/activities/${encodeURIComponent(activityId)}/registrations/${encodeURIComponent(registrationId)}/account-claim`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: "{}",
    },
  );
}

export function consumeParticipantClaim(
  token: string,
  commandId: string,
  credentials?: { readonly username: string; readonly password: string },
): Promise<ParticipantClaimConsumeResult> {
  return apiFetch<ParticipantClaimConsumeResult>("/api/public/participant-claims/consume", {
    method: "POST",
    credentials: "same-origin",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify({
      token,
      ...(credentials === undefined ? {} : credentials),
    }),
  });
}
