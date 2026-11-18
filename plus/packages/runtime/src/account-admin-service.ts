import { randomUUID } from "node:crypto";

import {
  countActiveAccountManagers,
  getLocalAccountSummary,
  insertAudit,
  insertLocalAccount,
  listLocalAccounts,
  revokeLocalSessionsForActor,
  setLocalAccountMfa,
  updateLocalAccountAccess,
} from "@artflow-plus/db";
import type {
  Database,
  ListLocalAccountsOptions,
  LocalAccountPage,
  StoredLocalAccountSummary,
} from "@artflow-plus/db";
import { DomainError, requirePermission } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { hashPasswordAsync, normalizeEmail } from "./auth-service.js";

/** Only this permission may read or mutate the account registry. */
export const ACCOUNT_MANAGE_PERMISSION = "account.manage";

export interface CreateAccountInput {
  readonly username: string;
  readonly password: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly email?: string;
}

export interface UpdateAccountInput {
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
  readonly active?: boolean;
  readonly password?: string;
  readonly email?: string;
  readonly resetMfa?: boolean;
  readonly expectedRevision: number;
}

function requireAccountManager(actor: ActorContext): void {
  requirePermission(actor, ACCOUNT_MANAGE_PERMISSION);
}

/** `*` is every permission, including account administration. */
function canAdminister(permissions: readonly string[]): boolean {
  return permissions.includes("*") || permissions.includes(ACCOUNT_MANAGE_PERMISSION);
}

