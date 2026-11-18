import { createHash, createHmac, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

import {
  consumePasswordResetToken,
  getLocalAccount,
  getLocalAccountByActorId,
  getLocalAccountByIdentifier,
  getLocalSessionWithAccount,
  insertLocalAccount,
  insertLocalSession,
  insertPasswordResetToken,
  revokeLocalSessionsForActor,
  setLocalAccountMfa,
  touchLocalSession,
  updateLocalAccountPassword,
} from "@artflow-plus/db";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";
import type { Mailer } from "./mail-service.js";
import type { Database } from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

const PASSWORD_KEY_LENGTH = 64;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

function credentialSecret(): string {
  const secret = process.env.ARTFLOW_PLUS_CREDENTIAL_SECRET;
  if (secret !== undefined && secret.trim() !== "") return secret;
  const production = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
  if (production) throw new Error("ARTFLOW_PLUS_CREDENTIAL_SECRET is required in production.");
  return "artflow-plus-development-secret";
}

export function sealValue(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", credentialSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function openValue<T>(value: string, now: Date): T | null {
  const [body, signature] = value.split(".");
  if (body === undefined || signature === undefined) return null;
  const expected = createHmac("sha256", credentialSecret()).update(body).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (typeof payload.exp !== "number" || payload.exp <= now.getTime()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email === "") return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new DomainError("INVALID_INPUT", "Email address is invalid.");
  }
  return email;
}

export function hashPassword(password: string): string {
  if (!password) throw new DomainError("INVALID_INPUT", "Password cannot be empty.");
  const salt = randomBytes(16).toString("hex");
  const digest = scryptSync(password, salt, PASSWORD_KEY_LENGTH).toString("hex");
  return `${salt}:${digest}`;
}

/** Async variant for live requests; never block the event loop while hashing. */
export function hashPasswordAsync(password: string): Promise<string> {
  if (!password) {
    return Promise.reject(new DomainError("INVALID_INPUT", "Password cannot be empty."));
  }
  const salt = randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    scrypt(password, salt, PASSWORD_KEY_LENGTH, (error, key) => {
      if (error !== null) reject(error);
      else resolve(`${salt}:${key.toString("hex")}`);
    });
  });
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
  input: {
    readonly username: string;
    readonly password: string;
    readonly actor: ActorContext;
    readonly email?: string;
  },
): Promise<void> {
  if (!input.username.trim()) throw new DomainError("INVALID_INPUT", "Username cannot be empty.");
  await insertLocalAccount(db, {
    username: input.username.trim(),
    passwordDigest: hashPassword(input.password),
    actor: input.actor,
    active: true,
    ...(input.email === undefined ? {} : { email: input.email }),
  });
}

export interface IssuedSession {
  readonly token: string;
  readonly actor: ActorContext;
  readonly expiresAt: string;
}

export type LocalLoginResult =
  | ({ readonly kind: "session" } & IssuedSession)
  | { readonly kind: "mfa"; readonly challenge: string };

export async function issueSessionForAccount(
  db: Kysely<Database>,
  account: { readonly actor: ActorContext },
  now: Date,
): Promise<IssuedSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const actor = { ...account.actor, authContext: token };
  await insertLocalSession(db, { token, actor, expiresAt });
  return { token, actor, expiresAt };
}

export async function authenticateLocalAccount(
  db: Kysely<Database>,
  input: { readonly username: string; readonly password: string; readonly mfaCode?: string },
  now = new Date(),
): Promise<LocalLoginResult> {
  const account = await getLocalAccountByIdentifier(db, input.username);
  if (account === null || !account.active || !(await verifyPassword(input.password, account.passwordDigest))) {
    throw new DomainError("UNAUTHENTICATED", "Invalid local credentials.");
  }
  if (account.mfaEnabled) {
    if (input.mfaCode === undefined || input.mfaCode.trim() === "") {
      return {
        kind: "mfa",
        challenge: sealValue({
          purpose: "mfa-login",
          username: account.username,
          exp: now.getTime() + MFA_CHALLENGE_TTL_MS,
        }),
      };
    }
    if (account.mfaSecret === undefined || !verifyTotp(account.mfaSecret, input.mfaCode, now.getTime())) {
      throw new DomainError("MFA_INVALID", "The verification code is invalid.");
    }
  }
  return { kind: "session", ...(await issueSessionForAccount(db, account, now)) };
}

