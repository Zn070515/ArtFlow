import type {
  Database,
  ReadinessSummaryFacts,
  StoredRelease,
  StoredTaskItem,
} from "@artflow-plus/db";
import {
  getActivity,
  getActivityForUpdate,
  getRelease,
  getTaskItemForUpdate,
  listTaskItems,
  summarizeTaskItems,
  syncTaskItems,
  updateTaskItem,
} from "@artflow-plus/db";
import {
  DomainError,
  hasPermission,
  requirePermission,
} from "@artflow-plus/domain";
import type { ActorContext, CompiledTasksArtifact, TaskStatus } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";

export interface SyncTasksInput {
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly commandId: string;
  readonly actor: ActorContext;
}

export interface TaskMutationInput {
  readonly activityId: string;
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly actor: ActorContext;
  readonly commandId: string;
  readonly reason?: string;
  readonly assigneeActorId?: string | null;
  readonly dueAt?: string | null;
}

export interface TaskView extends StoredTaskItem {}

export interface TaskSyncResult {
  readonly definitionVersion: number;
  readonly createdCount: number;
  readonly tasks: readonly TaskView[];
}

export interface TaskListView {
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly tasks: readonly TaskView[];
}

export interface ReadinessView {
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly summary: ReadinessSummaryFacts;
  readonly openTaskKeys: readonly string[];
}

const TASK_READ_PERMISSIONS = [
  "tasks.manage",
  "studio.manage",
  "competition.manage",
  "judge.manage",
  "registration.manage",
  "registration.review",
  "materials.manage",
  "materials.review",
  "grouping.manage",
  "voting.manage",
  "result.manage",
  "archive.manage",
  "ticket.manage",
] as const;

function withActor(deps: RuntimeDeps, actor: ActorContext): RuntimeDeps {
  return { ...deps, actor };
}

function requireTaskRead(actor: ActorContext): void {
  if (!TASK_READ_PERMISSIONS.some((permission) => hasPermission(actor, permission))) {
    throw new DomainError("FORBIDDEN", "A task read permission is required.");
  }
}

function requireTaskEnabled(activity: { readonly enabledCapabilities: readonly string[] }): void {
  if (!activity.enabledCapabilities.includes("tasks")) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", "The tasks capability is not enabled on this activity.");
  }
}

function tasksArtifact(release: StoredRelease): CompiledTasksArtifact {
  const plan = release.capabilities.tasks;
  if (plan === undefined || plan.ok !== true) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The release has no tasks snapshot.");
  }
  const artifact = plan.artifact;
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    (artifact as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((artifact as { templates?: unknown }).templates)
  ) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The tasks release snapshot is invalid.");
  }
  return artifact as CompiledTasksArtifact;
}

async function currentTaskRelease(
  trx: Kysely<Database>,
  activity: { readonly id: string; readonly activeDefinitionVersion: number; readonly enabledCapabilities: readonly string[] },
): Promise<{ readonly release: StoredRelease; readonly artifact: CompiledTasksArtifact }> {
  requireTaskEnabled(activity);
  const release = await getRelease(trx, activity.id, activity.activeDefinitionVersion);
  if (release === null) {
    throw new DomainError("VERSION_NOT_RELEASED", "The activity has no active released definition.");
  }
  return { release, artifact: tasksArtifact(release) };
}

async function requireCurrentDefinitionVersion(
  trx: Kysely<Database>,
  activity: { readonly id: string; readonly activeDefinitionVersion: number; readonly enabledCapabilities: readonly string[] },
  requestedVersion: number,
): Promise<{ readonly release: StoredRelease; readonly artifact: CompiledTasksArtifact }> {
  if (requestedVersion !== activity.activeDefinitionVersion) {
    throw new DomainError(
      "CAPABILITY_VERSION_MISMATCH",
      `Tasks must be synced against the current definition version ${activity.activeDefinitionVersion}.`,
    );
  }
  return currentTaskRelease(trx, activity);
}

export async function syncTasks(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: SyncTasksInput,
): Promise<CommandOutcome<TaskSyncResult>> {
  const actor = input.actor;
  const eventDeps = withActor(deps, actor);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "tasks",
      commandType: "tasks.sync",
      actor,
      payload: { definitionVersion: input.definitionVersion },
    },
    async (trx) => {
      requirePermission(actor, "tasks.manage");
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      const { artifact } = await requireCurrentDefinitionVersion(trx, activity, input.definitionVersion);
      const existing = await listTaskItems(trx, input.activityId, input.definitionVersion);
      const tasks = await syncTaskItems(trx, input.activityId, input.definitionVersion, artifact.templates);
      const createdCount = Math.max(0, tasks.length - existing.length);
      await appendEngineEvent(trx, eventDeps, {
        type: "tasks.changed",
        activityId: input.activityId,
        aggregateType: "task_item",
        aggregateId: input.activityId,
        revision: activity.revision,
        capability: "tasks",
        payload: { definitionVersion: input.definitionVersion, createdCount },
      });
      return {
        body: { definitionVersion: input.definitionVersion, createdCount, tasks },
      };
    },
  );
}

type MutationKind = "assign" | "start" | "block" | "complete" | "reopen";

function normalizedReason(input: TaskMutationInput, kind: MutationKind): string | null {
  if (kind !== "block" && kind !== "complete" && kind !== "reopen") return null;
  const reason = input.reason?.trim() ?? "";
  if (!reason) throw new DomainError("INVALID_INPUT", `${kind} requires a non-empty reason.`);
  return reason;
}

