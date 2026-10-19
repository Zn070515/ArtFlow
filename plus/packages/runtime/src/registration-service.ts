import type { Database, StoredRegistration, StoredRoster } from "@artflow-plus/db";
import {
  getActivityForUpdate,
  getRegistrationByParticipantForUpdate,
  getRegistrationForUpdate,
  getRelease,
  getRosterForUpdate,
  findRunningSessionByScope,
  insertRegistration,
  listApprovedRegistrationCount,
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
  requireFinalRoster,
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
  const plan = release.capabilities[key];
  if (plan === undefined || plan.ok !== true) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", `Release is missing the ${key} snapshot.`);
  }
  return plan.artifact as T;
}

async function releasedArtifacts(
  trx: Kysely<Database>,
  activity: { readonly id: string; readonly activeDefinitionVersion: number; readonly enabledCapabilities: readonly string[] },
): Promise<{
  readonly questionnaire: CompiledQuestionnaireArtifact;
  readonly materials: CompiledMaterialsArtifact;
}> {
  const release = await getRelease(trx, activity.id, activity.activeDefinitionVersion);
  if (release === null) {
    throw new DomainError("VERSION_NOT_RELEASED", "The activity has no active released definition.");
  }
  return {
    questionnaire: activeCapability<CompiledQuestionnaireArtifact>(activity, release, "questionnaire"),
    materials: activeCapability<CompiledMaterialsArtifact>(activity, release, "materials"),
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

function requireOwnerOrManager(
  actor: Parameters<typeof canActFor>[0],
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
      const registration = await getRegistrationForUpdate(trx, input.registrationId);
      if (registration === null) throw new DomainError("NOT_FOUND", `Registration ${input.registrationId} was not found.`);
      if (registration.activityId !== input.activityId) throw new DomainError("CROSS_ACTIVITY", "The registration belongs to another activity.");
      requireOwnerOrManager(actor, registration.participantId);
      const { questionnaire } = await releasedArtifacts(trx, activity);
      const question = questionFor(questionnaire, input.questionKey);
      if (question.type === "file") {
        throw new DomainError("MATERIAL_NOT_ALLOWED", "File questions must be answered by uploading a material.");
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
      const registration = await getRegistrationForUpdate(trx, input.registrationId);
      if (registration === null) throw new DomainError("NOT_FOUND", `Registration ${input.registrationId} was not found.`);
      if (registration.activityId !== input.activityId) throw new DomainError("CROSS_ACTIVITY", "The registration belongs to another activity.");
      requireOwnerOrManager(actor, registration.participantId);
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

export interface PrepareCompetitionRoundInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundKey: string;
  readonly scope: string;
}

export interface PreparedCompetitionRound {
  readonly activityId: string;
  readonly roundKey: string;
  readonly scope: string;
  readonly mode: "test" | "rehearsal" | "formal";
  readonly participantCount: number;
  readonly rosterRevision: number;
}

export async function prepareCompetitionRound(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: PrepareCompetitionRoundInput,
): Promise<CommandOutcome<PreparedCompetitionRound>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "competition",
      commandType: "competition.round.prepare",
      scope: input.scope,
      actor,
      payload: { roundKey: input.roundKey, scope: input.scope },
    },
    async (trx) => {
      requirePermission(actor, "registration.roster.finalize");
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      requireActive(activity);
      const release = await getRelease(trx, input.activityId, activity.activeDefinitionVersion);
      if (release === null) throw new DomainError("VERSION_NOT_RELEASED", "The activity has no active released definition.");
      if (release.executionPolicy.declaredScopes.length > 0 && !release.executionPolicy.declaredScopes.includes(input.scope)) {
        throw new DomainError("SCOPE_UNDECLARED", `Scope ${input.scope} is not declared by the release.`);
      }
      const roster = requireFinalRoster(await getRosterForUpdate(trx, input.activityId));
      const session = await findRunningSessionByScope(trx, input.activityId, input.scope);
      if (session === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution session.`);
      const body: PreparedCompetitionRound = {
        activityId: input.activityId,
        roundKey: input.roundKey,
        scope: input.scope,
        mode: session.mode,
        participantCount: roster.approvedCount,
        rosterRevision: roster.revision,
      };
      await appendEngineEvent(trx, deps, {
        type: "CompetitionRoundPrepared",
        activityId: input.activityId,
        aggregateType: "competition_round",
        aggregateId: `${input.activityId}:${input.roundKey}`,
        revision: roster.revision,
        capability: "competition",
        mode: session.mode,
        scope: session.scope,
        payload: body,
      });
      return { body, status: 201 };
    },
  );
}
