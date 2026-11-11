import type { Database, StoredRegistration, StoredRoster } from "@artflow-plus/db";
import {
  getActivityForUpdate,
  getRegistrationByParticipantForUpdate,
  getRegistrationForUpdate,
  getRelease,
  findReleaseByQuestionnaireHash,
  getRosterForUpdate,
  insertRegistration,
  listApprovedRegistrationCount,
  listMaterials,
  listPendingRegistrationCount,
  updateRegistration,
  upsertRoster,
} from "@artflow-plus/db";
import type {
  CompiledQuestionnaireArtifact,
  CompiledQuestionnaireQuestion,
  CompiledMaterialsArtifact,
  RegistrationState,
  RosterFinal,
} from "@artflow-plus/domain";
import {
  canActFor,
  createRegistration,
  DomainError,
  finalizeRoster as finalizeRosterDomain,
  reopenRoster as reopenRosterDomain,
  requirePermission,
  reviewRegistration as reviewRegistrationDomain,
  saveRegistrationAnswer as saveRegistrationAnswerDomain,
  submitRegistration as submitRegistrationDomain,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand } from "./hash.js";

function activeCapability<T>(
  activity: { readonly enabledCapabilities: readonly string[] },
  release: { readonly capabilities: Readonly<Record<string, { readonly ok: true; readonly artifact: unknown }>> },
  key: string,
): T {
  if (!activity.enabledCapabilities.includes(key)) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", `Capability ${key} is not enabled on this activity.`);
  }
  return releaseCapability<T>(release, key);
}

function releaseCapability<T>(
  release: { readonly capabilities: Readonly<Record<string, { readonly ok: true; readonly artifact: unknown }>> },
  key: string,
): T {
  const plan = release.capabilities[key];
  if (plan === undefined || plan.ok !== true) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", `Release is missing the ${key} snapshot.`);
  }
  return plan.artifact as T;
}

async function releasedArtifacts(
  trx: Kysely<Database>,
  activity: { readonly id: string; readonly activeDefinitionVersion: number; readonly enabledCapabilities: readonly string[] },
  questionnaireHash?: string,
): Promise<{
  readonly questionnaire: CompiledQuestionnaireArtifact;
  readonly materials: CompiledMaterialsArtifact;
}> {
  const release = questionnaireHash === undefined
    ? await getRelease(trx, activity.id, activity.activeDefinitionVersion)
    : await findReleaseByQuestionnaireHash(trx, activity.id, questionnaireHash);
  if (release === null) {
    throw new DomainError("VERSION_NOT_RELEASED", "The registration questionnaire snapshot is no longer available.");
  }
  return {
    questionnaire: questionnaireHash === undefined
      ? activeCapability<CompiledQuestionnaireArtifact>(activity, release, "questionnaire")
      : releaseCapability<CompiledQuestionnaireArtifact>(release, "questionnaire"),
    materials: questionnaireHash === undefined
      ? activeCapability<CompiledMaterialsArtifact>(activity, release, "materials")
      : releaseCapability<CompiledMaterialsArtifact>(release, "materials"),
  };
}

function questionFor(
  artifact: CompiledQuestionnaireArtifact,
  questionKey: string,
): CompiledQuestionnaireQuestion {
  const question = artifact.questions.find((candidate) => candidate.key === questionKey);
  if (question === undefined) {
    throw new DomainError("QUESTION_UNKNOWN", `Question ${questionKey} is not in the released questionnaire.`);
  }
  return question;
}

function requireActive(activity: { readonly status: string }): void {
  if (activity.status !== "active") {
    throw new DomainError("ACTIVITY_NOT_ACTIVE", "Registration commands require an active activity.");
  }
}

/**
 * Registration has its own lifecycle frozen in the release. Adoption imports a
 * closed activity with lifecycle "final" or "review"; Activity.status alone
 * must never reopen it.
 */
