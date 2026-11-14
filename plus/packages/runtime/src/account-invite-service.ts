import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  claimAccountInvite,
  deleteOpenAccountInvite,
  getAccountInviteByDigest,
  getLocalAccountSummary,
  insertAudit,
  insertLocalAccount,
  replaceAccountInvite,
  revokeLocalSessionsForActor,
  updateLocalAccountAccess,
} from "@artflow-plus/db";
import type { Database, StoredLocalAccountSummary } from "@artflow-plus/db";
import { DomainError, requirePermission } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { ACCOUNT_MANAGE_PERMISSION } from "./account-admin-service.js";
import {
  authenticateLocalAccount,
  hashPasswordAsync,
  validateRegistrationPassword,
} from "./auth-service.js";

const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export interface CreateInviteInput {
  readonly username: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface InviteCreated {
  readonly account: StoredLocalAccountSummary;
  readonly token: string;
  readonly expiresAt: string;
}

export interface InvitePreview {
  readonly username: string;
  readonly expiresAt: string;
}

export interface ClaimInviteInput {
  readonly token: string;
  readonly password: string;
}

function digestFor(token: string): string {
  return createHash("sha256").update(`account-invite:${token}`).digest("hex");
}

function normalize(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function requireAccountManager(actor: ActorContext): void {
  requirePermission(actor, ACCOUNT_MANAGE_PERMISSION);
}

async function audit(
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

/**
 * Create (or re-create) an account that has no usable password yet. The raw
 * token is returned exactly once; only its digest is stored.
 */
export async function createAccountInvite(
  db: Kysely<Database>,
  actor: ActorContext,
  input: CreateInviteInput,
  now = new Date(),
): Promise<InviteCreated> {
  requireAccountManager(actor);
  const username = input.username.trim();
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    throw new DomainError("INVALID_INPUT", "Username must be 3-64 letters, numbers, dots, dashes, or underscores.");
  }
  const roles = normalize(input.roles);
  const permissions = normalize(input.permissions);
  const token = randomBytes(32).toString("base64url");
  const tokenDigest = digestFor(token);
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  const actorId = `user:${username}`;

  return db.transaction().execute(async (trx) => {
    const existing = await getLocalAccountSummary(trx, username);
    if (existing !== null && existing.active) {
      throw new DomainError(
        "ACCOUNT_ACTIVE",
        "This account is active; revoke its sessions or reset its password instead.",
      );
    }

    if (existing === null) {
      await insertLocalAccount(trx, {
        username,
        passwordDigest: "",
        actor: { actorId, actorType: "user", roles, permissions },
        active: false,
      });
    } else {
      const updated = await updateLocalAccountAccess(trx, username, {
        roles,
        permissions,
        active: false,
        passwordDigest: "",
      }, existing.accessRevision);
      if (!updated.ok) {
        throw new DomainError("INVITE_INVALID", "The account changed while the invitation was created.");
      }
      await revokeLocalSessionsForActor(trx, existing.actorId, now.toISOString());
    }

    await replaceAccountInvite(trx, {
      id: `invite-${randomUUID()}`,
      username,
      tokenDigest,
      expiresAt,
      issuedBy: actor.actorId,
    });
    const account = await getLocalAccountSummary(trx, username);
    if (account === null) throw new Error("The invited account did not produce a row.");
    await audit(trx, actor, "account.invite", {
      username,
      roles,
      permissions,
      expiresAt,
    });
    return { account: { ...account, invited: true }, token, expiresAt };
  });
}

export async function previewInvite(
  db: Kysely<Database>,
  token: string,
): Promise<InvitePreview> {
  if (token.trim() === "") throw new DomainError("INVITE_INVALID", "The invitation is invalid.");
  const invite = await getAccountInviteByDigest(db, digestFor(token.trim()));
  if (invite === null) throw new DomainError("INVITE_INVALID", "The invitation is invalid.");
  if (invite.claimedAt !== undefined) {
    throw new DomainError("INVITE_CLAIMED", "This invitation has already been used.");
  }
  if (new Date(invite.expiresAt).getTime() <= Date.now()) {
    throw new DomainError("INVITE_EXPIRED", "This invitation has expired.");
  }
  return { username: invite.username, expiresAt: invite.expiresAt };
}

export async function claimInvite(
  db: Kysely<Database>,
  input: ClaimInviteInput,
  now = new Date(),
): Promise<{
  readonly token: string;
  readonly actor: ActorContext;
  readonly expiresAt: string;
}> {
  const raw = input.token.trim();
  if (raw === "") throw new DomainError("INVITE_INVALID", "The invitation is invalid.");
  const invite = await getAccountInviteByDigest(db, digestFor(raw));
  if (invite === null) throw new DomainError("INVITE_INVALID", "The invitation is invalid.");
  if (invite.claimedAt !== undefined) {
    throw new DomainError("INVITE_CLAIMED", "This invitation has already been used.");
  }
  if (new Date(invite.expiresAt).getTime() <= now.getTime()) {
    throw new DomainError("INVITE_EXPIRED", "This invitation has expired.");
  }
  validateRegistrationPassword(input.password, invite.username);
  const passwordDigest = await hashPasswordAsync(input.password);

  await db.transaction().execute(async (trx) => {
    const claimed = await claimAccountInvite(trx, invite.id, now.toISOString());
    if (claimed === null) {
      throw new DomainError("INVITE_CLAIMED", "This invitation has already been used.");
    }
    const account = await getLocalAccountSummary(trx, invite.username);
    if (account === null) throw new DomainError("INVITE_INVALID", "The invitation is invalid.");
    const updated = await updateLocalAccountAccess(trx, invite.username, {
      passwordDigest,
      active: true,
    }, account.accessRevision);
    if (!updated.ok) {
      throw new DomainError("INVITE_INVALID", "The account changed while the invitation was claimed.");
    }
    // A re-invited former account may still hold old sessions.
    await revokeLocalSessionsForActor(trx, account.actorId, now.toISOString());
    await audit(trx, {
      actorId: account.actorId,
      actorType: "user",
      roles: account.roles,
      permissions: account.permissions,
    }, "account.claim", { username: invite.username });
  });

  return authenticateLocalAccount(db, {
    username: invite.username,
    password: input.password,
  }, now);
}

export async function revokeAccountInvite(
  db: Kysely<Database>,
  actor: ActorContext,
  username: string,
): Promise<{ readonly revoked: number }> {
  requireAccountManager(actor);
  const trimmed = username.trim();
  return db.transaction().execute(async (trx) => {
    const revoked = await deleteOpenAccountInvite(trx, trimmed);
    if (revoked === 0) {
      throw new DomainError("INVITE_INVALID", "There is no open invitation for this account.");
    }
    await audit(trx, actor, "account.invite.revoke", { username: trimmed });
    return { revoked };
  });
}
