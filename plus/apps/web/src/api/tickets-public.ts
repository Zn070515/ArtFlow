import { apiFetch } from "./client.js";

export interface PublicTicketLookup {
  readonly ticket: {
    readonly publicCode: string;
    readonly state: "issued" | "redeemed" | "revoked" | "expired";
    readonly credentialVersion: number;
    readonly issuedAt: string;
    readonly redeemedAt?: string;
    readonly revokedAt?: string;
  };
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "active" | "closed";
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly venue: string;
    readonly organizer: string;
  };
  readonly links: { readonly event: string; readonly results: string };
}

export interface PublicScheduleEntry {
  readonly order: number;
  readonly slotLabel: string;
  readonly title: string;
  readonly note: string;
  readonly startsAt: string | null;
}

export interface PublicCurrentProgram {
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "active" | "closed";
  };
  readonly current: PublicScheduleEntry | null;
  readonly next: readonly PublicScheduleEntry[];
}

export type PublicVoteEntry = { readonly sessionId: string; readonly status: "open" } | null;

export function lookupTicket(credential: string): Promise<PublicTicketLookup> {
  return apiFetch("/api/public/tickets/lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
}

export function fetchPublicCurrent(
  publicCode: string,
  signal?: AbortSignal,
): Promise<PublicCurrentProgram> {
  return apiFetch(`/api/public/activities/${encodeURIComponent(publicCode)}/current`, { signal });
}

export function fetchPublicVoteEntry(
  publicCode: string,
  signal?: AbortSignal,
): Promise<PublicVoteEntry> {
  return apiFetch(`/api/public/activities/${encodeURIComponent(publicCode)}/voting`, { signal });
}