async function requireRegistrationOpen(
  trx: Kysely<Database>,
  activity: { readonly id: string; readonly activeDefinitionVersion: number },
): Promise<void> {
  const release = await getRelease(trx, activity.id, activity.activeDefinitionVersion);
  if (release === null) {
    throw new DomainError("VERSION_NOT_RELEASED", "The activity has no active released definition.");
  }
  const plan = release.capabilities.registration;
  // Releases written before the registration lifecycle existed have no plan;
  // they behave as open rather than blocking every registration.
  if (plan === undefined || plan.ok !== true) return;
  const artifact = plan.artifact as { lifecycle?: string };
  // Releases written before the lifecycle existed behave as open.
  const lifecycle = artifact.lifecycle ?? "open";
  if (lifecycle !== "open") {
    throw new DomainError("REGISTRATION_CLOSED", `Registration is ${lifecycle} for this activity.`);
  }
}

/**
 * A final roster freezes the participant set and every write that could change
 * it. The explicit supplement seam is separate and must not be blocked here.
 */
async function requireRosterOpen(
  trx: Kysely<Database>,
  activityId: string,
): Promise<void> {
  const roster = await getRosterForUpdate(trx, activityId);
  if (roster.status === "final") {
    throw new DomainError("ROSTER_FINAL", "The roster is final; registration writes are frozen.");
  }
}

function requireOwnerOrManager(
  actor: ReturnType<typeof runtimeActor>,
  participantId: string,
): void {
  if (!canActFor(actor, participantId, "registration.manage")) {
    throw new DomainError("FORBIDDEN", "The actor cannot act for this participant.");
  }
}

export interface StartRegistrationInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly participantId: string;
}

export async function startRegistration(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: StartRegistrationInput,
): Promise<CommandOutcome<StoredRegistration>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "registration",
      commandType: "registration.start",
      actor,
      payload: { participantId: input.participantId },
    },
    async (trx) => {
      requireOwnerOrManager(actor, input.participantId);
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      requireActive(activity);
      await requireRegistrationOpen(trx, activity);
      await requireRosterOpen(trx, input.activityId);
      const existing = await getRegistrationByParticipantForUpdate(trx, input.activityId, input.participantId);
      if (existing !== null) {
        throw new DomainError("INVALID_TRANSITION", "This participant already has a registration.");
      }
      const questionnaire = (await releasedArtifacts(trx, activity)).questionnaire;
      const registration = createRegistration({
        id: idFromCommand("reg", `${input.activityId}:${input.participantId}`),
        activityId: input.activityId,
        participantId: input.participantId,
        questionnaireVersion: questionnaire.version,
        questionnaireHash: questionnaire.schemaHash,
      });
      await insertRegistration(trx, registration);
      await appendEngineEvent(trx, deps, {
        type: "RegistrationStarted",
        activityId: input.activityId,
        aggregateType: "registration",
        aggregateId: registration.id,
        revision: registration.revision,
        capability: "registration",
        payload: {
          registrationId: registration.id,
          participantId: registration.participantId,
          questionnaireVersion: registration.questionnaireVersion,
          questionnaireHash: registration.questionnaireHash,
        },
      });
      return { body: registration, status: 201 };
    },
  );
}
export interface SaveRegistrationAnswerInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly registrationId: string;
  readonly expectedRevision: number;
  readonly questionKey: string;
  readonly value: unknown;
}

