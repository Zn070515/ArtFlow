import { randomBytes, randomUUID } from "node:crypto";

import {
  getActivityForUpdate,
  getLocalAccount,
  getParticipantClaimByDigest,
  getParticipantClaimByDigestForUpdate,
  getParticipantIdentityLinkByActor,
  getParticipantIdentityLinkByLegacyForUpdate,
  getRegistrationForUpdate,
  insertParticipantClaim,
  insertParticipantIdentityLink,
  markParticipantClaimConsumed,
  revokeUnconsumedParticipantClaims,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  DomainError,
  hasPermission,
  SYSTEM_ACTOR,
} from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import { sql, type Kysely } from "kysely";

import { authenticateLocalAccount, createLocalAccount } from "./auth-service.js";
import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";

const DEFAULT_PARTICIPANT_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLAIM_ERROR_MESSAGE = "The participant claim is invalid or expired.";

type PublicActor = Omit<ActorContext, "authContext">;

export interface IssueParticipantClaimInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly registrationId: string;
  readonly ttlMs?: number;
}

export interface IssuedParticipantClaim {
  readonly token: string | null;
  readonly activityId: string;
  readonly publicCode: string;
  readonly title: string;
  readonly expiresAt: string;
}

export interface ConsumeParticipantClaimInput {
  readonly commandId: string;
  readonly token: string;
  readonly username?: string;
  readonly password?: string;
}

export interface ConsumedParticipantClaim {
  readonly actor: PublicActor;
  readonly publicCode: string;
  readonly sessionToken?: string;
  readonly expiresAt?: string;
}

function publicActor(actor: ActorContext): PublicActor {
  const { authContext: _authContext, ...rest } = actor;
  return rest;
}

function requireIssuer(actor: ActorContext): void {
  if (!hasPermission(actor, "registration.review") && !hasPermission(actor, "registration.manage")) {
    throw new DomainError("FORBIDDEN", "Registration review or management permission is required.");
  }
}

function invalidClaim(): never {
  throw new DomainError("INVALID_PARTICIPANT_CLAIM", CLAIM_ERROR_MESSAGE);
}

function uniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === "23505";
}

function participantActor(actorId: string): ActorContext {
  return {
    actorId,
    actorType: "user",
    roles: ["participant"],
    permissions: [],
  };
}

function authenticatedParticipant(actor: ActorContext): boolean {
  return actor.actorId !== SYSTEM_ACTOR.actorId && actor.roles.includes("participant");
}

async function lockClaimIdentity(
  trx: Kysely<Database>,
  legacyParticipantId: string,
  actorId: string,
): Promise<void> {
  // A FOR UPDATE query cannot lock an absent identity-link row. Advisory locks
  // serialize both absent-row insertion and the actor-side unique constraint.
  await sql`select pg_advisory_xact_lock(hashtext(${`participant-legacy:${legacyParticipantId}`}))`.execute(trx);
  await sql`select pg_advisory_xact_lock(hashtext(${`participant-actor:${actorId}`}))`.execute(trx);
}

function validateNewAccountCredentials(input: ConsumeParticipantClaimInput): {
  readonly username: string;
  readonly password: string;
} {
  const username = input.username?.trim() ?? "";
  const password = input.password ?? "";
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    throw new DomainError("INVALID_INPUT", "Username must be 3-64 letters, numbers, dots, dashes, or underscores.");
  }
  if (password.length < 8 || password.length > 128) {
    throw new DomainError("INVALID_INPUT", "Password must be 8-128 characters.");
  }
  return { username, password };
}

