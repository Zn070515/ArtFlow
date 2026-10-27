import { randomBytes } from "node:crypto";

import type { Database, StoredMaterialCheck, StoredSupplementGrant } from "@artflow-plus/db";
import {
  findSupplementGrantByDigest,
  getActivityForUpdate,
  getRegistration,
  getRegistrationForUpdate,
  insertSupplementGrant,
  listMaterialChecks,
  listMaterials,
  revokeSupplementGrant,
  updateRegistration,
} from "@artflow-plus/db";
import { DomainError, requirePermission } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";
import { attachMaterialContent, uploadMaterial } from "./material-service.js";

const DEFAULT_SUPPLEMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface IssueSupplementInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly registrationId: string;
  readonly allowedKeys: readonly string[];
  readonly ttlMs?: number;
}

export interface IssuedSupplement {
  readonly token: string;
  readonly expiresAt: string;
  readonly allowedKeys: readonly string[];
}

function supplementActor(participantId: string): ActorContext {
  return {
    actorId: participantId,
    actorType: "user",
    roles: ["participant"],
    permissions: [],
  };
}

async function requireGrant(
  db: Kysely<Database>,
  token: string,
  now: string,
): Promise<{ grant: StoredSupplementGrant; registrationId: string; activityId: string }> {
  const grant = await findSupplementGrantByDigest(db, stableHash(token));
  if (grant === null || grant.revokedAt !== null || Date.parse(grant.expiresAt) <= Date.parse(now)) {
    throw new DomainError("INVALID_SUPPLEMENT", "The supplement capability is invalid or expired.");
  }
  const registration = await getRegistration(db, grant.registrationId);
  if (registration === null || registration.activityId !== grant.activityId) {
    throw new DomainError("INVALID_SUPPLEMENT", "The supplement registration was not found.");
  }
  return { grant, registrationId: registration.id, activityId: registration.activityId };
}

/**
 * Staff-issued supplement capability: it binds one registration and the exact
 * slots that may be supplemented, without migrating a v1 password or account.
 */
