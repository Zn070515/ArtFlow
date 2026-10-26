import type {
  Database,
  StoredActivitySummary,
  StoredMaterial,
  StoredRegistration,
  StoredRoster,
} from "@artflow-plus/db";
import {
  findReleaseByQuestionnaireHash,
  getActivityByPublicCode,
  getActivitySummary,
  getRegistration,
  getRelease,
  getRegistrationByParticipant,
  getRoster,
  listActivities,
  listMaterials,
  listRegistrations,
} from "@artflow-plus/db";
import { DomainError, hasPermission } from "@artflow-plus/domain";
import type {
  CompiledQuestionnaireArtifact,
  QuestionnaireFileSlot,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { runtimeActor, type RuntimeDeps } from "./deps.js";

export interface PublicActivity {
  readonly id: string;
  readonly publicCode: string;
  readonly title: string;
  readonly status: string;
  readonly registrationOpen: boolean;
}

export interface RegistrationMaterialDto {
  readonly id: string;
  readonly questionKey: string;
  readonly originalName: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly status: string;
  readonly revision: number;
}

export interface RegistrationFormDto {
  readonly activity: {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly publicCode: string;
  };
  readonly registration: {
    readonly id: string;
    readonly participantId: string;
    readonly status: string;
    readonly revision: number;
    readonly answers: Readonly<Record<string, unknown>>;
    readonly questionnaireVersion: string;
    readonly questionnaireHash: string;
    readonly reviewNote?: string;
  };
  readonly questionnaire: {
    readonly version: string;
    readonly questions: CompiledQuestionnaireArtifact["questions"];
    readonly fileSlots: readonly (QuestionnaireFileSlot & { readonly key: string })[];
  };
  readonly materials: readonly RegistrationMaterialDto[];
}

function requireAny(actor: Parameters<typeof hasPermission>[0], permissions: readonly string[]): void {
  if (!permissions.some((permission) => hasPermission(actor, permission))) {
    throw new DomainError("FORBIDDEN", `One of ${permissions.join(", ")} is required.`);
  }
}

export async function getPublicActivity(
  db: Kysely<Database>,
  publicCode: string,
): Promise<PublicActivity | null> {
  const activity = await getActivityByPublicCode(db, publicCode);
  if (activity === null) return null;
  const release = activity.status === "active"
    ? await getRelease(db, activity.id, activity.activeDefinitionVersion)
    : null;
  // Mirror the start-registration gate: the command needs the registration,
  // questionnaire, and materials capabilities plus both released snapshots.
  const registrationOpen = activity.status === "active" &&
    ["registration", "questionnaire", "materials"].every((capability) =>
      activity.enabledCapabilities.includes(capability)) &&
    release !== null &&
    release.capabilities.questionnaire?.ok === true &&
    release.capabilities.materials?.ok === true;
  return {
    id: activity.id,
    publicCode: activity.publicCode,
    title: activity.title,
    status: activity.status,
    registrationOpen,
  };
}

export async function listActivitiesForReview(
  db: Kysely<Database>,
  deps: RuntimeDeps,
): Promise<readonly StoredActivitySummary[]> {
  requireAny(runtimeActor(deps), [
    "registration.review",
    "registration.manage",
    "studio.manage",
    "competition.manage",
    "judge.manage",
  ]);
  return listActivities(db);
}

export async function getMyRegistration(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<StoredRegistration | null> {
  const actor = runtimeActor(deps);
  return getRegistrationByParticipant(db, activityId, actor.actorId);
}

function materialDto(material: StoredMaterial): RegistrationMaterialDto {
  return {
    id: material.id,
    questionKey: material.questionKey,
    originalName: material.originalName,
    contentType: material.contentType,
    byteLength: material.byteLength,
    status: material.status,
    revision: material.revision,
  };
}

export async function getRegistrationDetail(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
  registrationId: string,
): Promise<RegistrationFormDto> {
  const actor = runtimeActor(deps);
  const registration = await getRegistration(db, registrationId);
  if (registration === null || registration.activityId !== activityId) {
    throw new DomainError("NOT_FOUND", "The registration was not found.");
  }
  const allowed =
    actor.actorId === registration.participantId ||
    hasPermission(actor, "registration.review") ||
    hasPermission(actor, "registration.manage");
  if (!allowed) throw new DomainError("FORBIDDEN", "The actor cannot read this registration.");
  const activity = await getActivitySummary(db, activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  const release = await findReleaseByQuestionnaireHash(db, activityId, registration.questionnaireHash);
  if (release === null) {
    throw new DomainError("VERSION_NOT_RELEASED", "The registration questionnaire snapshot is no longer available.");
  }
  const plan = release.capabilities.questionnaire;
  if (plan === undefined || plan.ok !== true) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The release has no questionnaire snapshot.");
  }
  const questionnaire = plan.artifact as CompiledQuestionnaireArtifact;
  const materials = await listMaterials(db, registrationId);
  return {
    activity: {
      id: activity.id,
      title: activity.title,
      status: activity.status,
      publicCode: activity.publicCode,
    },
    registration: {
      id: registration.id,
      participantId: registration.participantId,
      status: registration.status,
      revision: registration.revision,
      answers: registration.answers,
      questionnaireVersion: registration.questionnaireVersion,
      questionnaireHash: registration.questionnaireHash,
      ...(registration.reviewNote === undefined ? {} : { reviewNote: registration.reviewNote }),
    },
    questionnaire: {
      version: questionnaire.version,
      questions: questionnaire.questions,
      fileSlots: questionnaire.fileSlots,
    },
    materials: materials.map(materialDto),
  };
}

export async function listRegistrationsForReview(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<readonly StoredRegistration[]> {
  requireAny(runtimeActor(deps), ["registration.review", "registration.manage"]);
  return listRegistrations(db, activityId);
}

export async function getRosterForReview(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<StoredRoster> {
  requireAny(runtimeActor(deps), ["registration.review", "registration.roster.finalize"]);
  return getRoster(db, activityId);
}
