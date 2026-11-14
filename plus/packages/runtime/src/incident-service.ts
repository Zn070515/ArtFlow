import type { Database } from "@artflow-plus/db";
import {
  StaleRevisionError,
  getActivityForUpdate,
  getIncident,
  getIncidentForUpdate,
  insertIncident,
  listIncidents,
  updateIncident,
} from "@artflow-plus/db";
import type {
  IncidentMode,
  IncidentRelatedType,
  StoredIncident,
} from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import {
  DomainError,
  requirePermission,
  type IncidentCategory,
  type IncidentSeverity,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand } from "./hash.js";

const MODES: readonly IncidentMode[] = ["test", "rehearsal", "formal"];
const SEVERITIES: readonly IncidentSeverity[] = ["low", "medium", "high", "critical"];
const CATEGORIES: readonly IncidentCategory[] = [
  "participant",
  "judge",
  "stage",
  "technical",
  "safety",
  "other",
];
const RELATED_TYPES: readonly IncidentRelatedType[] = [
  "schedule_entry",
  "performance",
  "round",
  "registration",
];

function choice<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) {
    throw new DomainError("INVALID_INPUT", `${field} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

function text(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) {
    throw new DomainError("INVALID_INPUT", `${field} must be 1-${max} characters.`);
  }
  return trimmed;
}

function requireActive(activity: { readonly status: string }): void {
  if (activity.status !== "active") {
    throw new DomainError("ACTIVITY_NOT_ACTIVE", "Incident commands require an active activity.");
  }
}

function requireManager(actor: ActorContext): void {
  requirePermission(actor, "incident.manage");
}

async function staleSafe<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof StaleRevisionError) {
      throw new DomainError("STALE_REVISION", "The incident changed; refresh and retry.");
    }
    throw error;
  }
}

export async function getIncidents(
  db: Kysely<Database>,
  activityId: string,
  mode?: IncidentMode,
): Promise<readonly StoredIncident[]> {
  return listIncidents(db, activityId, mode);
}

export interface OpenIncidentInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly mode: string;
  readonly severity: string;
  readonly category: string;
  readonly title: string;
  readonly detail?: string;
  readonly location?: string;
  readonly relatedType?: string | null;
  readonly relatedId?: string | null;
}

export async function openIncident(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: OpenIncidentInput,
): Promise<CommandOutcome<StoredIncident>> {
  const actor = runtimeActor(deps);
  const mode = choice(input.mode, MODES, "mode");
  const severity = choice(input.severity, SEVERITIES, "severity");
  const category = choice(input.category, CATEGORIES, "category");
  const relatedType = input.relatedType === undefined || input.relatedType === null
    ? null
    : choice(input.relatedType, RELATED_TYPES, "relatedType");
  const relatedId = input.relatedId ?? null;
  if ((relatedType === null) !== (relatedId === null)) {
    throw new DomainError("INVALID_INPUT", "relatedType and relatedId must be provided together.");
  }
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "incident",
      commandType: "incident.open",
      actor,
      payload: {
        mode,
        severity,
        category,
        title: input.title,
        detail: input.detail ?? "",
        location: input.location ?? "",
        relatedType,
        relatedId,
      },
    },
    async (trx) => {
      requireManager(actor);
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
      requireActive(activity);
      const incident = await insertIncident(trx, {
        id: idFromCommand("incident", `${activity.id}:${input.commandId}`),
        activityId: activity.id,
        mode,
        severity,
        category,
        status: "open",
        title: text(input.title, "title", 200),
        detail: (input.detail ?? "").slice(0, 2000),
        location: (input.location ?? "").slice(0, 200),
        relatedType,
        relatedId,
        assigneeId: null,
        resolution: "",
        openedBy: actor.actorId,
        revision: 0,
        createdAt: deps.now(),
        updatedAt: deps.now(),
      });
      await appendEngineEvent(trx, deps, {
        type: "IncidentOpened",
        activityId: activity.id,
        aggregateType: "incident",
        aggregateId: incident.id,
        revision: incident.revision,
        mode,
        scope: "incident",
        capability: "incident",
        payload: { incidentId: incident.id, severity, category, title: incident.title },
      });
      return { body: incident, status: 201 };
    },
  );
}

async function loadIncident(
  trx: Kysely<Database>,
  activityId: string,
  incidentId: string,
): Promise<StoredIncident> {
  const incident = await getIncidentForUpdate(trx, incidentId);
  if (incident === null || incident.activityId !== activityId) {
    throw new DomainError("NOT_FOUND", "The incident was not found.");
  }
  return incident;
}

export interface IncidentCommandInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly incidentId: string;
  readonly expectedRevision: number;
}

export async function acknowledgeIncident(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: IncidentCommandInput,
): Promise<CommandOutcome<StoredIncident>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "incident",
      commandType: "incident.acknowledge",
      actor,
      payload: { incidentId: input.incidentId },
    },
    async (trx) => {
      requireManager(actor);
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
      requireActive(activity);
      const incident = await loadIncident(trx, activity.id, input.incidentId);
      if (incident.status !== "open") {
        throw new DomainError("INVALID_TRANSITION", "Only an open incident can be acknowledged.");
      }
      const updated = await staleSafe(() => updateIncident(trx, {
        ...incident,
        status: "acknowledged",
        assigneeId: actor.actorId,
      }, input.expectedRevision));
      await appendEngineEvent(trx, deps, {
        type: "IncidentAcknowledged",
        activityId: activity.id,
        aggregateType: "incident",
        aggregateId: updated.id,
        revision: updated.revision,
        mode: updated.mode,
        scope: "incident",
        capability: "incident",
        payload: { incidentId: updated.id, assigneeId: updated.assigneeId },
      });
      return { body: updated };
    },
  );
}

export interface ResolveIncidentInput extends IncidentCommandInput {
  readonly resolution: string;
}

export async function resolveIncident(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ResolveIncidentInput,
): Promise<CommandOutcome<StoredIncident>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "incident",
      commandType: "incident.resolve",
      actor,
      payload: { incidentId: input.incidentId, resolution: input.resolution },
    },
    async (trx) => {
      requireManager(actor);
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
      requireActive(activity);
      const incident = await loadIncident(trx, activity.id, input.incidentId);
      if (incident.status === "resolved") {
        throw new DomainError("INVALID_TRANSITION", "The incident is already resolved.");
      }
      const updated = await staleSafe(() => updateIncident(trx, {
        ...incident,
        status: "resolved",
        resolution: text(input.resolution, "resolution", 2000),
      }, input.expectedRevision));
      await appendEngineEvent(trx, deps, {
        type: "IncidentResolved",
        activityId: activity.id,
        aggregateType: "incident",
        aggregateId: updated.id,
        revision: updated.revision,
        mode: updated.mode,
        scope: "incident",
        capability: "incident",
        payload: { incidentId: updated.id, resolution: updated.resolution },
      });
      return { body: updated };
    },
  );
}

export interface ReopenIncidentInput extends IncidentCommandInput {
  readonly reason: string;
}

export async function reopenIncident(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ReopenIncidentInput,
): Promise<CommandOutcome<StoredIncident>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "incident",
      commandType: "incident.reopen",
      actor,
      payload: { incidentId: input.incidentId, reason: input.reason },
    },
    async (trx) => {
      requireManager(actor);
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
      requireActive(activity);
      const incident = await loadIncident(trx, activity.id, input.incidentId);
      if (incident.status !== "resolved") {
        throw new DomainError("INVALID_TRANSITION", "Only a resolved incident can be reopened.");
      }
      const reason = text(input.reason, "reason", 500);
      const updated = await staleSafe(() => updateIncident(trx, {
        ...incident,
        status: "open",
        resolution: "",
      }, input.expectedRevision));
      await appendEngineEvent(trx, deps, {
        type: "IncidentReopened",
        activityId: activity.id,
        aggregateType: "incident",
        aggregateId: updated.id,
        revision: updated.revision,
        mode: updated.mode,
        scope: "incident",
        capability: "incident",
        payload: { incidentId: updated.id, reason },
      });
      return { body: updated };
    },
  );
}

export async function getIncidentById(
  db: Kysely<Database>,
  incidentId: string,
): Promise<StoredIncident | null> {
  return getIncident(db, incidentId);
}