function normalize(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

async function writeAccountAudit(
  trx: Kysely<Database>,
  actor: ActorContext,
  commandType: string,
  detail: unknown,
): Promise<void> {
  await insertAudit(trx, {
    commandId: `admin:${randomUUID()}`,
    activityId: null,
    capability: "account",
    commandType,
    actor,
    detail,
  });
}

export async function listAccounts(
  db: Kysely<Database>,
  actor: ActorContext,
  options: ListLocalAccountsOptions = {},
): Promise<LocalAccountPage> {
  requireAccountManager(actor);
  return listLocalAccounts(db, options);
}

export async function createAccount(
  db: Kysely<Database>,
  actor: ActorContext,
  input: CreateAccountInput,
): Promise<StoredLocalAccountSummary> {
  requireAccountManager(actor);
  const username = input.username.trim();
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    throw new DomainError("INVALID_INPUT", "Username must be 3-64 letters, numbers, dots, dashes, or underscores.");
  }
  if (input.password.length < 8) {
    throw new DomainError("INVALID_INPUT", "Password must be at least 8 characters.");
  }
  const roles = normalize(input.roles);
  const permissions = normalize(input.permissions);
  const actorId = `user:${username}`;
  // Hash before the transaction: scrypt is CPU work and must not hold a
  // database connection or row locks.
  const passwordDigest = await hashPasswordAsync(input.password);
  const email = input.email === undefined ? undefined : normalizeEmail(input.email) ?? undefined;

  try {
    return await db.transaction().execute(async (trx) => {
      await insertLocalAccount(trx, {
        username,
        passwordDigest,
        actor: { actorId, actorType: "user", roles, permissions },
        active: true,
        ...(email === undefined ? {} : { email }),
      });
      const created = await getLocalAccountSummary(trx, username);
      if (created === null) throw new Error("The account insert did not produce a row.");
      await writeAccountAudit(trx, actor, "account.create", { username, roles, permissions, ...(email === undefined ? {} : { email }) });
      return created;
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505") {
      throw new DomainError("USERNAME_TAKEN", "This username is already registered.");
    }
    throw error;
  }
}

export async function updateAccount(
  db: Kysely<Database>,
  actor: ActorContext,
  username: string,
  input: UpdateAccountInput,
): Promise<StoredLocalAccountSummary> {
  requireAccountManager(actor);
  const trimmed = username.trim();
  if (input.password !== undefined && input.password.length < 8) {
    throw new DomainError("INVALID_INPUT", "Password must be at least 8 characters.");
  }
  const passwordDigest = input.password === undefined
    ? undefined
    : await hashPasswordAsync(input.password);
  const email = input.email === undefined ? undefined : normalizeEmail(input.email) ?? undefined;

  return db.transaction().execute(async (trx) => {
    const current = await getLocalAccountSummary(trx, trimmed);
    if (current === null) throw new DomainError("NOT_FOUND", `Account ${trimmed} was not found.`);
    if (current.accessRevision !== input.expectedRevision) {
      throw new DomainError("STALE_REVISION", "The account changed since it was read.");
    }

    const nextRoles = input.roles === undefined ? current.roles : normalize(input.roles);
    const nextPermissions = input.permissions === undefined ? current.permissions : normalize(input.permissions);
    const nextActive = input.active ?? current.active;

    // Losing the last administrator would make the registry unmanageable.
    if (current.active && canAdminister(current.permissions)) {
      const losesAdministration = !nextActive || !canAdminister(nextPermissions);
      if (losesAdministration) {
        // Serialize administrator removals: two concurrent downgrades must not
        // both observe a surviving admin and leave the registry unmanageable.
        await trx.selectFrom("local_account").select("username").forUpdate().execute();
        const remaining = await countActiveAccountManagers(trx, trimmed);
        if (remaining === 0) {
          throw new DomainError(
            "LAST_ADMIN",
            "At least one active account must keep account.manage.",
          );
        }
      }
    }

    const result = await updateLocalAccountAccess(trx, trimmed, {
      roles: nextRoles,
      permissions: nextPermissions,
      active: nextActive,
      ...(passwordDigest === undefined ? {} : { passwordDigest }),
    }, input.expectedRevision);
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new DomainError("NOT_FOUND", `Account ${trimmed} was not found.`);
      }
      throw new DomainError("STALE_REVISION", "The account changed since it was read.");
    }
    const updated = result.account;
    if (email !== undefined) {
      try {
        await trx
          .updateTable("local_account")
          .set({ email })
          .where("username", "=", trimmed)
          .execute();
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505") {
          throw new DomainError("EMAIL_TAKEN", "This email is already registered.");
        }
        throw error;
      }
    }
    if (input.resetMfa === true) {
      await setLocalAccountMfa(trx, trimmed, null, false);
    }

    // Deactivation and password resets invalidate every device immediately.
    // Permission edits do not need this: authorization reads the account.
    const sessionsRevoked = !nextActive || passwordDigest !== undefined;
    if (sessionsRevoked) {
      await revokeLocalSessionsForActor(trx, current.actorId, new Date().toISOString());
    }

    await writeAccountAudit(trx, actor, "account.update", {
      username: trimmed,
      before: {
        roles: current.roles,
        permissions: current.permissions,
        active: current.active,
        accessRevision: current.accessRevision,
      },
      after: {
        roles: updated.roles,
        permissions: updated.permissions,
        active: updated.active,
        accessRevision: updated.accessRevision,
      },
      passwordChanged: passwordDigest !== undefined,
      ...(email === undefined ? {} : { email }),
      ...(input.resetMfa === true ? { mfaReset: true } : {}),
      sessionsRevoked,
    });
    return updated;
  });
}

export async function revokeAccountSessions(
  db: Kysely<Database>,
  actor: ActorContext,
  username: string,
): Promise<{ readonly revoked: number }> {
  requireAccountManager(actor);
  const trimmed = username.trim();

  return db.transaction().execute(async (trx) => {
    const account = await getLocalAccountSummary(trx, trimmed);
    if (account === null) throw new DomainError("NOT_FOUND", `Account ${trimmed} was not found.`);
    const revoked = await revokeLocalSessionsForActor(trx, account.actorId, new Date().toISOString());
    await writeAccountAudit(trx, actor, "account.revoke_sessions", { username: trimmed, revoked });
    return { revoked };
  });
}
