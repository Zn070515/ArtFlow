import type { ActorContext, ActorType } from "@artflow-plus/domain";
import type { Kysely, Selectable } from "kysely";

import type { Database, LocalAccountRow } from "./types.js";

export interface StoredLocalAccount {
  readonly username: string;
  readonly passwordDigest: string;
  readonly actor: ActorContext;
  readonly active: boolean;
}

export interface StoredLocalSession {
  readonly token: string;
  readonly actor: ActorContext;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

function jsonArray(value: unknown): readonly string[] {
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function account(row: Selectable<LocalAccountRow>): StoredLocalAccount {
  return {
    username: row.username,
    passwordDigest: row.password_digest,
    active: row.active,
    actor: {
      actorId: row.actor_id,
      actorType: row.actor_type as ActorType,
      roles: jsonArray(row.roles),
      permissions: jsonArray(row.permissions),
      ...(row.auth_context === null ? {} : { authContext: row.auth_context }),
    },
  };
}

export async function insertLocalAccount(
  db: Kysely<Database>,
  input: StoredLocalAccount,
): Promise<void> {
  await db
    .insertInto("local_account")
    .values({
      username: input.username,
      password_digest: input.passwordDigest,
      actor_id: input.actor.actorId,
      actor_type: input.actor.actorType,
      roles: JSON.stringify([...input.actor.roles]),
      permissions: JSON.stringify([...input.actor.permissions]),
      auth_context: input.actor.authContext ?? null,
      active: input.active,
      created_at: new Date(),
    })
    .execute();
}

export async function getLocalAccount(
  db: Kysely<Database>,
  username: string,
): Promise<StoredLocalAccount | null> {
  const row = await db
    .selectFrom("local_account")
    .selectAll()
    .where("username", "=", username)
    .executeTakeFirst();
  return row === undefined ? null : account(row);
}

export async function insertLocalSession(
  db: Kysely<Database>,
  input: StoredLocalSession,
): Promise<void> {
  await db
    .insertInto("local_session")
    .values({
      token: input.token,
      actor_id: input.actor.actorId,
      actor_type: input.actor.actorType,
      roles: JSON.stringify([...input.actor.roles]),
      permissions: JSON.stringify([...input.actor.permissions]),
      auth_context: input.actor.authContext ?? null,
      expires_at: input.expiresAt,
      revoked_at: input.revokedAt ?? null,
      created_at: new Date(),
    })
    .execute();
}

/**
 * Authorization reads the account, never the session snapshot. A session only
 * proves that the holder authenticated once; its roles and permissions columns
 * are an immutable record of what was true at login. Downgrades, deactivation,
 * and deletion therefore take effect on the next request.
 */
export async function getLocalSessionWithAccount(
  db: Kysely<Database>,
  token: string,
  now: string,
): Promise<StoredLocalSession | null> {
  const row = await db
    .selectFrom("local_session as s")
    .innerJoin("local_account as a", "a.actor_id", "s.actor_id")
    .select([
      "s.token as token",
      "s.expires_at as expires_at",
      "a.actor_id as actor_id",
      "a.actor_type as actor_type",
      "a.roles as roles",
      "a.permissions as permissions",
    ])
    .where("s.token", "=", token)
    .where("s.expires_at", ">", new Date(now))
    .where("s.revoked_at", "is", null)
    .where("a.active", "=", true)
    .orderBy("a.created_at", "asc")
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    token: row.token,
    expiresAt: iso(row.expires_at),
    actor: {
      actorId: row.actor_id,
      actorType: row.actor_type as ActorType,
      roles: jsonArray(row.roles),
      permissions: jsonArray(row.permissions),
      authContext: token,
    },
  };
}

export interface StoredLocalAccountSummary {
  readonly username: string;
  readonly actorId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly active: boolean;
  readonly createdAt: string;
}

function summary(row: Selectable<LocalAccountRow>): StoredLocalAccountSummary {
  return {
    username: row.username,
    actorId: row.actor_id,
    roles: jsonArray(row.roles),
    permissions: jsonArray(row.permissions),
    active: row.active,
    createdAt: iso(row.created_at),
  };
}

export async function listLocalAccounts(
  db: Kysely<Database>,
): Promise<readonly StoredLocalAccountSummary[]> {
  const rows = await db
    .selectFrom("local_account")
    .selectAll()
    .orderBy("username")
    .execute();
  return rows.map(summary);
}

export async function getLocalAccountSummary(
  db: Kysely<Database>,
  username: string,
): Promise<StoredLocalAccountSummary | null> {
  const row = await db
    .selectFrom("local_account")
    .selectAll()
    .where("username", "=", username)
    .executeTakeFirst();
  return row === undefined ? null : summary(row);
}

export interface LocalAccountAccessPatch {
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
  readonly active?: boolean;
  readonly passwordDigest?: string;
}

export async function updateLocalAccountAccess(
  db: Kysely<Database>,
  username: string,
  patch: LocalAccountAccessPatch,
): Promise<StoredLocalAccountSummary | null> {
  const set: {
    roles?: string;
    permissions?: string;
    active?: boolean;
    password_digest?: string;
  } = {};
  if (patch.roles !== undefined) set.roles = JSON.stringify(patch.roles);
  if (patch.permissions !== undefined) set.permissions = JSON.stringify(patch.permissions);
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.passwordDigest !== undefined) set.password_digest = patch.passwordDigest;

  if (Object.keys(set).length === 0) {
    const row = await db
      .selectFrom("local_account")
      .selectAll()
      .where("username", "=", username)
      .executeTakeFirst();
    return row === undefined ? null : summary(row);
  }

  const row = await db
    .updateTable("local_account")
    .set(set)
    .where("username", "=", username)
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? null : summary(row);
}

export async function revokeLocalSessionsForActor(
  db: Kysely<Database>,
  actorId: string,
  now: string,
): Promise<number> {
  const result = await db
    .updateTable("local_session")
    .set({ revoked_at: now })
    .where("actor_id", "=", actorId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export async function revokeLocalSession(
  db: Kysely<Database>,
  token: string,
  now: string,
): Promise<boolean> {
  const result = await db
    .updateTable("local_session")
    .set({ revoked_at: now })
    .where("token", "=", token)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}