export async function completeMfaLogin(
  db: Kysely<Database>,
  input: { readonly challenge: string; readonly code: string },
  now = new Date(),
): Promise<IssuedSession> {
  const payload = openValue<{ purpose: string; username: string; exp: number }>(input.challenge, now);
  if (payload === null || payload.purpose !== "mfa-login") {
    throw new DomainError("MFA_CHALLENGE_INVALID", "The login challenge is invalid or expired.");
  }
  const account = await getLocalAccount(db, payload.username);
  if (account === null || !account.active || !account.mfaEnabled || account.mfaSecret === undefined) {
    throw new DomainError("MFA_CHALLENGE_INVALID", "The login challenge is no longer valid.");
  }
  if (!verifyTotp(account.mfaSecret, input.code, now.getTime())) {
    throw new DomainError("MFA_INVALID", "The verification code is invalid.");
  }
  return await issueSessionForAccount(db, account, now);
}

export async function beginMfaEnrollment(
  db: Kysely<Database>,
  actor: ActorContext,
  issuer = "ArtFlow",
): Promise<{ readonly secret: string; readonly otpauthUrl: string }> {
  const account = await getLocalAccountByActorId(db, actor.actorId);
  if (account === null || !account.active) throw new DomainError("UNAUTHENTICATED", "A valid account is required.");
  if (account.mfaEnabled) {
    throw new DomainError("MFA_ALREADY_ENABLED", "Disable the current two-factor method before enrolling again.");
  }
  const secret = generateTotpSecret();
  await setLocalAccountMfa(db, account.username, secret, false);
  return { secret, otpauthUrl: otpauthUrl(issuer, account.username, secret) };
}

export async function confirmMfaEnrollment(
  db: Kysely<Database>,
  actor: ActorContext,
  code: string,
  now = new Date(),
): Promise<void> {
  const account = await getLocalAccountByActorId(db, actor.actorId);
  if (account === null || !account.active || account.mfaSecret === undefined) {
    throw new DomainError("MFA_NOT_PENDING", "Start MFA enrollment first.");
  }
  if (!verifyTotp(account.mfaSecret, code, now.getTime())) {
    throw new DomainError("MFA_INVALID", "The verification code is invalid.");
  }
  await setLocalAccountMfa(db, account.username, account.mfaSecret, true);
}

export async function disableMfa(
  db: Kysely<Database>,
  actor: ActorContext,
  input: { readonly password: string; readonly code: string },
  now = new Date(),
): Promise<void> {
  const account = await getLocalAccountByActorId(db, actor.actorId);
  if (account === null || !account.active || !(await verifyPassword(input.password, account.passwordDigest))) {
    throw new DomainError("UNAUTHENTICATED", "Invalid credentials.");
  }
  if (account.mfaSecret === undefined || !verifyTotp(account.mfaSecret, input.code, now.getTime())) {
    throw new DomainError("MFA_INVALID", "The verification code is invalid.");
  }
  await setLocalAccountMfa(db, account.username, null, false);
}

export async function resetAccountMfa(
  db: Kysely<Database>,
  username: string,
): Promise<void> {
  await setLocalAccountMfa(db, username, null, false);
}

export async function resolveActorFromBearer(
  db: Kysely<Database>,
  token: string | undefined,
  now = new Date(),
): Promise<ActorContext | null> {
  if (!token?.trim()) return null;
  // Resolve the account on every request: the session snapshot must never
  // outlive an account change made by an administrator.
  const session = await getLocalSessionWithAccount(db, token.trim(), now.toISOString());
  if (session !== null) {
    const remaining = Date.parse(session.expiresAt) - now.getTime();
    if (remaining < SESSION_TTL_MS / 2) {
      // An event day runs longer than one fixed window. Refresh only in the
      // second half of the session so ordinary requests do not write.
      await touchLocalSession(
        db,
        session.token,
        new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      ).catch(() => undefined);
    }
  }
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
  const session = await getLocalSessionWithAccount(db, token, now);
  if (session !== null) {
    const current = Date.parse(now);
    const remaining = Date.parse(session.expiresAt) - current;
    if (remaining < SESSION_TTL_MS / 2) {
      await touchLocalSession(
        db,
        session.token,
        new Date(current + SESSION_TTL_MS).toISOString(),
      ).catch(() => undefined);
    }
  }
  return session;
}

