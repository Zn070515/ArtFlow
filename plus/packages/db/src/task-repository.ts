import { createHash } from "node:crypto";

import type { TaskStatus, TaskTemplate } from "@artflow-plus/domain";
import type { Kysely, Selectable, Transaction } from "kysely";

import { StaleRevisionError } from "./activity-repository.js";
import type { Database, TaskItemRow } from "./types.js";

export type StoredTaskItem = {
  readonly id: string;
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly templateKey: string;
  readonly title: string;
  readonly sourceCapability: string;
  readonly sourceKey: string;
  readonly required: boolean;
  readonly status: TaskStatus;
  readonly assigneeActorId: string | null;
  readonly dueAt: string | null;
  readonly blockedReason: string | null;
  readonly completionReason: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type TaskItemMutation = {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly status: TaskStatus;
  readonly assigneeActorId: string | null;
  readonly dueAt: string | null;
  readonly blockedReason: string | null;
  readonly completionReason: string | null;
};

export type ReadinessSummaryFacts = {
  readonly total: number;
  readonly required: number;
  readonly done: number;
  readonly open: number;
  readonly blocked: number;
  readonly overdue: number;
  readonly byStatus: Readonly<Record<TaskStatus, number>>;
  readonly bySourceCapability: Readonly<Record<string, number>>;
};

type TaskItemSelectRow = Selectable<TaskItemRow>;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function rowToTask(row: TaskItemSelectRow): StoredTaskItem {
  return {
    id: row.id,
    activityId: row.activity_id,
    definitionVersion: row.definition_version,
    templateKey: row.template_key,
    title: row.title,
    sourceCapability: row.source_capability,
    sourceKey: row.source_key,
    required: row.required,
    status: row.status as TaskStatus,
    assigneeActorId: row.assignee_actor_id,
    dueAt: toNullableIso(row.due_at),
    blockedReason: row.blocked_reason,
    completionReason: row.completion_reason,
    revision: row.revision,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function taskId(activityId: string, definitionVersion: number, templateKey: string): string {
  const digest = createHash("sha256")
    .update(`${activityId}\0${definitionVersion}\0${templateKey}`)
    .digest("hex");
  return `task-${digest}`;
}

export async function syncTaskItems(
  trx: Transaction<Database>,
  activityId: string,
  definitionVersion: number,
  templates: readonly TaskTemplate[],
): Promise<readonly StoredTaskItem[]> {
  if (templates.length > 0) {
    const now = new Date();
    await trx
      .insertInto("task_item")
      .values(templates.map((template) => ({
        id: taskId(activityId, definitionVersion, template.key),
        activity_id: activityId,
        definition_version: definitionVersion,
        template_key: template.key,
        title: template.title,
        source_capability: template.sourceCapability,
        source_key: template.sourceKey,
        required: template.required,
        status: "pending",
        assignee_actor_id: null,
        due_at: null,
        blocked_reason: null,
        completion_reason: null,
        revision: 0,
        created_at: now,
        updated_at: now,
      })))
      .onConflict((conflict) =>
        conflict.columns(["activity_id", "definition_version", "template_key"]).doNothing(),
      )
      .execute();
  }
  return listTaskItems(trx, activityId, definitionVersion);
}

export async function getTaskItemForUpdate(
  trx: Transaction<Database>,
  activityId: string,
  taskIdValue: string,
): Promise<StoredTaskItem | null> {
  const row = await trx
    .selectFrom("task_item")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("id", "=", taskIdValue)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : rowToTask(row);
}

export async function listTaskItems(
  db: Kysely<Database>,
  activityId: string,
  definitionVersion: number,
): Promise<readonly StoredTaskItem[]> {
  const rows = await db
    .selectFrom("task_item")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("definition_version", "=", definitionVersion)
    .orderBy("template_key")
    .orderBy("id")
    .execute();
  return rows.map(rowToTask);
}

export async function updateTaskItem(
  trx: Transaction<Database>,
  mutation: TaskItemMutation,
): Promise<StoredTaskItem> {
  const row = await trx
    .updateTable("task_item")
    .set({
      status: mutation.status,
      assignee_actor_id: mutation.assigneeActorId,
      due_at: mutation.dueAt,
      blocked_reason: mutation.blockedReason,
      completion_reason: mutation.completionReason,
      revision: mutation.expectedRevision + 1,
      updated_at: new Date(),
    })
    .where("id", "=", mutation.taskId)
    .where("revision", "=", mutation.expectedRevision)
    .returningAll()
    .executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(mutation.taskId);
  return rowToTask(row);
}

export async function summarizeTaskItems(
  db: Kysely<Database>,
  activityId: string,
  definitionVersion: number,
  now = new Date().toISOString(),
): Promise<ReadinessSummaryFacts> {
  const tasks = await listTaskItems(db, activityId, definitionVersion);
  const byStatus: Record<TaskStatus, number> = {
    pending: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
  };
  const bySourceCapability: Record<string, number> = {};
  let required = 0;
  let done = 0;
  let open = 0;
  let blocked = 0;
  let overdue = 0;
  const nowMillis = Date.parse(now);

  for (const task of tasks) {
    if (task.required) required += 1;
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    bySourceCapability[task.sourceCapability] = (bySourceCapability[task.sourceCapability] ?? 0) + 1;
    if (task.status === "done") done += 1;
    if (task.status === "pending" || task.status === "in_progress") open += 1;
    if (task.status === "blocked") blocked += 1;
    if (task.status !== "done" && task.dueAt !== null && Date.parse(task.dueAt) < nowMillis) {
      overdue += 1;
    }
  }

  return {
    total: tasks.length,
    required,
    done,
    open,
    blocked,
    overdue,
    byStatus,
    bySourceCapability,
  };
}
