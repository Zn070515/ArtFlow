import { randomUUID } from "node:crypto";

import type { TaskStatus, TaskTemplate } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  getTaskItemForUpdate,
  listTaskItems,
  migrate,
  StaleRevisionError,
  summarizeTaskItems,
  syncTaskItems,
  updateTaskItem,
} from "../src/index.js";
import type { Database, StoredTaskItem, TaskItemMutation } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_tasks_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const templates: readonly TaskTemplate[] = [
  {
    key: "registration.review",
    title: "审核报名",
    sourceCapability: "registration",
    sourceKey: "review",
    required: true,
  },
  {
    key: "materials.audio",
    title: "确认音频",
    sourceCapability: "materials",
    sourceKey: "audio",
    required: true,
  },
];

async function seedActivity(activityId: string): Promise<void> {
  await db.insertInto("activity").values({
    id: activityId,
    title: "Task repository test",
    status: "active",
    revision: 0,
    enabled_capabilities: JSON.stringify(["tasks", "registration", "materials"]),
    active_definition_version: 1,
  }).execute();
}

function mutation(task: StoredTaskItem, overrides: Partial<TaskItemMutation> = {}): TaskItemMutation {
  return {
    taskId: task.id,
    expectedRevision: task.revision,
    status: task.status,
    assigneeActorId: task.assigneeActorId,
    dueAt: task.dueAt,
    blockedReason: task.blockedReason,
    completionReason: task.completionReason,
    ...overrides,
  };
}

describe.skipIf(!connectionString)("task repository on PostgreSQL", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("syncs one row per versioned template without overwriting existing facts", async () => {
    const activityId = `task-sync-${randomUUID()}`;
    await seedActivity(activityId);

    const initial = await db.transaction().execute((trx) =>
      syncTaskItems(trx, activityId, 1, templates),
    );
    expect(initial).toHaveLength(2);
    const target = initial.find((item) => item.templateKey === "registration.review")!;
    const saved = await db.transaction().execute((trx) =>
      updateTaskItem(trx, mutation(target, {
        status: "blocked",
        assigneeActorId: "actor-1",
        dueAt: "2026-10-20T10:00:00.000Z",
        blockedReason: "等待补件",
      })),
    );

    const retried = await db.transaction().execute((trx) =>
      syncTaskItems(trx, activityId, 1, [
        { ...templates[0]!, title: "不能覆盖的标题", sourceKey: "changed", required: false },
        templates[1]!,
      ]),
    );
    expect(retried).toHaveLength(2);
    expect(retried.find((item) => item.id === saved.id)).toMatchObject({
      title: "审核报名",
      sourceKey: "review",
      required: true,
      status: "blocked",
      assigneeActorId: "actor-1",
      dueAt: "2026-10-20T10:00:00.000Z",
      blockedReason: "等待补件",
    });
  });

  it("creates independent task rows for a new definition version", async () => {
    const activityId = `task-version-${randomUUID()}`;
    await seedActivity(activityId);

    const first = await db.transaction().execute((trx) =>
      syncTaskItems(trx, activityId, 1, templates),
    );
    const second = await db.transaction().execute((trx) =>
      syncTaskItems(trx, activityId, 2, templates),
    );

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(second.map((item) => item.id)).not.toEqual(first.map((item) => item.id));
    expect((await listTaskItems(db, activityId, 1)).every((item) => item.definitionVersion === 1)).toBe(true);
    expect((await listTaskItems(db, activityId, 2)).every((item) => item.definitionVersion === 2)).toBe(true);
  });

  it("locks and updates a task with compare-and-swap revision", async () => {
    const activityId = `task-occ-${randomUUID()}`;
    await seedActivity(activityId);
    const [task] = await db.transaction().execute((trx) =>
      syncTaskItems(trx, activityId, 1, [templates[0]!]),
    );
    if (!task) throw new Error("task fixture was not created");

    const locked = await db.transaction().execute((trx) =>
      getTaskItemForUpdate(trx, activityId, task.id),
    );
    expect(locked?.revision).toBe(0);
    await db.transaction().execute((trx) =>
      updateTaskItem(trx, mutation(task, { status: "in_progress" })),
    );
    await expect(db.transaction().execute((trx) =>
      updateTaskItem(trx, mutation(task, { status: "done" })),
    )).rejects.toBeInstanceOf(StaleRevisionError);
  });

  it("aggregates readiness by status, source, and unfinished due time", async () => {
    const activityId = `task-summary-${randomUUID()}`;
    await seedActivity(activityId);
    const summaryTemplates: readonly TaskTemplate[] = [
      ...templates,
      { key: "competition.review", title: "评审", sourceCapability: "competition", sourceKey: "review", required: false },
      { key: "archive.package", title: "归档", sourceCapability: "archive", sourceKey: "package", required: true },
    ];
    const tasks = await db.transaction().execute((trx) =>
      syncTaskItems(trx, activityId, 1, summaryTemplates),
    );
    const byKey = new Map(tasks.map((task) => [task.templateKey, task]));
    await db.transaction().execute((trx) => updateTaskItem(trx, mutation(byKey.get("registration.review")!, {
      dueAt: "2026-10-01T00:00:00.000Z",
    })));
    await db.transaction().execute((trx) => updateTaskItem(trx, mutation(byKey.get("materials.audio")!, {
      status: "in_progress",
      dueAt: "2026-12-01T00:00:00.000Z",
    })));
    await db.transaction().execute((trx) => updateTaskItem(trx, mutation(byKey.get("competition.review")!, {
      status: "blocked",
      dueAt: "2026-10-01T00:00:00.000Z",
      blockedReason: "等待评委",
    })));
    await db.transaction().execute((trx) => updateTaskItem(trx, mutation(byKey.get("archive.package")!, {
      status: "done",
      dueAt: "2026-10-01T00:00:00.000Z",
      completionReason: "已归档",
    })));

    expect(await summarizeTaskItems(db, activityId, 1, "2026-11-01T00:00:00.000Z")).toEqual({
      total: 4,
      required: 3,
      done: 1,
      open: 2,
      blocked: 1,
      overdue: 2,
      byStatus: { pending: 1, in_progress: 1, blocked: 1, done: 1 },
      bySourceCapability: { archive: 1, competition: 1, materials: 1, registration: 1 },
    });
  });

  it("returns an empty readiness summary for an activity without task rows", async () => {
    const activityId = `task-empty-${randomUUID()}`;
    await seedActivity(activityId);

    expect(await summarizeTaskItems(db, activityId, 1, "2026-11-01T00:00:00.000Z")).toEqual({
      total: 0,
      required: 0,
      done: 0,
      open: 0,
      blocked: 0,
      overdue: 0,
      byStatus: { pending: 0, in_progress: 0, blocked: 0, done: 0 },
      bySourceCapability: {},
    });
  });
});
