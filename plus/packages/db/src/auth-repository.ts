import type { ActorContext, ActorType } from "@artflow-plus/domain";
import type { Kysely, Selectable } from "kysely";

import type { Database, LocalAccountRow, LocalSessionRow } from "./types.js";

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

function session(row: Selectable<LocalSessionRow>): StoredLocalSession {
  return {
    token: row.token,
    expiresAt: iso(row.expires_at),
    ...(row.revoked_at === null ? {} : { revokedAt: iso(row.revoked_at) }),
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

export async function getLocalSession(
  db: Kysely<Database>,
  token: string,
  now: string,
): Promise<StoredLocalSession | null> {
  const row = await db
    .selectFrom("local_session")
    .selectAll()
    .where("token", "=", token)
    .where("expires_at", ">", new Date(now))
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return row === undefined ? null : session(row);
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
