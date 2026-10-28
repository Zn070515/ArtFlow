import type { PublicVoteSession } from "@artflow-plus/contracts";

import { apiFetch } from "./client.js";

export async function fetchPublicVote(sessionId: string): Promise<PublicVoteSession> {
  return apiFetch<PublicVoteSession>(`/api/public/vote/${encodeURIComponent(sessionId)}`);
}

export async function ensureBrowserIdentity(activityId: string): Promise<void> {
  await apiFetch(`/api/activities/${activityId}/voting/browser-identity`);
}

export async function redeemTicket(credential: string): Promise<void> {
  await apiFetch("/api/tickets/redeem", {
    method: "POST",
    headers: { "idempotency-key": `ticket-redeem-${crypto.randomUUID()}` },
    body: JSON.stringify({ credential }),
  });
}

export async function submitVote(
  activityId: string,
  sessionId: string,
  optionIds: readonly string[],
  identity: "browser" | "ticket" | "anonymous",
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/voting/sessions/${sessionId}/ballots`, {
    method: "POST",
    headers: { "idempotency-key": `vote-${crypto.randomUUID()}` },
    body: JSON.stringify({ scope: "voting", optionIds, identity: { type: identity } }),
  });
}
