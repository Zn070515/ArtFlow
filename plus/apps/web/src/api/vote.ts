import type { PublicVoteSession } from "@artflow-plus/contracts";

import { apiFetch } from "./client.js";

export async function fetchPublicVote(sessionId: string): Promise<PublicVoteSession> {
  return apiFetch<PublicVoteSession>(`/api/public/vote/${encodeURIComponent(sessionId)}`);
}

export async function ensureBrowserIdentity(activityId: string): Promise<void> {
  await apiFetch(`/api/activities/${activityId}/voting/browser-identity`);
}

async function redemptionCommandId(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ticket-redeem-${hex}`;
}

export async function redeemTicket(credential: string): Promise<void> {
  const commandId = await redemptionCommandId(credential);
  await apiFetch("/api/tickets/redeem", {
    method: "POST",
    headers: { "idempotency-key": commandId },
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
