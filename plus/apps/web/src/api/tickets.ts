import { apiFetch } from "./client.js";

export type TicketState = "issued" | "redeemed" | "revoked" | "expired";

export interface TicketView {
  readonly id: string;
  readonly publicCode: string;
  readonly state: TicketState;
  readonly credentialVersion: number;
  readonly issuedAt: string;
  readonly redeemedAt?: string;
  readonly revokedAt?: string;
}

export interface TicketSessionView {
  readonly id: string;
  readonly ticketId: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface TicketingState {
  readonly tickets: readonly TicketView[];
  readonly sessions: readonly TicketSessionView[];
}

export interface IssuedTicket {
  readonly ticket: TicketView;
  readonly credential: string;
}

export function fetchTicketingState(activityId: string): Promise<TicketingState> {
  return apiFetch<TicketingState>(
    `/api/activities/${encodeURIComponent(activityId)}/ticketing/state`,
  );
}

export function issueTicket(activityId: string, commandId: string): Promise<IssuedTicket> {
  return apiFetch<IssuedTicket>(`/api/activities/${encodeURIComponent(activityId)}/tickets`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: "{}",
  });
}

export function rotateTicket(
  activityId: string,
  ticketId: string,
  commandId: string,
): Promise<IssuedTicket> {
  return apiFetch<IssuedTicket>(
    `/api/activities/${encodeURIComponent(activityId)}/tickets/${encodeURIComponent(ticketId)}/rotate`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: "{}",
    },
  );
}

export function revokeTicket(
  activityId: string,
  ticketId: string,
  reason: string,
  commandId: string,
): Promise<TicketView> {
  return apiFetch<TicketView>(
    `/api/activities/${encodeURIComponent(activityId)}/tickets/${encodeURIComponent(ticketId)}/revoke`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ reason }),
    },
  );
}

export function revokeTicketSession(
  activityId: string,
  sessionId: string,
  reason: string,
  commandId: string,
): Promise<unknown> {
  return apiFetch(
    `/api/activities/${encodeURIComponent(activityId)}/ticket-sessions/${encodeURIComponent(sessionId)}/revoke`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ reason }),
    },
  );
}