export async function saveRegistrationAnswer(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: SaveRegistrationAnswerInput,
): Promise<CommandOutcome<StoredRegistration>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "questionnaire",
      commandType: "registration.answer",
      actor,
      payload: {
        registrationId: input.registrationId,
        expectedRevision: input.expectedRevision,
        questionKey: input.questionKey,
        value: input.value,
      },
    },
    async (trx) => {
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      requireActive(activity);
      await requireRegistrationOpen(trx, activity);
      await requireRosterOpen(trx, input.activityId);
      const registration = await getRegistrationForUpdate(trx, input.registrationId);
      if (registration === null) throw new DomainError("NOT_FOUND", `Registration ${input.registrationId} was not found.`);
      if (registration.activityId !== input.activityId) throw new DomainError("CROSS_ACTIVITY", "The registration belongs to another activity.");
      requireOwnerOrManager(actor, registration.participantId);
      const { questionnaire } = await releasedArtifacts(trx, activity, registration.questionnaireHash);
      const question = questionFor(questionnaire, input.questionKey);
      if (question.type === "file") {
        throw new DomainError("MATERIAL_NOT_ALLOWED", "File questions must be answered by uploading a material.");
      }
      if (question.type === "notice") {
        throw new DomainError("INVALID_INPUT", "Notice questions cannot receive an answer.");
      }
      if (typeof input.value !== "string") {
        throw new DomainError("INVALID_INPUT", `Question ${question.key} requires a text answer.`);
      }
      const next = saveRegistrationAnswerDomain(
        registration,
        input.expectedRevision,
        question.key,
        input.value,
      );
      const saved = await updateRegistration(trx, next, input.expectedRevision);
      await appendEngineEvent(trx, deps, {
        type: "QuestionnaireAnswered",
        activityId: input.activityId,
        aggregateType: "registration",
        aggregateId: saved.id,
        revision: saved.revision,
        capability: "questionnaire",
        payload: { registrationId: saved.id, questionKey: question.key, revision: saved.revision },
      });
      return { body: saved };
    },
  );
}

export interface SubmitRegistrationInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly registrationId: string;
  readonly expectedRevision: number;
}

export async function submitRegistration(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: SubmitRegistrationInput,
): Promise<CommandOutcome<StoredRegistration>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "registration",
      commandType: "registration.submit",
      actor,
      payload: { registrationId: input.registrationId, expectedRevision: input.expectedRevision },
    },
    async (trx) => {
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      requireActive(activity);
      await requireRegistrationOpen(trx, activity);
      await requireRosterOpen(trx, input.activityId);
      const registration = await getRegistrationForUpdate(trx, input.registrationId);
      if (registration === null) throw new DomainError("NOT_FOUND", `Registration ${input.registrationId} was not found.`);
      if (registration.activityId !== input.activityId) throw new DomainError("CROSS_ACTIVITY", "The registration belongs to another activity.");
      requireOwnerOrManager(actor, registration.participantId);
      const questionnaire = (await releasedArtifacts(trx, activity, registration.questionnaireHash)).questionnaire;
      const materials = await listMaterials(trx, registration.id);
      for (const question of questionnaire.questions) {
        if (!question.required || question.type === "notice") continue;
        if (question.type === "file") {
          if (!materials.some((material) => material.questionKey === question.key && material.current)) {
            throw new DomainError("INVALID_INPUT", `Required file question ${question.key} is incomplete.`, {
              questionKey: question.key,
              label: question.label,
            });
          }
          continue;
        }
        const value = registration.answers[question.key];
        if (typeof value !== "string" || !value.trim()) {
          throw new DomainError("INVALID_INPUT", `Required question ${question.key} is incomplete.`, {
            questionKey: question.key,
            label: question.label,
          });
        }
      }
      const next = submitRegistrationDomain(registration, input.expectedRevision);
      const saved = await updateRegistration(trx, next, input.expectedRevision);
      await appendEngineEvent(trx, deps, {
        type: "RegistrationSubmitted",
        activityId: input.activityId,
        aggregateType: "registration",
        aggregateId: saved.id,
        revision: saved.revision,
        capability: "registration",
        payload: { registrationId: saved.id, revision: saved.revision },
      });
      return { body: saved };
    },
  );
}

export interface ReviewRegistrationInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly registrationId: string;
  readonly expectedRevision: number;
  readonly status: Extract<RegistrationState["status"], "approved" | "need_supplement" | "rejected">;
  readonly note: string;
}