/**
 * Self-service participant account. The actor id is opaque; the username is the
 * login name, not a public identity.
 */
// Registration is the only self-service way to create an account, so the
// policy lives here rather than in the HTTP schema: direct callers must not be
// able to bypass it. Length alone is not enough for the most common choices.
const COMMON_REGISTRATION_PASSWORDS = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "password1234",
  "password12345",
  "qwertyuiop12",
  "123456789012",
  "111111111111",
  "letmein12345",
  "iloveyou1234",
  "welcome12345",
  "admin1234567",
  "abc123456789",
]);

export function validateRegistrationPassword(password: string, username: string): void {
  if (password.length < 12 || password.length > 128) {
    throw new DomainError("INVALID_INPUT", "Password must be 12-128 characters.");
  }
  const normalized = password.trim().toLowerCase();
  if (normalized === username.trim().toLowerCase()) {
    throw new DomainError("INVALID_INPUT", "Password must not be the username.");
  }
  if (COMMON_REGISTRATION_PASSWORDS.has(normalized)) {
    throw new DomainError("INVALID_INPUT", "Password is too common.");
  }
}

export async function registerParticipantAccount(
  db: Kysely<Database>,
  input: { readonly username: string; readonly password: string; readonly email?: string },
): Promise<IssuedSession> {
  const username = input.username.trim();
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    throw new DomainError("INVALID_INPUT", "Username must be 3-64 letters, numbers, dots, dashes, or underscores.");
  }
  validateRegistrationPassword(input.password, username);
  const email = input.email === undefined ? undefined : normalizeEmail(input.email) ?? undefined;
  if ((await getLocalAccount(db, username)) !== null) {
    throw new DomainError("USERNAME_TAKEN", "This username is already registered.");
  }
  try {
    await createLocalAccount(db, {
      username,
      password: input.password,
      ...(email === undefined ? {} : { email }),
      actor: {
        actorId: `participant:${randomUUID()}`,
        actorType: "user",
        roles: ["participant"],
        permissions: [],
      },
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505") {
      throw new DomainError("USERNAME_TAKEN", "This username or email is already registered.");
    }
    throw error;
  }
  const account = await getLocalAccount(db, username);
  if (account === null) throw new DomainError("UNAUTHENTICATED", "The account was not created.");
  return await issueSessionForAccount(db, account, new Date());
}

export async function requestPasswordReset(
  db: Kysely<Database>,
  mailer: Mailer | null,
  input: {
    readonly identifier: string;
    readonly appBaseUrl: string;
    readonly now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const account = await getLocalAccountByIdentifier(db, input.identifier);
  // Never reveal whether the identifier exists or has an email.
  if (account === null || !account.active || account.email === undefined || mailer === null) return;
  const token = randomBytes(32).toString("base64url");
  const digest = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS).toISOString();
  await db.transaction().execute(async (trx) => {
    await insertPasswordResetToken(trx, { digest, actorId: account.actor.actorId, expiresAt });
  });
  const base = input.appBaseUrl.replace(/\/+$/, "");
  await mailer.sendPasswordReset({
    to: account.email,
    username: account.username,
    resetUrl: `${base}/reset#${token}`,
    expiresAt,
  }).catch(() => undefined);
}

export async function resetPasswordWithToken(
  db: Kysely<Database>,
  input: { readonly token: string; readonly password: string; readonly now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const digest = createHash("sha256").update(input.token.trim()).digest("hex");
  await db.transaction().execute(async (trx) => {
    const actorId = await consumePasswordResetToken(trx, digest, now);
    if (actorId === null) {
      throw new DomainError("RESET_TOKEN_INVALID", "The reset link is invalid or expired.");
    }
    const account = await getLocalAccountByActorId(trx, actorId);
    if (account === null || !account.active) {
      throw new DomainError("RESET_TOKEN_INVALID", "The account is not available.");
    }
    validateRegistrationPassword(input.password, account.username);
    await updateLocalAccountPassword(trx, actorId, hashPassword(input.password));
    await revokeLocalSessionsForActor(trx, actorId, now.toISOString());
  });
}
