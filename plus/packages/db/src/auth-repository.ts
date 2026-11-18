import type { ActorContext, ActorType } from "@artflow-plus/domain";
import { sql, type Kysely, type Selectable, type SqlBool } from "kysely";

import { listOpenInviteUsernames } from "./account-invite-repository.js";
import type { Database, LocalAccountRow } from "./types.js";

export interface StoredLocalAccount {
  readonly username: string;
  readonly passwordDigest: string;
  readonly actor: ActorContext;
  readonly active: boolean;
  readonly email?: string;
  readonly mfaSecret?: string;
  readonly mfaEnabled?: boolean;
  readonly oidcIssuer?: string;
  readonly oidcSubject?: string;
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
    mfaEnabled: row.mfa_enabled,
    ...(row.email === null ? {} : { email: row.email }),
    ...(row.mfa_secret === null ? {} : { mfaSecret: row.mfa_secret }),
    ...(row.oidc_issuer === null ? {} : { oidcIssuer: row.oidc_issuer }),
    ...(row.oidc_subject === null ? {} : { oidcSubject: row.oidc_subject }),
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
      email: input.email ?? null,
      mfa_secret: input.mfaSecret ?? null,
      mfa_enabled: input.mfaEnabled ?? false,
      oidc_issuer: input.oidcIssuer ?? null,
      oidc_subject: input.oidcSubject ?? null,
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

/** Sliding expiry: only writes when the session is close enough to matter. */
export async function touchLocalSession(
  db: Kysely<Database>,
  token: string,
  expiresAt: string,
): Promise<void> {
  await db
    .updateTable("local_session")
    .set({ expires_at: expiresAt })
    .where("token", "=", token)
    .where("revoked_at", "is", null)
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
  readonly invited: boolean;
  readonly accessRevision: number;
  readonly createdAt: string;
  readonly email?: string;
  readonly mfaEnabled: boolean;
}

function summary(
  row: Selectable<LocalAccountRow>,
  invited = false,
): StoredLocalAccountSummary {
  return {
    username: row.username,
    actorId: row.actor_id,
    roles: jsonArray(row.roles),
    permissions: jsonArray(row.permissions),
    active: row.active,
    invited,
    accessRevision: row.access_revision,
    createdAt: iso(row.created_at),
    mfaEnabled: row.mfa_enabled,
    ...(row.email === null ? {} : { email: row.email }),
  };
}

export interface ListLocalAccountsOptions {
  readonly includeParticipants?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface LocalAccountPage {
  readonly accounts: readonly StoredLocalAccountSummary[];
  readonly total: number;
}

/**
 * Participant accounts share this table with the organizing team. The default
 * page excludes them so the team list stays bounded on a large deployment.
 */
export async function listLocalAccounts(
  db: Kysely<Database>,
  options: ListLocalAccountsOptions = {},
): Promise<LocalAccountPage> {
  const participants = sql<boolean>`roles = '["participant"]'::jsonb and permissions = '[]'::jsonb`;
  const base = db.selectFrom("local_account");
  const filtered = options.includeParticipants === true
    ? base
    : base.where(sql<boolean>`not (${participants})`);
  const totalRow = await filtered
    .select(sql<number>`count(*)::int`.as("count"))
    .executeTakeFirst();
  const rows = await filtered
    .selectAll()
    .orderBy("username")
    .limit(options.limit ?? 200)
    .offset(options.offset ?? 0)
    .execute();
  const invited = await listOpenInviteUsernames(
    db,
    rows.map((row) => row.username),
    new Date().toISOString(),
  );
  return {
    accounts: rows.map((row) => summary(row, invited.has(row.username))),
    total: Number(totalRow?.count ?? 0),
  };
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

export type LocalAccountUpdateResult =
  | { readonly ok: true; readonly account: StoredLocalAccountSummary }
  | { readonly ok: false; readonly reason: "not_found" | "stale" };

export async function updateLocalAccountAccess(
  db: Kysely<Database>,
  username: string,
  patch: LocalAccountAccessPatch,
  expectedRevision: number,
): Promise<LocalAccountUpdateResult> {
  const current = await getLocalAccountSummary(db, username);
  if (current === null) return { ok: false, reason: "not_found" };
  if (current.accessRevision !== expectedRevision) return { ok: false, reason: "stale" };

  const hasPatch = patch.roles !== undefined ||
    patch.permissions !== undefined ||
    patch.active !== undefined ||
    patch.passwordDigest !== undefined;
  if (!hasPatch) return { ok: true, account: current };

  const row = await db
    .updateTable("local_account")
    .set({
      ...(patch.roles === undefined ? {} : { roles: JSON.stringify(patch.roles) }),
      ...(patch.permissions === undefined ? {} : { permissions: JSON.stringify(patch.permissions) }),
      ...(patch.active === undefined ? {} : { active: patch.active }),
      ...(patch.passwordDigest === undefined ? {} : { password_digest: patch.passwordDigest }),
      access_revision: sql<number>`access_revision + 1`,
    })
    .where("username", "=", username)
    .where("access_revision", "=", expectedRevision)
    .returningAll()
    .executeTakeFirst();
  if (row !== undefined) return { ok: true, account: summary(row) };
  const after = await getLocalAccountSummary(db, username);
  return after === null
    ? { ok: false, reason: "not_found" }
    : { ok: false, reason: "stale" };
}

/** Counts other active administrators, treating `*` as every permission. */
export async function countActiveAccountManagers(
  db: Kysely<Database>,
  excludeUsername: string,
): Promise<number> {
  const row = await db
    .selectFrom("local_account")
    .select(sql<number>`count(*)::int`.as("count"))
    .where("active", "=", true)
    .where("username", "!=", excludeUsername)
    .where(sql<boolean>`(permissions @> '["account.manage"]'::jsonb or permissions @> '["*"]'::jsonb)`)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function getLocalAccountSummaryByActorId(
  db: Kysely<Database>,
  actorId: string,
): Promise<StoredLocalAccountSummary | null> {
  const row = await db
    .selectFrom("local_account")
    .selectAll()
    .where("actor_id", "=", actorId)
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

export async function getLocalAccountByIdentifier(
  db: Kysely<Database>,
  identifier: string,
): Promise<StoredLocalAccount | null> {
  const value = identifier.trim();
  if (value === "") return null;
  const row = await db
    .selectFrom("local_account")
    .selectAll()
    .where(sql<SqlBool>`(username = ${value} or lower(email) = ${value.toLowerCase()})`)
    .executeTakeFirst();
  return row === undefined ? null : account(row);
}

export async function getLocalAccountByOidc(
  db: Kysely<Database>,
  issuer: string,
  subject: string,
): Promise<StoredLocalAccount | null> {
  const row = await db
    .selectFrom("local_account")
    .selectAll()
    .where("oidc_issuer", "=", issuer)
    .where("oidc_subject", "=", subject)
    .executeTakeFirst();
  return row === undefined ? null : account(row);
}

export async function getLocalAccountByEmail(
  db: Kysely<Database>,
  email: string,
): Promise<StoredLocalAccount | null> {
  const row = await db
    .selectFrom("local_account")
    .selectAll()
    .where(sql<SqlBool>`lower(email) = ${email.trim().toLowerCase()}`)
    .executeTakeFirst();
  return row === undefined ? null : account(row);
}

export async function setLocalAccountMfa(
  db: Kysely<Database>,
  username: string,
  secret: string | null,
  enabled: boolean,
): Promise<void> {
  await db
    .updateTable("local_account")
    .set({ mfa_secret: secret, mfa_enabled: enabled })
    .where("username", "=", username)
    .execute();
}

export async function linkLocalAccountOidc(
  db: Kysely<Database>,
  username: string,
  issuer: string,
  subject: string,
): Promise<void> {
  await db
    .updateTable("local_account")
    .set({ oidc_issuer: issuer, oidc_subject: subject })
    .where("username", "=", username)
    .execute();
}

export async function updateLocalAccountPassword(
  trx: Kysely<Database>,
  actorId: string,
  passwordDigest: string,
): Promise<number> {
  const result = await trx
    .updateTable("local_account")
    .set({
      password_digest: passwordDigest,
      access_revision: sql`access_revision + 1`,
    })
    .where("actor_id", "=", actorId)
    .returning("access_revision")
    .executeTakeFirst();
  return result?.access_revision ?? 0;
}

export interface StoredPasswordResetToken {
  readonly digest: string;
  readonly actorId: string;
  readonly expiresAt: string;
}

export async function insertPasswordResetToken(
  trx: Kysely<Database>,
  token: StoredPasswordResetToken,
): Promise<void> {
  await trx
    .deleteFrom("password_reset_token")
    .where("actor_id", "=", token.actorId)
    .where("used_at", "is", null)
    .execute();
  await trx
    .insertInto("password_reset_token")
    .values({
      token_digest: token.digest,
      actor_id: token.actorId,
      expires_at: new Date(token.expiresAt),
      created_at: new Date(),
    })
    .execute();
}

/** Marks the token used and returns its actor. The caller owns the transaction. */
export async function consumePasswordResetToken(
  trx: Kysely<Database>,
  digest: string,
  now: Date,
): Promise<string | null> {
  const row = await trx
    .updateTable("password_reset_token")
    .set({ used_at: now })
    .where("token_digest", "=", digest)
    .where("used_at", "is", null)
    .where("expires_at", ">", now)
    .returning("actor_id")
    .executeTakeFirst();
  return row?.actor_id ?? null;
}

export async function getLocalAccountByActorId(
  db: Kysely<Database>,
  actorId: string,
): Promise<StoredLocalAccount | null> {
  const row = await db
    .selectFrom("local_account")
    .selectAll()
    .where("actor_id", "=", actorId)
    .executeTakeFirst();
  return row === undefined ? null : account(row);
}