export async function reviewRegistration(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ReviewRegistrationInput,
): Promise<CommandOutcome<StoredRegistration>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "registration",
      commandType: "registration.review",
      actor,
      payload: {
        registrationId: input.registrationId,
        expectedRevision: input.expectedRevision,
        status: input.status,
        note: input.note,
      },
    },
    async (trx) => {
      requirePermission(actor, "registration.review");
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      requireActive(activity);
      // A final roster freezes the approved participant set; reviewing a later
      // submission would desynchronize it from roster.approvedCount.
      const roster = await getRosterForUpdate(trx, input.activityId);
      if (roster.status === "final") {
        throw new DomainError("ROSTER_FINAL", "The roster is final; reviews are frozen.");
      }
      const registration = await getRegistrationForUpdate(trx, input.registrationId);
      if (registration === null) throw new DomainError("NOT_FOUND", `Registration ${input.registrationId} was not found.`);
      if (registration.activityId !== input.activityId) throw new DomainError("CROSS_ACTIVITY", "The registration belongs to another activity.");
      const next = reviewRegistrationDomain(registration, input.expectedRevision, input.status, input.note, actor.actorId);
      const saved = await updateRegistration(trx, next, input.expectedRevision);
      await appendEngineEvent(trx, deps, {
        type: "RegistrationReviewed",
        activityId: input.activityId,
        aggregateType: "registration",
        aggregateId: saved.id,
        revision: saved.revision,
        capability: "registration",
        payload: { registrationId: saved.id, status: saved.status, note: saved.reviewNote ?? "", reviewerId: actor.actorId },
      });
      return { body: saved };
    },
  );
}

export interface FinalizeRosterInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly expectedRevision: number;
}

export async function finalizeRoster(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: FinalizeRosterInput,
): Promise<CommandOutcome<StoredRoster>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "registration",
      commandType: "registration.roster.finalize",
      actor,
      payload: { expectedRevision: input.expectedRevision },
    },
    async (trx) => {
      requirePermission(actor, "registration.roster.finalize");
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      requireActive(activity);
      const roster = await getRosterForUpdate(trx, input.activityId);
      const approvedCount = await listApprovedRegistrationCount(trx, input.activityId);
      // A final roster freezes review, so it may only be entered once every
      // submission has a staff decision. Without this guard an Ops page that
      // happened to read an empty projection could finalize a 0-person roster
      // and permanently strand the submissions it had not loaded yet.
      const pendingCount = await listPendingRegistrationCount(trx, input.activityId);
      if (pendingCount > 0) {
        throw new DomainError(
          "ROSTER_HAS_PENDING",
          "The roster still has submissions awaiting review.",
          { pendingCount },
        );
      }
      const next = finalizeRosterDomain(roster, input.expectedRevision, approvedCount, deps.now());
      const saved = await upsertRoster(trx, input.activityId, next, input.expectedRevision);
      await appendEngineEvent(trx, deps, {
        type: "RosterFinalized",
        activityId: input.activityId,
        aggregateType: "roster",
        aggregateId: input.activityId,
        revision: saved.revision,
        capability: "registration",
        payload: {
          activityId: input.activityId,
          approvedCount: (saved as RosterFinal).approvedCount,
          finalizedAt: (saved as RosterFinal).finalizedAt,
          revision: saved.revision,
        },
      });
      return { body: saved };
    },
  );
}

export interface ReopenRosterInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly expectedRevision: number;
  readonly reason: string;
}

/**
 * Controlled recovery for a roster finalized by mistake. Reopening is its own
 * audited command (with a required reason) so the reversal is visible in the
 * event log instead of requiring direct database surgery.
 */
export async function reopenRoster(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ReopenRosterInput,
): Promise<CommandOutcome<StoredRoster>> {
  const actor = runtimeActor(deps);
  const reason = input.reason.trim();
  if (!reason) throw new DomainError("INVALID_INPUT", "A reason is required to reopen the roster.");
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "registration",
      commandType: "registration.roster.reopen",
      actor,
      payload: { expectedRevision: input.expectedRevision, reason },
    },
    async (trx) => {
      // Reopening is the inverse of finalization, so it reuses that authority.
      requirePermission(actor, "registration.roster.finalize");
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      requireActive(activity);
      const roster = await getRosterForUpdate(trx, input.activityId);
      const next = reopenRosterDomain(roster, input.expectedRevision);
      const saved = await upsertRoster(trx, input.activityId, next, input.expectedRevision);
      await appendEngineEvent(trx, deps, {
        type: "RosterReopened",
        activityId: input.activityId,
        aggregateType: "roster",
        aggregateId: input.activityId,
        revision: saved.revision,
        capability: "registration",
        payload: { activityId: input.activityId, reason, revision: saved.revision },
      });
      return { body: saved };
    },
  );
}

