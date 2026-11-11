import { createHmac, timingSafeEqual } from "node:crypto";

import type { Database } from "@artflow-plus/db";
import { getRelease } from "@artflow-plus/db";
import { decodeVotingArtifact, DomainError, type requirePermission } from "@artflow-plus/domain";
import type { CompiledVotingArtifact } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import type { RuntimeDeps } from "./deps.js";

export const DEFAULT_TICKET_TTL_MS = 8 * 60 * 60 * 1000;

export type CredentialKind = "T" | "J";

export interface ParsedCredential {
  readonly kind: CredentialKind;
  readonly publicCode: string;
  readonly version: number;
  readonly signature: string;
}

export function secret(deps: RuntimeDeps): string {
  const value = deps.credentialSecret;
  if (value === undefined || value.length < 16) {
    throw new DomainError("INVALID_INPUT", "A credential signing secret is not configured.");
  }
  return value;
}

export function signature(kind: CredentialKind, publicCode: string, version: number, signingSecret: string): string {
  return createHmac("sha256", signingSecret)
    .update(`AF1.${kind}.${publicCode}.${version}`)
    .digest("hex")
    .slice(0, 32);
}

export function credential(kind: CredentialKind, publicCode: string, version: number, signingSecret: string): string {
  return `AF1.${kind}.${publicCode}.${version}.${signature(kind, publicCode, version, signingSecret)}`;
}

export function ticketAccessToken(sessionId: string, signingSecret: string): string {
  const tokenSignature = createHmac("sha256", signingSecret)
    .update(`AF1.S.${sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return `AF1.S.${sessionId}.${tokenSignature}`;
}

/**
 * Judge-session tokens are deterministic from the session id and the server
 * secret. The raw token is never persisted, but a replay can rebuild the same
 * token after the first response is lost.
 */
export function judgeSessionToken(sessionId: string, signingSecret: string): string {
  const tokenSignature = createHmac("sha256", signingSecret)
    .update(`AF1.JS.${sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return `AF1.JS.${sessionId}.${tokenSignature}`;
}

export function parseCredential(raw: unknown, kind: CredentialKind, signingSecret: string): ParsedCredential | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(".");
  if (parts.length !== 5 || parts[0] !== "AF1" || parts[1] !== kind) return null;
  const publicCode = parts[2];
  const versionText = parts[3];
  const provided = parts[4];
  if (publicCode === undefined || versionText === undefined || provided === undefined || !/^\d+$/.test(versionText)) return null;
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 1 || !/^[a-f0-9]{32}$/.test(provided)) return null;
  const expected = signature(kind, publicCode, version, signingSecret);
  const expectedBytes = Buffer.from(expected, "ascii");
  const providedBytes = Buffer.from(provided, "ascii");
  if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) return null;
  return { kind, publicCode, version, signature: provided };
}

export function validCredentialForRow(
  raw: string,
  kind: CredentialKind,
  publicCode: string,
  version: number,
  signingSecret: string,
): boolean {
  const parsed = parseCredential(raw, kind, signingSecret);
  return parsed !== null && parsed.publicCode === publicCode && parsed.version === version;
}

export function requireActive(activity: { readonly status: string }, label: string): void {
  if (activity.status !== "active") throw new DomainError("ACTIVITY_NOT_ACTIVE", `${label} requires an active activity.`);
}

/**
 * Archived is the terminal state: an archived activity may not produce or
 * mutate credentials. `closed` is deliberately left available for incident
 * revocation, but it can never issue, rotate, or reissue.
 */
export function requireNotArchived(activity: { readonly status: string }, label: string): void {
  if (activity.status === "archived") {
    throw new DomainError("ACTIVITY_ARCHIVED", `${label} is not allowed on an archived activity.`);
  }
}

export function requireReason(value: string): string {
  const reason = value.trim();
  if (!reason) throw new DomainError("INVALID_INPUT", "A reason is required.");
  return reason;
}

export function requireCapability(activity: { readonly enabledCapabilities: readonly string[] }, key: string): void {
  if (!activity.enabledCapabilities.includes(key)) throw new DomainError("CAPABILITY_NOT_ENABLED", `Capability ${key} is not enabled on this activity.`);
}

export function requireAnyPermission(actor: Parameters<typeof requirePermission>[0], permissions: readonly string[]): void {
  if (actor.permissions.includes("*") || permissions.some((permission) => actor.permissions.includes(permission))) return;
  throw new DomainError("FORBIDDEN", `One of ${permissions.join(", ")} is required.`);
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

export async function votingArtifact(
  trx: Kysely<Database>,
  activity: { readonly id: string },
  definitionVersion: number,
): Promise<CompiledVotingArtifact> {
  const release = await getRelease(trx, activity.id, definitionVersion);
  if (release === null) throw new DomainError("VERSION_NOT_RELEASED", "The activity has no active released definition.");
  const plan = release.capabilities.voting;
  if (plan === undefined || plan.ok !== true) throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The release has no voting snapshot.");
  const decoded = decodeVotingArtifact(plan.artifact);
  if (decoded.kind === "legacy") {
    throw new DomainError("RELEASE_REISSUE_REQUIRED", "This voting release uses a legacy identity policy; publish a new definition before opening a session.");
  }
  return decoded.artifact;
}