export async function issueSupplementGrant(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: IssueSupplementInput,
): Promise<CommandOutcome<IssuedSupplement>> {
  const actor = runtimeActor(deps);
  const allowedKeys = [...new Set(input.allowedKeys.map((key) => key.trim()).filter(Boolean))].sort();
  if (allowedKeys.length === 0) throw new DomainError("INVALID_INPUT", "At least one supplement slot is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "registration",
    commandType: "registration.supplement.issue",
    actor,
    payload: { registrationId: input.registrationId, allowedKeys },
  }, async (trx) => {
    requirePermission(actor, "registration.review");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    if (activity.status !== "active") throw new DomainError("ACTIVITY_NOT_ACTIVE", "Supplements require an active activity.");
    const registration = await getRegistrationForUpdate(trx, input.registrationId);
    if (registration === null || registration.activityId !== input.activityId) {
      throw new DomainError("NOT_FOUND", "The registration was not found.");
    }
    const checks = await listMaterialChecks(trx, registration.id);
    const knownSlots = new Set(checks.map((check) => check.slotKey));
    const unknown = allowedKeys.filter((key) => !knownSlots.has(key));
    if (unknown.length > 0) {
      throw new DomainError("INVALID_INPUT", `Unknown supplement slots: ${unknown.join(", ")}.`);
    }
    const updated = {
      ...registration,
      status: "need_supplement" as const,
      supplementKeys: allowedKeys,
      revision: registration.revision + 1,
    };
    await updateRegistration(trx, updated, registration.revision);
    const grantId = idFromCommand("supplement", input.commandId);
    const token = `AF1.SUP.${grantId}.${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.parse(deps.now()) + (input.ttlMs ?? DEFAULT_SUPPLEMENT_TTL_MS)).toISOString();
    await insertSupplementGrant(trx, {
      id: grantId,
      activityId: input.activityId,
      registrationId: registration.id,
      tokenDigest: stableHash(token),
      allowedKeys,
      expiresAt,
      revokedAt: null,
      createdBy: actor.actorId,
    });
    await appendEngineEvent(trx, deps, {
      type: "RegistrationSupplementIssued",
      activityId: input.activityId,
      aggregateType: "registration",
      aggregateId: registration.id,
      revision: updated.revision,
      capability: "registration",
      payload: { registrationId: registration.id, allowedKeys, grantId },
    });
    return { body: { token, expiresAt, allowedKeys }, status: 201 };
  });
}

export interface SupplementContext {
  readonly activity: { readonly publicCode: string; readonly title: string };
  readonly registrationId: string;
  readonly status: string;
  readonly allowedKeys: readonly string[];
  readonly checks: readonly StoredMaterialCheck[];
  readonly materials: readonly { readonly id: string; readonly questionKey: string; readonly originalName: string; readonly contentReady: boolean }[];
}

export async function getSupplementContext(
  db: Kysely<Database>,
  token: string,
  now: string,
): Promise<SupplementContext> {
  const { grant, registrationId, activityId } = await requireGrant(db, token, now);
  const registration = await getRegistration(db, registrationId);
  if (registration === null) throw new DomainError("INVALID_SUPPLEMENT", "The supplement registration was not found.");
  const activity = await db.selectFrom("activity").select(["public_code", "title"])
    .where("id", "=", activityId).executeTakeFirstOrThrow();
  const checks = await listMaterialChecks(db, registrationId);
  const materials = await listMaterials(db, registrationId);
  return {
    activity: { publicCode: activity.public_code, title: activity.title },
    registrationId,
    status: registration.status,
    allowedKeys: grant.allowedKeys,
    checks,
    materials: materials.map((material) => ({
      id: material.id,
      questionKey: material.questionKey,
      originalName: material.originalName,
      contentReady: material.contentReady ?? true,
    })),
  };
}

export async function uploadSupplementMaterial(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: {
    readonly token: string;
    readonly commandId: string;
    readonly questionKey: string;
    readonly originalName: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  },
): Promise<{ readonly materialId: string; readonly contentReady: true }> {
  const { grant, registrationId, activityId } = await requireGrant(db, input.token, deps.now());
  if (!grant.allowedKeys.includes(input.questionKey)) {
    throw new DomainError("SUPPLEMENT_CLOSED", "This slot is not open for supplement.");
  }
  const registration = await getRegistration(db, registrationId);
  if (registration === null) throw new DomainError("INVALID_SUPPLEMENT", "The supplement registration was not found.");
  const depsForParticipant: RuntimeDeps = { ...deps, actor: supplementActor(registration.participantId) };
  const uploaded = await uploadMaterial(db, depsForParticipant, {
    commandId: `${input.commandId}:meta`,
    activityId,
    registrationId,
    questionKey: input.questionKey,
    originalName: input.originalName,
    contentType: input.contentType,
    byteLength: input.bytes.byteLength,
  });
  const attached = await attachMaterialContent(db, depsForParticipant, {
    commandId: `${input.commandId}:content`,
    activityId,
    materialId: uploaded.body.id,
    bytes: input.bytes,
  });
  return { materialId: attached.body.id, contentReady: true };
}

export interface SubmitSupplementInput {
  readonly token: string;
  readonly commandId: string;
}

export async function submitSupplement(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: SubmitSupplementInput,
): Promise<CommandOutcome<{ readonly status: "submitted" }>> {
  const { grant, registrationId, activityId } = await requireGrant(db, input.token, deps.now());
  const registration = await getRegistration(db, registrationId);
  if (registration === null) throw new DomainError("INVALID_SUPPLEMENT", "The supplement registration was not found.");
  const participantActor = supplementActor(registration.participantId);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId,
    capability: "registration",
    commandType: "registration.supplement.submit",
    actor: participantActor,
    payload: { registrationId, allowedKeys: grant.allowedKeys },
  }, async (trx) => {
    const current = await getRegistrationForUpdate(trx, registrationId);
    if (current === null) throw new DomainError("NOT_FOUND", "The registration was not found.");
    const materials = await listMaterials(trx, registrationId);
    const missing = grant.allowedKeys.filter((key) =>
      !materials.some((material) => material.questionKey === key && (material.contentReady ?? true)),
    );
    if (missing.length > 0) {
      throw new DomainError("INVALID_INPUT", `Supplement slots are still missing: ${missing.join(", ")}.`);
    }
    const updated = {
      ...current,
      status: "submitted" as const,
      supplementKeys: [] as readonly string[],
      revision: current.revision + 1,
    };
    await updateRegistration(trx, updated, current.revision);
    await revokeSupplementGrant(trx, grant.id, deps.now());
    await appendEngineEvent(trx, deps, {
      type: "RegistrationSupplementSubmitted",
      activityId,
      aggregateType: "registration",
      aggregateId: registrationId,
      revision: updated.revision,
      capability: "registration",
      payload: { registrationId, allowedKeys: grant.allowedKeys },
    });
    return { body: { status: "submitted" as const }, status: 200 };
  });
}
