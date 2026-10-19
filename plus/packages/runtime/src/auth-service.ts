import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import {
  getLocalAccount,
  getLocalSession,
  insertLocalAccount,
  insertLocalSession,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

const PASSWORD_KEY_LENGTH = 64;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  if (!password) throw new DomainError("INVALID_INPUT", "Password cannot be empty.");
  const salt = randomBytes(16).toString("hex");
  const digest = scryptSync(password, salt, PASSWORD_KEY_LENGTH).toString("hex");
  return `${salt}:${digest}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [salt, digest] = encoded.split(":");
  if (!salt || !digest || digest.length !== PASSWORD_KEY_LENGTH * 2) return false;
  const expected = Buffer.from(digest, "hex");
  const actual = scryptSync(password, salt, PASSWORD_KEY_LENGTH);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function createLocalAccount(
  db: Kysely<Database>,
  input: { readonly username: string; readonly password: string; readonly actor: ActorContext },
): Promise<void> {
  if (!input.username.trim()) throw new DomainError("INVALID_INPUT", "Username cannot be empty.");
  await insertLocalAccount(db, {
    username: input.username.trim(),
    passwordDigest: hashPassword(input.password),
    actor: input.actor,
    active: true,
  });
}

export async function authenticateLocalAccount(
  db: Kysely<Database>,
  input: { readonly username: string; readonly password: string },
  now = new Date(),
): Promise<{ readonly token: string; readonly actor: ActorContext; readonly expiresAt: string }> {
  const account = await getLocalAccount(db, input.username.trim());
  if (account === null || !account.active || !verifyPassword(input.password, account.passwordDigest)) {
    throw new DomainError("UNAUTHENTICATED", "Invalid local credentials.");
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const actor = { ...account.actor, authContext: token };
  await insertLocalSession(db, { token, actor, expiresAt });
  return { token, actor, expiresAt };
}

export async function resolveActorFromBearer(
  db: Kysely<Database>,
  token: string | undefined,
  now = new Date(),
): Promise<ActorContext | null> {
  if (!token?.trim()) return null;
  const session = await getLocalSession(db, token.trim(), now.toISOString());
  return session?.actor ?? null;
}