function nextTaskState(
  task: StoredTaskItem,
  input: TaskMutationInput,
  kind: MutationKind,
): { readonly status: TaskStatus; readonly blockedReason: string | null; readonly completionReason: string | null } {
  const reason = normalizedReason(input, kind);
  if (kind === "assign") {
    return {
      status: task.status,
      blockedReason: task.blockedReason,
      completionReason: task.completionReason,
    };
  }
  if (kind === "start") {
    if (task.status !== "pending") throw new DomainError("INVALID_TRANSITION", "Only a pending task can start.");
    return { status: "in_progress", blockedReason: task.blockedReason, completionReason: task.completionReason };
  }
  if (kind === "block") {
    if (task.status !== "pending" && task.status !== "in_progress") {
      throw new DomainError("INVALID_TRANSITION", "Only a pending or in-progress task can be blocked.");
    }
    return { status: "blocked", blockedReason: reason, completionReason: null };
  }
  if (kind === "complete") {
    if (task.status !== "in_progress") {
      throw new DomainError("INVALID_TRANSITION", "Only an in-progress task can be completed.");
    }
    return { status: "done", blockedReason: null, completionReason: reason };
  }
  if (task.status === "done") return { status: "pending", blockedReason: null, completionReason: null };
  if (task.status === "blocked") return { status: "in_progress", blockedReason: null, completionReason: null };
  throw new DomainError("INVALID_TRANSITION", "Only a done or blocked task can be reopened.");
}

async function mutateTask(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: TaskMutationInput,
  kind: MutationKind,
): Promise<CommandOutcome<TaskView>> {
  const actor = input.actor;
  const eventDeps = withActor(deps, actor);
  const commandType = `tasks.${kind}`;
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "tasks",
      commandType,
      actor,
      payload: {
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        ...(kind === "assign" ? {
          assigneeActorId: input.assigneeActorId ?? null,
          dueAt: input.dueAt ?? null,
        } : {}),
        ...(kind === "block" || kind === "complete" || kind === "reopen"
          ? { reason: input.reason?.trim() ?? "" }
          : {}),
      },
    },
    async (trx) => {
      requirePermission(actor, "tasks.manage");
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      requireTaskEnabled(activity);
      const task = await getTaskItemForUpdate(trx, input.activityId, input.taskId);
      if (task === null) throw new DomainError("NOT_FOUND", `Task ${input.taskId} was not found.`);
      if (task.definitionVersion !== activity.activeDefinitionVersion) {
        throw new DomainError("CAPABILITY_VERSION_MISMATCH", "Historical task versions are read-only.");
      }
      if (task.revision !== input.expectedRevision) {
        throw new DomainError("STALE_REVISION", "The task changed since it was read.");
      }
      const next = nextTaskState(task, input, kind);
      const saved = await updateTaskItem(trx, {
        taskId: task.id,
        expectedRevision: task.revision,
        status: next.status,
        assigneeActorId: kind === "assign" ? input.assigneeActorId ?? null : task.assigneeActorId,
        dueAt: kind === "assign" ? input.dueAt ?? null : task.dueAt,
        blockedReason: next.blockedReason,
        completionReason: next.completionReason,
      });
      await appendEngineEvent(trx, eventDeps, {
        type: "tasks.changed",
        activityId: input.activityId,
        aggregateType: "task_item",
        aggregateId: saved.id,
        revision: saved.revision,
        capability: "tasks",
        payload: {
          taskId: saved.id,
          templateKey: saved.templateKey,
          status: saved.status,
          revision: saved.revision,
          ...(input.reason === undefined ? {} : { reason: input.reason.trim() }),
        },
      });
      return { body: saved };
    },
  );
}

export function assignTask(db: Kysely<Database>, deps: RuntimeDeps, input: TaskMutationInput): Promise<CommandOutcome<TaskView>> {
  return mutateTask(db, deps, input, "assign");
}

export function startTask(db: Kysely<Database>, deps: RuntimeDeps, input: TaskMutationInput): Promise<CommandOutcome<TaskView>> {
  return mutateTask(db, deps, input, "start");
}

export function blockTask(db: Kysely<Database>, deps: RuntimeDeps, input: TaskMutationInput): Promise<CommandOutcome<TaskView>> {
  return mutateTask(db, deps, input, "block");
}

export function completeTask(db: Kysely<Database>, deps: RuntimeDeps, input: TaskMutationInput): Promise<CommandOutcome<TaskView>> {
  return mutateTask(db, deps, input, "complete");
}

export function reopenTask(db: Kysely<Database>, deps: RuntimeDeps, input: TaskMutationInput): Promise<CommandOutcome<TaskView>> {
  return mutateTask(db, deps, input, "reopen");
}

async function readTaskContext(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<{ readonly release: StoredRelease; readonly artifact: CompiledTasksArtifact }> {
  const actor = runtimeActor(deps);
  requireTaskRead(actor);
  const activity = await getActivity(db, activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${activityId} was not found.`);
  const context = await currentTaskRelease(db, activity);
  return {
    release: context.release,
    artifact: context.artifact,
  };
}

export async function listTasks(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<TaskListView> {
  const context = await readTaskContext(db, deps, activityId);
  return {
    activityId,
    definitionVersion: context.release.version,
    tasks: await listTaskItems(db, activityId, context.release.version),
  };
}

export async function readReadiness(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<ReadinessView> {
  const context = await readTaskContext(db, deps, activityId);
  const tasks = await listTaskItems(db, activityId, context.release.version);
  const summary = await summarizeTaskItems(db, activityId, context.release.version, deps.now());
  return {
    activityId,
    definitionVersion: context.release.version,
    summary,
    openTaskKeys: tasks.filter((task) => task.status !== "done").map((task) => task.templateKey),
  };
}
