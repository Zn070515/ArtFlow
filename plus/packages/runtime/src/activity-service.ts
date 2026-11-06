import type { Database } from "@artflow-plus/db";
import {
  getActivity as readActivity,
  getActivityForUpdate,
  insertActivity,
  insertDraft,
  listSessionRecords,
  updateActivity,
} from "@artflow-plus/db";
import type {
  Activity,
  ActivityDefinitionPackage,
  CapabilityRegistry,
} from "@artflow-plus/domain";
import {
  activateActivity as activateActivityDomain,
  closeActivity as closeActivityDomain,
  createActivity as createActivityDomain,
  DomainError,
  renameActivity as renameActivityDomain,
  requirePermission,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { CompositionError } from "./errors.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand } from "./hash.js";

export interface CreateActivityInput {
  readonly commandId: string;
  readonly title: string;
  readonly capabilities?: readonly string[];
  /** Pack output: the uncompiled package becomes draft revision 0. */
  readonly initialDefinition?: ActivityDefinitionPackage;
}

export async function createActivity(
  db: Kysely<Database>,
  registry: CapabilityRegistry,
  deps: RuntimeDeps,
  input: CreateActivityInput,
): Promise<CommandOutcome<Activity>> {
  const activityId = idFromCommand("act", input.commandId);

  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId,
      capability: "engine",
      commandType: "activity.create",
      actor: runtimeActor(deps),
      payload: {
        title: input.title,
        capabilities: input.capabilities ?? [],
        initialDefinition: input.initialDefinition ?? null,
      },
    },
    async (trx) => {
      // Validation runs after the receipt claim, so a retry of an accepted
      // command replays even if the current registry would reject it.
      const composition = registry.validateComposition({
        enable: input.capabilities ?? [],
      });
      if (!composition.ok) {
        throw new CompositionError(composition.issues);
      }
      const activity = createActivityDomain({
        id: activityId,
        title: input.title,
        capabilities: composition.plan.enabledCapabilities,
      });
      await insertActivity(trx, activity);
      if (input.initialDefinition !== undefined) {
        await insertDraft(trx, {
          activityId: activity.id,
          revision: 0,
          package: input.initialDefinition,
        });
      }
      await appendEngineEvent(trx, deps, {
        type: "ActivityCreated",
        activityId: activity.id,
        aggregateType: "activity",
        aggregateId: activity.id,
        revision: activity.revision,
        payload: {
          activityId: activity.id,
          title: activity.title,
          enabledCapabilities: activity.enabledCapabilities,
        },
      });
      return { body: activity, status: 201 };
    },
  );
}

export interface ActivateActivityInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly expectedRevision: number;
}

export async function activateActivity(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ActivateActivityInput,
): Promise<CommandOutcome<Activity>> {
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "engine",
      commandType: "activity.activate",
      actor: runtimeActor(deps),
      payload: { expectedRevision: input.expectedRevision },
    },
    async (trx) => {
      const current = await getActivityForUpdate(trx, input.activityId);
      if (current === null) {
        throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      }
      const next = activateActivityDomain(current, input.expectedRevision);
      const saved = await updateActivity(trx, next, current.revision);
      await appendEngineEvent(trx, deps, {
        type: "ActivityActivated",
        activityId: saved.id,
        aggregateType: "activity",
        aggregateId: saved.id,
        revision: saved.revision,
        payload: {
          activityId: saved.id,
          status: saved.status,
          revision: saved.revision,
        },
      });
      return { body: saved };
    },
  );
}

export interface CloseActivityInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly expectedRevision: number;
}

export async function closeActivity(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: CloseActivityInput,
): Promise<CommandOutcome<Activity>> {
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "engine",
      commandType: "activity.close",
      actor: runtimeActor(deps),
      payload: { expectedRevision: input.expectedRevision },
    },
    async (trx) => {
      requirePermission(runtimeActor(deps), "studio.manage");
      const current = await getActivityForUpdate(trx, input.activityId);
      if (current === null) {
        throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      }
      const sessions = await listSessionRecords(trx, input.activityId);
      const next = closeActivityDomain(current, input.expectedRevision, sessions);
      const saved = await updateActivity(trx, next, current.revision);
      await appendEngineEvent(trx, deps, {
        type: "ActivityClosed",
        activityId: saved.id,
        aggregateType: "activity",
        aggregateId: saved.id,
        revision: saved.revision,
        payload: { activityId: saved.id, status: saved.status, revision: saved.revision },
      });
      return { body: saved };
    },
  );
}

export interface RenameActivityInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly title: string;
  readonly expectedRevision: number;
}

export async function renameActivity(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: RenameActivityInput,
): Promise<CommandOutcome<Activity>> {
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "engine",
      commandType: "activity.rename",
      actor: runtimeActor(deps),
      payload: { title: input.title, expectedRevision: input.expectedRevision },
    },
    async (trx) => {
      requirePermission(runtimeActor(deps), "studio.manage");
      const current = await getActivityForUpdate(trx, input.activityId);
      if (current === null) {
        throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      }
      const next = renameActivityDomain(current, input.title, input.expectedRevision);
      const saved = await updateActivity(trx, next, current.revision);
      await appendEngineEvent(trx, deps, {
        type: "ActivityRenamed",
        activityId: saved.id,
        aggregateType: "activity",
        aggregateId: saved.id,
        revision: saved.revision,
        payload: { activityId: saved.id, title: saved.title, revision: saved.revision },
      });
      return { body: saved };
    },
  );
}

export async function getActivity(
  db: Kysely<Database>,
  activityId: string,
): Promise<Activity | null> {
  return readActivity(db, activityId);
}