export async function issueParticipantClaim(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: IssueParticipantClaimInput,
): Promise<CommandOutcome<IssuedParticipantClaim>> {
  const actor = runtimeActor(deps);
  if (input.ttlMs !== undefined && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)) {
    throw new DomainError("INVALID_INPUT", "Participant claim TTL must be positive.");
  }
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "registration",
    commandType: "registration.account-claim.issue",
    actor,
    payload: { registrationId: input.registrationId, ttlMs: input.ttlMs ?? null },
  }, async (trx) => {
    requireIssuer(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    if (activity.status !== "active") throw new DomainError("ACTIVITY_NOT_ACTIVE", "Participant claims require an active activity.");
    const registration = await getRegistrationForUpdate(trx, input.registrationId);
    if (registration === null || registration.activityId !== input.activityId) {
      throw new DomainError("NOT_FOUND", "The registration was not found.");
    }
    if (!registration.participantId.startsWith("legacy-user:")) invalidClaim();
    if (await getParticipantIdentityLinkByLegacyForUpdate(trx, registration.participantId) !== null) {
      invalidClaim();
    }
    const issuedAt = deps.now();
    await revokeUnconsumedParticipantClaims(trx, {
      activityId: input.activityId,
      registrationId: registration.id,
      legacyParticipantId: registration.participantId,
      revokedAt: issuedAt,
    });
    const claimId = idFromCommand("participant-claim", input.commandId);
    const token = `AF1.CLAIM.${claimId}.${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(
      Date.parse(issuedAt) + (input.ttlMs ?? DEFAULT_PARTICIPANT_CLAIM_TTL_MS),
    ).toISOString();
    await insertParticipantClaim(trx, {
      id: claimId,
      activityId: input.activityId,
      registrationId: registration.id,
      legacyParticipantId: registration.participantId,
      tokenDigest: stableHash(token),
      expiresAt,
      revokedAt: null,
      consumedAt: null,
      consumedByActorId: null,
      issuedBy: actor.actorId,
    });
    await appendEngineEvent(trx, deps, {
      type: "ParticipantAccountClaimIssued",
      activityId: input.activityId,
      aggregateType: "registration",
      aggregateId: registration.id,
      revision: registration.revision,
      capability: "registration",
      payload: {
        claimId,
        registrationId: registration.id,
        legacyParticipantId: registration.participantId,
      },
    });
    const activityDetails = await trx.selectFrom("activity")
      .select(["public_code", "title"])
      .where("id", "=", input.activityId)
      .executeTakeFirstOrThrow();
    const body: IssuedParticipantClaim = {
      token,
      activityId: input.activityId,
      publicCode: activityDetails.public_code,
      title: activityDetails.title,
      expiresAt,
    };
    return { body, persistedBody: { ...body, token: null }, status: 201 };
  });
}

export async function consumeParticipantClaim(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ConsumeParticipantClaimInput,
): Promise<CommandOutcome<ConsumedParticipantClaim>> {
  const token = input.token.trim();
  if (!token) invalidClaim();
  const tokenDigest = stableHash(token);
  const candidate = await getParticipantClaimByDigest(db, tokenDigest);
  if (candidate === null) invalidClaim();
  const resolvedActor = runtimeActor(deps);
  const hasAuthenticatedActor = resolvedActor.actorId !== SYSTEM_ACTOR.actorId;
  if (hasAuthenticatedActor && !authenticatedParticipant(resolvedActor)) invalidClaim();
  const hasSession = authenticatedParticipant(resolvedActor);
  const commandActor = hasSession
    ? resolvedActor
    : {
        actorId: `participant-claim:${input.commandId}`,
        actorType: "service" as const,
        roles: ["participant-claim"],
        permissions: [],
      };
  const commandDeps: RuntimeDeps = hasSession ? deps : { ...deps, actor: commandActor };
  const commandPayload = {
    tokenDigest,
    username: input.username?.trim() ?? null,
    passwordDigest: input.password === undefined ? null : stableHash(input.password),
  };

  return executeCommand(db, {
    commandId: input.commandId,
    activityId: candidate.activityId,
    capability: "registration",
    commandType: "registration.account-claim.consume",
    actor: commandActor,
    payload: commandPayload,
  }, async (trx) => {
    const claim = await getParticipantClaimByDigestForUpdate(trx, tokenDigest);
    if (claim === null) invalidClaim();
    if (claim.revokedAt !== null || claim.consumedAt !== null || Date.parse(claim.expiresAt) <= Date.parse(deps.now())) invalidClaim();
    if (!claim.legacyParticipantId.startsWith("legacy-user:")) invalidClaim();
    const activity = await getActivityForUpdate(trx, claim.activityId);
    if (activity === null) invalidClaim();
    const registration = await getRegistrationForUpdate(trx, claim.registrationId);
    if (registration === null || registration.activityId !== claim.activityId || registration.participantId !== claim.legacyParticipantId) {
      invalidClaim();
    }
    const existingLegacyLink = await getParticipantIdentityLinkByLegacyForUpdate(trx, claim.legacyParticipantId);
    if (existingLegacyLink !== null) invalidClaim();

    let actor: ActorContext;
    let sessionToken: string | undefined;
    let expiresAt: string | undefined;
    let linkedBy = commandActor.actorId;
    if (hasSession) {
      if (input.username !== undefined || input.password !== undefined) {
        throw new DomainError("INVALID_INPUT", "An authenticated claim cannot include account credentials.");
      }
      actor = resolvedActor;
      linkedBy = actor.actorId;
    } else {
      const credentials = validateNewAccountCredentials(input);
      await sql`select pg_advisory_xact_lock(hashtext(${`participant-username:${credentials.username.toLowerCase()}`}))`.execute(trx);
      if (await getLocalAccount(trx, credentials.username) !== null) {
        throw new DomainError("USERNAME_TAKEN", "This username is already registered.");
      }
      actor = participantActor(`participant:${randomUUID()}`);
      try {
        await createLocalAccount(trx, {
          username: credentials.username,
          password: credentials.password,
          actor,
        });
      } catch (error) {
        if (uniqueViolation(error)) {
          throw new DomainError("USERNAME_TAKEN", "This username is already registered.");
        }
        throw error;
      }
      const authenticated = await authenticateLocalAccount(trx, credentials, new Date(deps.now()));
      actor = authenticated.actor;
      sessionToken = authenticated.token;
      expiresAt = authenticated.expiresAt;
    }
    await lockClaimIdentity(trx, claim.legacyParticipantId, actor.actorId);
    if (await getParticipantIdentityLinkByLegacyForUpdate(trx, claim.legacyParticipantId) !== null) {
      invalidClaim();
    }

    const activityDetails = await trx.selectFrom("activity")
      .select("public_code")
      .where("id", "=", claim.activityId)
      .executeTakeFirst();
    if (activityDetails === undefined) invalidClaim();
    if (await getParticipantIdentityLinkByActor(trx, actor.actorId) !== null) invalidClaim();
    await insertParticipantIdentityLink(trx, {
      legacyParticipantId: claim.legacyParticipantId,
      actorId: actor.actorId,
      linkedBy,
      claimId: claim.id,
    });
    await markParticipantClaimConsumed(trx, claim.id, deps.now(), actor.actorId);
    await appendEngineEvent(trx, commandDeps, {
      type: "ParticipantAccountClaimed",
      activityId: claim.activityId,
      aggregateType: "registration",
      aggregateId: claim.registrationId,
      revision: registration.revision,
      capability: "registration",
      payload: {
        claimId: claim.id,
        registrationId: claim.registrationId,
        legacyParticipantId: claim.legacyParticipantId,
        actorId: actor.actorId,
      },
    });
    const body: ConsumedParticipantClaim = {
      actor: publicActor(actor),
      publicCode: activityDetails.public_code,
      ...(sessionToken === undefined ? {} : { sessionToken }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
    return { body, persistedBody: { ...body, sessionToken: null }, status: 200 };
  });
}
