import type { Database, StoredMaterial } from "@artflow-plus/db";
import {
  getActivityForUpdate,
  findReleaseByQuestionnaireHash,
  activateMaterialContent,
  getMaterial,
  getMaterialByIdForUpdate,
  getMaterialForUpdate,
  getRegistration,
  getRegistrationForUpdate,
  getRelease,
  insertMaterial,
  retireCurrentMaterial,
  updateMaterialCheckStatus,
  updateMaterialReview,
} from "@artflow-plus/db";
import type {
  CompiledMaterialsArtifact,
  CompiledQuestionnaireArtifact,
  QuestionnaireFileSlot,
} from "@artflow-plus/domain";
import {
  DomainError,
  requirePermission,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand } from "./hash.js";
import { canActForParticipant } from "./participant-identity.js";

function requireActive(activity: { readonly status: string }): void {
  if (activity.status !== "active") {
    throw new DomainError("ACTIVITY_NOT_ACTIVE", "Material commands require an active activity.");
  }
}

function artifact<T>(
  activity: { readonly enabledCapabilities: readonly string[] },
  release: { readonly capabilities: Readonly<Record<string, { readonly ok: true; readonly artifact: unknown }>> },
  key: string,
): T {
  if (!activity.enabledCapabilities.includes(key)) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", `Capability ${key} is not enabled on this activity.`);
  }
  return releaseArtifact<T>(release, key);
}

function releaseArtifact<T>(
  release: { readonly capabilities: Readonly<Record<string, { readonly ok: true; readonly artifact: unknown }>> },
  key: string,
): T {
  const plan = release.capabilities[key];
  if (plan === undefined || plan.ok !== true) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", `Release is missing the ${key} snapshot.`);
  }
  return plan.artifact as T;
}

async function releasedMaterialRules(
  trx: Kysely<Database>,
  activity: { readonly id: string; readonly activeDefinitionVersion: number; readonly enabledCapabilities: readonly string[] },
  questionnaireHash?: string,
): Promise<{ readonly questionnaire: CompiledQuestionnaireArtifact; readonly materials: CompiledMaterialsArtifact }> {
  const release = questionnaireHash === undefined
    ? await getRelease(trx, activity.id, activity.activeDefinitionVersion)
    : await findReleaseByQuestionnaireHash(trx, activity.id, questionnaireHash);
  if (release === null) throw new DomainError("VERSION_NOT_RELEASED", "The registration questionnaire snapshot is no longer available.");
  return {
    questionnaire: questionnaireHash === undefined
      ? artifact<CompiledQuestionnaireArtifact>(activity, release, "questionnaire")
      : releaseArtifact<CompiledQuestionnaireArtifact>(release, "questionnaire"),
    materials: questionnaireHash === undefined
      ? artifact<CompiledMaterialsArtifact>(activity, release, "materials")
      : releaseArtifact<CompiledMaterialsArtifact>(release, "materials"),
  };
}

function fileSlotFor(
  questionnaire: CompiledQuestionnaireArtifact,
  questionKey: string,
): QuestionnaireFileSlot & { readonly key: string } {
  const slot = questionnaire.fileSlots.find((candidate) => candidate.key === questionKey);
  if (slot === undefined) {
    throw new DomainError("QUESTION_UNKNOWN", `Question ${questionKey} is not a file slot in the released questionnaire.`);
  }
  return slot;
}

function validateMaterial(
  slot: QuestionnaireFileSlot & { readonly key: string },
  rules: CompiledMaterialsArtifact,
  input: { readonly originalName: string; readonly byteLength: number; readonly contentType: string },
): void {
  if (!input.originalName.trim() || !input.contentType.trim() || !Number.isInteger(input.byteLength) || input.byteLength < 0) {
    throw new DomainError("INVALID_INPUT", "Material metadata is invalid.");
  }
  if (input.byteLength > rules.maxBytes || (slot.maxBytes !== undefined && input.byteLength > slot.maxBytes)) {
    throw new DomainError("MATERIAL_NOT_ALLOWED", "The material exceeds the released size limit.");
  }
  if (!rules.allowedPurposes.includes(slot.purpose)) {
    throw new DomainError("MATERIAL_NOT_ALLOWED", `Purpose ${slot.purpose} is not allowed by the released materials policy.`);
  }
  const lowerName = input.originalName.toLowerCase();
  if (!slot.accepts.some((extension) => lowerName.endsWith(extension.toLowerCase()))) {
    throw new DomainError("MATERIAL_NOT_ALLOWED", "The material extension is not accepted by the released questionnaire.");
  }
}

export interface UploadMaterialInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly registrationId: string;
  readonly questionKey: string;
  readonly originalName: string;
  readonly contentType: string;
  readonly byteLength: number;
}

