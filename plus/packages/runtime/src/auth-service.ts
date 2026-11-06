import { createHmac, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

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

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Verification runs on the async thread pool so failed logins cannot block
    // the event loop; hashing on account creation stays sync for seed scripts.
    scrypt(password, salt, PASSWORD_KEY_LENGTH, (error, key) => {
      if (error !== null) reject(error);
      else resolve(key);
    });
  });
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [salt, digest] = encoded.split(":");
  if (!salt || !digest || digest.length !== PASSWORD_KEY_LENGTH * 2) return false;
  const expected = Buffer.from(digest, "hex");
  const actual = await derivePassword(password, salt);
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
  if (account === null || !account.active || !(await verifyPassword(input.password, account.passwordDigest))) {
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

export function csrfTokenFor(sessionToken: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionToken}`).digest("hex");
}

export async function resolveLocalSession(
  db: Kysely<Database>,
  token: string,
  now: string,
) {
  return getLocalSession(db, token, now);
}

/**
 * Self-service participant account. The actor id is opaque; the username is the
 * login name, not a public identity.
 */
export async function registerParticipantAccount(
  db: Kysely<Database>,
  input: { readonly username: string; readonly password: string },
): Promise<{ readonly token: string; readonly actor: ActorContext; readonly expiresAt: string }> {
  const username = input.username.trim();
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    throw new DomainError("INVALID_INPUT", "Username must be 3-64 letters, numbers, dots, dashes, or underscores.");
  }
  if (input.password.length < 8 || input.password.length > 128) {
    throw new DomainError("INVALID_INPUT", "Password must be 8-128 characters.");
  }
  if ((await getLocalAccount(db, username)) !== null) {
    throw new DomainError("USERNAME_TAKEN", "This username is already registered.");
  }
  try {
    await createLocalAccount(db, {
      username,
      password: input.password,
      actor: {
        actorId: `participant:${randomUUID()}`,
        actorType: "user",
        roles: ["participant"],
        permissions: [],
      },
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505") {
      throw new DomainError("USERNAME_TAKEN", "This username is already registered.");
    }
    throw error;
  }
  return authenticateLocalAccount(db, { username, password: input.password });
}
