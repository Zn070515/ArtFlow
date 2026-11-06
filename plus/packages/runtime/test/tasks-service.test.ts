import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertRelease,
  migrate,
} from "@artflow-plus/db";
import type { Database, StoredTaskItem } from "@artflow-plus/db";
import {
  compileTasksDefinition,
  createTasksDefinition,
} from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assignTask,
  blockTask,
  completeTask,
  listTasks,
  readReadiness,
  reopenTask,
  startTask,
  syncTasks,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_tasks_runtime_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const staff: ActorContext = {
  actorId: "tasks-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["tasks.manage"],
};
const otherStaff: ActorContext = {
  actorId: "tasks-other-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["tasks.manage"],
};

const taskTemplates = [
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
] as const;

function deps(actor: ActorContext = staff, now = "2026-10-20T10:00:00.000Z"): RuntimeDeps {
  return {
    actor,
    now: () => now,
    newEventId: () => `tasks-event-${randomUUID()}`,
  };
}

function taskArtifact() {
  const compiled = compileTasksDefinition(createTasksDefinition(taskTemplates));
  if (!compiled.ok) throw new Error(JSON.stringify(compiled));
  return compiled;
}

async function seedActivity(options: {
  readonly releaseHasTasks?: boolean;
  readonly enabledTasks?: boolean;
} = {}): Promise<string> {
  const activityId = `tasks-activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    title: "Tasks runtime",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(options.enabledTasks === false ? [] : ["tasks", "registration", "materials"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "tasks-release",
    capabilities: options.releaseHasTasks === false ? {} : { tasks: taskArtifact() },
    executionPolicy: { declaredScopes: [], conflicts: {}, runtimeContractVersion: 2, commandScopes: {} },
    capabilityVersions: { tasks: "1.0.0" },
    bindings: [],
    releasedAt: "2026-10-20T09:00:00Z",
    sourceDraftRevision: 1,
  });
  return activityId;
}

async function sync(activityId: string, commandId = `tasks-sync-${randomUUID()}`): Promise<readonly StoredTaskItem[]> {
  const result = await syncTasks(db, deps(), {
    activityId,
    definitionVersion: 1,
    commandId,
    actor: staff,
  });
  return result.body.tasks;
}

describe.skipIf(!connectionString)("task runtime commands on PostgreSQL", () => {
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

  it("syncs tasks from the activity's current released artifact", async () => {
    const activityId = await seedActivity();
    const result = await syncTasks(db, deps(), {
      activityId,
      definitionVersion: 1,
      commandId: "tasks-sync-current-release",
      actor: staff,
    });

    expect(result).toMatchObject({ replayed: false, status: 200 });
    expect(result.body).toMatchObject({ definitionVersion: 1, createdCount: 2 });
    expect(result.body.tasks.map((task) => task.templateKey)).toEqual([
      "materials.audio",
      "registration.review",
    ]);
  });

  it("refuses sync when the released artifact has no tasks capability", async () => {
    const activityId = await seedActivity({ releaseHasTasks: false });

    await expect(syncTasks(db, deps(), {
      activityId,
      definitionVersion: 1,
      commandId: "tasks-sync-missing-release-capability",
      actor: staff,
    })).rejects.toMatchObject({ code: "RELEASE_SNAPSHOT_INCOMPLETE" });
  });

  it("enforces pending-start-block-complete-reopen transitions", async () => {
    const activityId = await seedActivity();
    const tasks = await sync(activityId);
    let task = tasks.find((item) => item.templateKey === "registration.review")!;

    task = (await startTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: task.revision,
      commandId: "tasks-start", actor: staff,
    })).body;
    expect(task.status).toBe("in_progress");
    task = (await blockTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: task.revision,
      commandId: "tasks-block", reason: "等待补件", actor: staff,
    })).body;
    expect(task).toMatchObject({ status: "blocked", blockedReason: "等待补件" });
    task = (await reopenTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: task.revision,
      commandId: "tasks-reopen-blocked", reason: "补件已到", actor: staff,
    })).body;
    expect(task.status).toBe("in_progress");
    task = (await completeTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: task.revision,
      commandId: "tasks-complete", reason: "审核通过", actor: staff,
    })).body;
    expect(task).toMatchObject({ status: "done", completionReason: "审核通过" });
    task = (await reopenTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: task.revision,
      commandId: "tasks-reopen-done", reason: "需要重新确认", actor: staff,
    })).body;
    expect(task).toMatchObject({ status: "pending", completionReason: null });
  });

  it("requires reasons for block, complete, and reopen", async () => {
    const activityId = await seedActivity();
    let [task] = await sync(activityId);
    if (!task) throw new Error("task fixture was not created");

    await expect(blockTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: 0,
      commandId: "tasks-block-no-reason", reason: "   ", actor: staff,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    task = (await startTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: 0,
      commandId: "tasks-start-for-reason", actor: staff,
    })).body;
    await expect(completeTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: task.revision,
      commandId: "tasks-complete-no-reason", reason: "", actor: staff,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    task = (await blockTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: task.revision,
      commandId: "tasks-block-for-reason", reason: "先阻塞", actor: staff,
    })).body;
    await expect(reopenTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: task.revision,
      commandId: "tasks-reopen-no-reason", reason: "", actor: staff,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects stale task revisions without writing an audit or outbox event", async () => {
    const activityId = await seedActivity();
    const [task] = await sync(activityId);
    if (!task) throw new Error("task fixture was not created");
    await startTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: 0,
      commandId: "tasks-start-before-stale", actor: staff,
    });
    const beforeAudit = await db.selectFrom("audit_entry").select(({ fn }) => fn.countAll().as("count"))
      .where("activity_id", "=", activityId).executeTakeFirstOrThrow();
    const beforeOutbox = await db.selectFrom("outbox").select(({ fn }) => fn.countAll().as("count"))
      .where("activity_id", "=", activityId).executeTakeFirstOrThrow();

    await expect(startTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: 0,
      commandId: "tasks-start-stale", actor: staff,
    })).rejects.toMatchObject({ code: "STALE_REVISION" });
    const afterAudit = await db.selectFrom("audit_entry").select(({ fn }) => fn.countAll().as("count"))
      .where("activity_id", "=", activityId).executeTakeFirstOrThrow();
    const afterOutbox = await db.selectFrom("outbox").select(({ fn }) => fn.countAll().as("count"))
      .where("activity_id", "=", activityId).executeTakeFirstOrThrow();
    expect(afterAudit.count).toBe(beforeAudit.count);
    expect(afterOutbox.count).toBe(beforeOutbox.count);
    expect(await db.selectFrom("command_receipt").selectAll().where("command_id", "=", "tasks-start-stale").execute()).toEqual([]);
  });

  it("replays the same command receipt and rejects a conflicting payload", async () => {
    const activityId = await seedActivity();
    const first = await syncTasks(db, deps(), {
      activityId, definitionVersion: 1, commandId: "tasks-sync-replay", actor: staff,
    });
    const replay = await syncTasks(db, deps(), {
      activityId, definitionVersion: 1, commandId: "tasks-sync-replay", actor: staff,
    });
    expect(replay).toMatchObject({ replayed: true, body: first.body });
    await expect(syncTasks(db, deps(otherStaff), {
      activityId, definitionVersion: 1, commandId: "tasks-sync-replay", actor: otherStaff,
    })).rejects.toMatchObject({ code: "COMMAND_ID_CONFLICT" });
  });

  it("keeps source capability facts unchanged after every task mutation", async () => {
    const activityId = await seedActivity();
    const registrationId = `registration-${randomUUID()}`;
    await db.insertInto("registration").values({
      id: registrationId,
      activity_id: activityId,
      participant_id: "participant-private",
      questionnaire_version: "v1",
      questionnaire_hash: "hash",
      status: "submitted",
      answers: JSON.stringify({ answer: "private answer" }),
      supplement_keys: JSON.stringify([]),
      revision: 1,
      review_note: "private note",
      reviewed_by: "reviewer",
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
    const before = await db.selectFrom("registration").selectAll().where("id", "=", registrationId).executeTakeFirstOrThrow();
    let [task] = await sync(activityId);
    if (!task) throw new Error("task fixture was not created");
    task = (await assignTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: task.revision,
      commandId: "tasks-source-assign", assigneeActorId: "actor-1", dueAt: "2026-10-21T00:00:00Z", actor: staff,
    })).body;
    task = (await startTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: task.revision,
      commandId: "tasks-source-start", actor: staff,
    })).body;
    task = (await blockTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: task.revision,
      commandId: "tasks-source-block", reason: "等待", actor: staff,
    })).body;
    task = (await reopenTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: task.revision,
      commandId: "tasks-source-reopen", reason: "继续", actor: staff,
    })).body;
    await completeTask(db, deps(), {
      activityId, taskId: task.id, expectedRevision: task.revision,
      commandId: "tasks-source-complete", reason: "完成", actor: staff,
    });
    const after = await db.selectFrom("registration").selectAll().where("id", "=", registrationId).executeTakeFirstOrThrow();
    expect(after).toEqual(before);
  });

  it("builds readiness from task facts and marks only unfinished due tasks overdue", async () => {
    const activityId = await seedActivity();
    const tasks = await sync(activityId);
    const pending = tasks.find((item) => item.templateKey === "registration.review")!;
    const done = tasks.find((item) => item.templateKey === "materials.audio")!;
    const pendingAssigned = await assignTask(db, deps(), {
      activityId, taskId: pending.id, expectedRevision: pending.revision,
      commandId: "tasks-readiness-pending", assigneeActorId: "actor-1", dueAt: "2026-10-01T00:00:00Z", actor: staff,
    });
    let doneStarted = await assignTask(db, deps(), {
      activityId, taskId: done.id, expectedRevision: done.revision,
      commandId: "tasks-readiness-done-assign", assigneeActorId: "actor-2", dueAt: "2026-10-01T00:00:00Z", actor: staff,
    });
    doneStarted = await startTask(db, deps(), {
      activityId, taskId: done.id, expectedRevision: doneStarted.body.revision,
      commandId: "tasks-readiness-done-start", actor: staff,
    });
    await completeTask(db, deps(), {
      activityId, taskId: done.id, expectedRevision: doneStarted.body.revision,
      commandId: "tasks-readiness-done-complete", reason: "完成", actor: staff,
    });

    const readiness = await readReadiness(db, deps(), activityId);
    expect(readiness).toMatchObject({
      definitionVersion: 1,
      summary: {
        total: 2,
        required: 2,
        done: 1,
        open: 1,
        blocked: 0,
        overdue: 1,
      },
      openTaskKeys: [pendingAssigned.body.templateKey],
    });
  });
});
