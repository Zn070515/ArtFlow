import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Database } from "@artflow-plus/db";
import {
  getLocalAccount,
  getLocalAccountByEmail,
  getLocalAccountByOidc,
  linkLocalAccountOidc,
} from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Kysely } from "kysely";

import { createLocalAccount, openValue, sealValue, type IssuedSession, issueSessionForAccount } from "./auth-service.js";

export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes: string;
  readonly clientAuth: "post" | "basic";
  readonly autoProvision: boolean;
  readonly label: string;
}

export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = env.ARTFLOW_PLUS_OIDC_ISSUER?.trim();
  const clientId = env.ARTFLOW_PLUS_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.ARTFLOW_PLUS_OIDC_CLIENT_SECRET?.trim();
  const redirectUri = env.ARTFLOW_PLUS_OIDC_REDIRECT_URI?.trim();
  if (!issuer || !clientId || !clientSecret || !redirectUri) return null;
  return {
    issuer: issuer.replace(/\/+$/, ""),
    clientId,
    clientSecret,
    redirectUri,
    scopes: env.ARTFLOW_PLUS_OIDC_SCOPES?.trim() || "openid email profile",
    clientAuth: env.ARTFLOW_PLUS_OIDC_CLIENT_AUTH === "basic" ? "basic" : "post",
    autoProvision: env.ARTFLOW_PLUS_OIDC_AUTO_PROVISION === "1",
    label: env.ARTFLOW_PLUS_OIDC_LABEL?.trim() || "统一身份登录",
  };
}

interface Discovery {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
}

const discoveryCache = new Map<string, Discovery>();

async function discover(issuer: string): Promise<Discovery> {
  const cached = discoveryCache.get(issuer);
  if (cached !== undefined) return cached;
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new DomainError("OIDC_UNAVAILABLE", "The identity provider discovery document is unavailable.");
  const body = (await response.json()) as Partial<Discovery>;
  if (
    typeof body.authorization_endpoint !== "string" ||
    typeof body.token_endpoint !== "string" ||
    typeof body.jwks_uri !== "string"
  ) {
    throw new DomainError("OIDC_UNAVAILABLE", "The identity provider discovery document is incomplete.");
  }
  const result = {
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    jwks_uri: body.jwks_uri,
  };
  discoveryCache.set(issuer, result);
  return result;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export interface OidcStart {
  readonly authorizationUrl: string;
  readonly cookie: string;
}

export async function beginOidcLogin(
  config: OidcConfig,
  now = new Date(),
): Promise<OidcStart> {
  const metadata = await discover(config.issuer);
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const cookie = sealValue({
    purpose: "oidc",
    state,
    nonce,
    verifier,
    exp: now.getTime() + 10 * 60 * 1000,
  });
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return { authorizationUrl: url.toString(), cookie };
}

export interface OidcClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly name?: string;
}

export async function completeOidcLogin(
  config: OidcConfig,
  input: { readonly code: string; readonly state: string; readonly cookie: string | undefined },
  now = new Date(),
): Promise<OidcClaims> {
  if (input.cookie === undefined) throw new DomainError("OIDC_STATE_INVALID", "The login state is missing.");
  const state = openValue<{ purpose: string; state: string; nonce: string; verifier: string; exp: number }>(
    input.cookie,
    now,
  );
  if (state === null || state.purpose !== "oidc" || state.state !== input.state) {
    throw new DomainError("OIDC_STATE_INVALID", "The login state is invalid or expired.");
  }
  const metadata = await discover(config.issuer);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: config.redirectUri,
    code_verifier: state.verifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (config.clientAuth === "basic") {
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", config.clientId);
    body.set("client_secret", config.clientSecret);
  }
  const tokenResponse = await fetch(metadata.token_endpoint, { method: "POST", headers, body });
  if (!tokenResponse.ok) throw new DomainError("OIDC_TOKEN_INVALID", "The identity provider rejected the login.");
  const tokens = (await tokenResponse.json()) as { id_token?: unknown };
  if (typeof tokens.id_token !== "string") {
    throw new DomainError("OIDC_TOKEN_INVALID", "The identity provider did not return an ID token.");
  }
  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
  const verified = await jwtVerify(tokens.id_token, jwks, {
    issuer: config.issuer,
    audience: config.clientId,
  });
  if (verified.payload.nonce !== state.nonce) {
    throw new DomainError("OIDC_TOKEN_INVALID", "The ID token nonce does not match.");
  }
  const subject = verified.payload.sub;
  if (typeof subject !== "string" || subject === "") {
    throw new DomainError("OIDC_TOKEN_INVALID", "The ID token has no subject.");
  }
  const email = typeof verified.payload.email === "string" ? verified.payload.email : undefined;
  return {
    issuer: config.issuer,
    subject,
    emailVerified: verified.payload.email_verified === true,
    ...(email === undefined ? {} : { email }),
    ...(typeof verified.payload.name === "string" ? { name: verified.payload.name } : {}),
  };
}

async function uniqueUsername(db: Kysely<Database>, seed: string): Promise<string> {
  const base = seed
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 48) || `oidc-${randomUUID().slice(0, 8)}`;
  const candidate = base.length >= 3 ? base : `${base}-user`;
  if ((await getLocalAccount(db, candidate)) === null) return candidate;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const next = `${candidate.slice(0, 56)}-${randomUUID().slice(0, 6)}`;
    if ((await getLocalAccount(db, next)) === null) return next;
  }
  throw new DomainError("USERNAME_TAKEN", "Could not allocate a username for the federated account.");
}

/**
 * Links an existing account by verified email, or provisions a participant
 * when the deployment explicitly allows it. Staff rights are never granted by
 * an IdP claim; an administrator must assign them afterwards.
 */
export async function resolveOidcAccount(
  db: Kysely<Database>,
  config: OidcConfig,
  claims: OidcClaims,
): Promise<{ readonly username: string }> {
  const linked = await getLocalAccountByOidc(db, claims.issuer, claims.subject);
  if (linked !== null) return { username: linked.username };

  if (claims.email !== undefined && claims.emailVerified) {
    const byEmail = await getLocalAccountByEmail(db, claims.email);
    if (byEmail !== null) {
      await linkLocalAccountOidc(db, byEmail.username, claims.issuer, claims.subject);
      return { username: byEmail.username };
    }
  }

  if (!config.autoProvision) {
    throw new DomainError(
      "OIDC_ACCOUNT_NOT_LINKED",
      "No ArtFlow account is linked to this identity. Ask an organizer to link it first.",
    );
  }
  const verifiedEmail = claims.emailVerified ? claims.email : undefined;
  const username = await uniqueUsername(db, verifiedEmail?.split("@")[0] ?? claims.name ?? "oidc");
  await createLocalAccount(db, {
    username,
    password: randomBytes(32).toString("base64url"),
    ...(verifiedEmail === undefined ? {} : { email: verifiedEmail.toLowerCase() }),
    actor: {
      actorId: `participant:${randomUUID()}`,
      actorType: "user",
      roles: ["participant"],
      permissions: [],
    },
  });
  await linkLocalAccountOidc(db, username, claims.issuer, claims.subject);
  return { username };
}

export async function issueOidcSession(
  db: Kysely<Database>,
  username: string,
  now = new Date(),
): Promise<IssuedSession> {
  const account = await getLocalAccount(db, username);
  if (account === null || !account.active) {
    throw new DomainError("OIDC_ACCOUNT_NOT_LINKED", "The linked ArtFlow account is not active.");
  }
  return await issueSessionForAccount(db, account, now);
}
