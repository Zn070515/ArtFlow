import { apiFetch, jsonBody } from "./client.js";

export interface AccountSummary {
  readonly username: string;
  readonly actorId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly active: boolean;
  readonly invited: boolean;
  readonly accessRevision: number;
  readonly createdAt: string;
}

export interface InviteAccountInput {
  readonly username: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface InviteCreated {
  readonly account: AccountSummary;
  readonly token: string;
  readonly expiresAt: string;
}

export interface CreateAccountInput {
  readonly username: string;
  readonly password: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface UpdateAccountInput {
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
  readonly active?: boolean;
  readonly password?: string;
  readonly expectedRevision: number;
}

export async function fetchAccounts(
  includeParticipants = false,
): Promise<readonly AccountSummary[]> {
  const response = includeParticipants
    ? await apiFetch<{ accounts: readonly AccountSummary[]; total: number }>(
        "/api/admin/accounts?includeParticipants=true",
      )
    : await apiFetch<{ accounts: readonly AccountSummary[]; total: number }>(
        "/api/admin/accounts",
      );
  return response.accounts;
}

export async function createAccount(input: CreateAccountInput): Promise<AccountSummary> {
  const response = await apiFetch<{ account: AccountSummary }>("/api/admin/accounts", {
    method: "POST",
    body: jsonBody(input),
  });
  return response.account;
}

export async function updateAccount(
  username: string,
  input: UpdateAccountInput,
): Promise<AccountSummary> {
  const response = await apiFetch<{ account: AccountSummary }>(
    `/api/admin/accounts/${encodeURIComponent(username)}`,
    { method: "PUT", body: jsonBody(input) },
  );
  return response.account;
}

export function inviteAccount(input: InviteAccountInput): Promise<InviteCreated> {
  return apiFetch<InviteCreated>("/api/admin/accounts/invites", {
    method: "POST",
    body: jsonBody(input),
  });
}

export async function revokeAccountInvite(username: string): Promise<number> {
  const response = await apiFetch<{ revoked: number }>(
    `/api/admin/accounts/${encodeURIComponent(username)}/invite`,
    { method: "DELETE" },
  );
  return response.revoked;
}

export async function revokeAccountSessions(username: string): Promise<number> {
  const response = await apiFetch<{ revoked: number }>(
    `/api/admin/accounts/${encodeURIComponent(username)}/revoke-sessions`,
    { method: "POST", body: jsonBody({}) },
  );
  return response.revoked;
}
