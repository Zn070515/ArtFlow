import type { Kysely, Selectable } from "kysely";

import type { AccountInviteRow, Database } from "./types.js";

export interface StoredAccountInvite {
  readonly id: string;
  readonly username: string;
  readonly expiresAt: string;
  readonly claimedAt?: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function invite(row: Selectable<AccountInviteRow>): StoredAccountInvite {
  return {
    id: row.id,
    username: row.username,
    expiresAt: iso(row.expires_at),
    ...(row.claimed_at === null ? {} : { claimedAt: iso(row.claimed_at) }),
  };
}

export interface ReplaceAccountInviteInput {
  readonly id: string;
  readonly username: string;
  readonly tokenDigest: string;
  readonly expiresAt: string;
  readonly issuedBy: string;
}

/** Rotation replaces the one open invitation for that account. */
export async function replaceAccountInvite(
  db: Kysely<Database>,
  input: ReplaceAccountInviteInput,
): Promise<void> {
  await db
    .deleteFrom("account_invite")
    .where("username", "=", input.username)
    .where("claimed_at", "is", null)
    .execute();
  await db
    .insertInto("account_invite")
    .values({
      id: input.id,
      username: input.username,
      token_digest: input.tokenDigest,
      expires_at: new Date(input.expiresAt),
      claimed_at: null,
      issued_by: input.issuedBy,
      created_at: new Date(),
    })
    .execute();
}

export async function getAccountInviteByDigest(
  db: Kysely<Database>,
  tokenDigest: string,
): Promise<StoredAccountInvite | null> {
  const row = await db
    .selectFrom("account_invite")
    .selectAll()
    .where("token_digest", "=", tokenDigest)
    .executeTakeFirst();
  return row === undefined ? null : invite(row);
}

export async function getOpenAccountInvite(
  db: Kysely<Database>,
  tokenDigest: string,
  now: string,
): Promise<StoredAccountInvite | null> {
  const row = await db
    .selectFrom("account_invite")
    .selectAll()
    .where("token_digest", "=", tokenDigest)
    .where("claimed_at", "is", null)
    .where("expires_at", ">", new Date(now))
    .executeTakeFirst();
  return row === undefined ? null : invite(row);
}

/** One-time claim; a second caller gets null instead of a second success. */
export async function claimAccountInvite(
  db: Kysely<Database>,
  id: string,
  now: string,
): Promise<StoredAccountInvite | null> {
  const row = await db
    .updateTable("account_invite")
    .set({ claimed_at: new Date(now) })
    .where("id", "=", id)
    .where("claimed_at", "is", null)
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? null : invite(row);
}

export async function deleteOpenAccountInvite(
  db: Kysely<Database>,
  username: string,
): Promise<number> {
  const result = await db
    .deleteFrom("account_invite")
    .where("username", "=", username)
    .where("claimed_at", "is", null)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

export async function listOpenInviteUsernames(
  db: Kysely<Database>,
  usernames: readonly string[],
  now: string,
): Promise<ReadonlySet<string>> {
  if (usernames.length === 0) return new Set();
  const rows = await db
    .selectFrom("account_invite")
    .select("username")
    .where("username", "in", [...usernames])
    .where("claimed_at", "is", null)
    .where("expires_at", ">", new Date(now))
    .execute();
  return new Set(rows.map((row) => row.username));
}