export async function uploadMaterial(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: UploadMaterialInput,
): Promise<CommandOutcome<StoredMaterial>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "materials",
      commandType: "materials.upload",
      actor,
      payload: {
        registrationId: input.registrationId,
        questionKey: input.questionKey,
        originalName: input.originalName,
        contentType: input.contentType,
        byteLength: input.byteLength,
      },
    },
    async (trx) => {
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      requireActive(activity);
      const registration = await getRegistrationForUpdate(trx, input.registrationId);
      if (registration === null) throw new DomainError("NOT_FOUND", `Registration ${input.registrationId} was not found.`);
      if (registration.activityId !== input.activityId) throw new DomainError("CROSS_ACTIVITY", "The registration belongs to another activity.");
      if (!(await canActForParticipant(trx, actor, registration.participantId, "materials.manage"))) {
        throw new DomainError("FORBIDDEN", "The actor cannot upload material for this registration.");
      }
      const { questionnaire, materials } = await releasedMaterialRules(trx, activity, registration.questionnaireHash);
      const slot = fileSlotFor(questionnaire, input.questionKey);
      validateMaterial(slot, materials, input);
      const material: StoredMaterial = {
        id: idFromCommand("mat", input.commandId),
        activityId: input.activityId,
        registrationId: registration.id,
        questionKey: input.questionKey,
        storageKey: `private/${input.activityId}/${idFromCommand("blob", input.commandId)}`,
        originalName: input.originalName.trim(),
        contentType: input.contentType.trim(),
        byteLength: input.byteLength,
        ownerActorId: actor.actorId,
        status: "uploaded",
        reviewNote: "",
        reviewedBy: null,
        reviewedAt: null,
        revision: 0,
        // The row is a staging placeholder until its bytes are stored; the
        // previous current material stays authoritative if the upload fails.
        current: false,
        contentReady: false,
      };
      await insertMaterial(trx, material);
      await appendEngineEvent(trx, deps, {
        type: "MaterialUploaded",
        activityId: input.activityId,
        aggregateType: "material",
        aggregateId: material.id,
        revision: material.revision,
        capability: "materials",
        payload: {
          materialId: material.id,
          registrationId: material.registrationId,
          questionKey: material.questionKey,
          storageKey: material.storageKey,
          byteLength: material.byteLength,
        },
      });
      return { body: material, status: 201 };
    },
  );
}

export interface AttachMaterialContentInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly materialId: string;
  readonly bytes: Uint8Array;
}

/**
 * Stores the actual bytes for a metadata row created by `materials.upload`.
 * Legacy imported materials keep their read-only bridge key and cannot be
 * overwritten here.
 */
export async function attachMaterialContent(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: AttachMaterialContentInput,
): Promise<CommandOutcome<StoredMaterial>> {
  const storage = deps.materialStorage;
  if (storage === undefined) {
    throw new DomainError("MATERIAL_CONTENT_UNAVAILABLE", "Material storage is not configured.");
  }
  const actor = runtimeActor(deps);
  let writtenKey: string | undefined;
  try {
    return await executeCommand(
      db,
      {
        commandId: input.commandId,
        activityId: input.activityId,
        capability: "materials",
        commandType: "materials.content.attach",
        actor,
        payload: { materialId: input.materialId, byteLength: input.bytes.byteLength },
      },
      async (trx) => {
        const activity = await getActivityForUpdate(trx, input.activityId);
        if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
        requireActive(activity);
        const material = await getMaterialByIdForUpdate(trx, input.materialId);
        if (material === null || material.activityId !== input.activityId) {
          throw new DomainError("NOT_FOUND", "Material was not found.");
        }
        if (material.current && material.contentReady) {
          throw new DomainError("INVALID_TRANSITION", "This material already has stored content.");
        }
        const registration = await getRegistration(trx, material.registrationId);
        if (registration === null || registration.activityId !== input.activityId) {
          throw new DomainError("NOT_FOUND", "Material was not found.");
        }
        const staff = actor.permissions.includes("*") ||
          actor.permissions.includes("materials.manage") ||
          actor.permissions.includes("materials.review");
        if (
          material.ownerActorId !== actor.actorId &&
          !(await canActForParticipant(trx, actor, registration.participantId, "materials.manage")) &&
          !staff
        ) {
          throw new DomainError("FORBIDDEN", "The actor cannot store content for this material.");
        }
        if (input.bytes.byteLength !== material.byteLength) {
          throw new DomainError("MATERIAL_NOT_ALLOWED", "The uploaded content does not match the registered size.");
        }
        if (!material.storageKey.startsWith("private/")) {
          throw new DomainError("MATERIAL_CONTENT_UNAVAILABLE", "Legacy material bytes are read-only.");
        }
        await storage.put(material.storageKey, input.bytes);
        writtenKey = material.storageKey;
        // Bytes are ready; only now does the new row replace the old current
        // one. Both statements share this transaction.
        await retireCurrentMaterial(trx, material.registrationId, material.questionKey);
        const activated = await activateMaterialContent(trx, material, material.revision);
        await updateMaterialCheckStatus(trx, material.registrationId, material.questionKey, "uploaded");
        await appendEngineEvent(trx, deps, {
          type: "MaterialContentStored",
          activityId: input.activityId,
          aggregateType: "material",
          aggregateId: activated.id,
          revision: activated.revision,
          capability: "materials",
          payload: { materialId: activated.id, byteLength: activated.byteLength, storageKey: activated.storageKey },
        });
        return { body: activated, status: 201 };
      },
    );
  } catch (error) {
    if (writtenKey !== undefined) await storage.remove(writtenKey).catch(() => undefined);
    throw error;
  }
}

