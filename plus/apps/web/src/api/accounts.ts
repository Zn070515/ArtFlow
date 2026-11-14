import { apiFetch, jsonBody } from "./client.js";

export interface AccountSummary {
  readonly username: string;
  readonly actorId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly active: boolean;
  readonly createdAt: string;
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
}

export async function fetchAccounts(): Promise<readonly AccountSummary[]> {
  const response = await apiFetch<{ accounts: readonly AccountSummary[] }>("/api/admin/accounts");
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

export async function revokeAccountSessions(username: string): Promise<number> {
  const response = await apiFetch<{ revoked: number }>(
    `/api/admin/accounts/${encodeURIComponent(username)}/revoke-sessions`,
    { method: "POST", body: jsonBody({}) },
  );
  return response.revoked;
}