export async function readMaterialContent(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string; readonly materialId: string; readonly actor: ReturnType<typeof runtimeActor> },
): Promise<{ readonly material: StoredMaterial; readonly bytes: Uint8Array }> {
  const material = await readMaterialForActor(db, {
    activityId: input.activityId,
    materialId: input.materialId,
    actor: input.actor,
  });
  const storage = deps.materialStorage;
  if (storage === undefined) {
    throw new DomainError("MATERIAL_CONTENT_UNAVAILABLE", "Material storage is not configured.");
  }
  try {
    return { material, bytes: await storage.read(material.storageKey) };
  } catch {
    throw new DomainError("MATERIAL_CONTENT_UNAVAILABLE", "The material bytes are not available.");
  }
}

export interface ReviewMaterialInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly materialId: string;
  readonly expectedRevision: number;
  readonly status: Extract<StoredMaterial["status"], "approved" | "needs_supplement">;
  readonly note: string;
}

export async function reviewMaterial(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ReviewMaterialInput,
): Promise<CommandOutcome<StoredMaterial>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "materials",
      commandType: "materials.review",
      actor,
      payload: { materialId: input.materialId, expectedRevision: input.expectedRevision, status: input.status, note: input.note },
    },
    async (trx) => {
      requirePermission(actor, "materials.review");
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      requireActive(activity);
      const material = await getMaterialForUpdate(trx, input.materialId);
      if (material === null) throw new DomainError("NOT_FOUND", `Material ${input.materialId} was not found.`);
      if (material.activityId !== input.activityId) throw new DomainError("CROSS_ACTIVITY", "The material belongs to another activity.");
      if (input.status === "approved" && !material.contentReady) {
        throw new DomainError("MATERIAL_CONTENT_UNAVAILABLE", "Material content must be stored before approval.");
      }
      const next: StoredMaterial = {
        ...material,
        status: input.status,
        reviewNote: input.note.trim(),
        reviewedBy: actor.actorId,
        reviewedAt: deps.now(),
        revision: material.revision + 1,
      };
      const saved = await updateMaterialReview(trx, next, input.expectedRevision);
      await updateMaterialCheckStatus(
        trx,
        saved.registrationId,
        saved.questionKey,
        saved.status,
        saved.reviewNote,
      );
      await appendEngineEvent(trx, deps, {
        type: "MaterialReviewed",
        activityId: input.activityId,
        aggregateType: "material",
        aggregateId: saved.id,
        revision: saved.revision,
        capability: "materials",
        payload: {
          materialId: saved.id,
          registrationId: saved.registrationId,
          questionKey: saved.questionKey,
          status: saved.status,
          note: saved.reviewNote,
          reviewerId: actor.actorId,
        },
      });
      return { body: saved };
    },
  );
}

export async function readMaterialForActor(
  db: Kysely<Database>,
  input: { readonly activityId: string; readonly materialId: string; readonly actor: ReturnType<typeof runtimeActor> },
): Promise<StoredMaterial> {
  const material = await getMaterial(db, input.materialId);
  if (material === null || material.activityId !== input.activityId) {
    throw new DomainError("NOT_FOUND", "Material was not found.");
  }
  const registration = await getRegistration(db, material.registrationId);
  if (registration === null || registration.activityId !== input.activityId) {
    throw new DomainError("NOT_FOUND", "Material was not found.");
  }
  const staffRead = input.actor.permissions.includes("*") ||
    input.actor.permissions.includes("materials.read") ||
    input.actor.permissions.includes("materials.review") ||
    input.actor.permissions.includes("materials.manage");
  if (
    material.ownerActorId !== input.actor.actorId &&
    !(await canActForParticipant(db, input.actor, registration.participantId, "materials.manage")) &&
    !staffRead
  ) {
    throw new DomainError("NOT_FOUND", "Material was not found.");
  }
  return material;
}
