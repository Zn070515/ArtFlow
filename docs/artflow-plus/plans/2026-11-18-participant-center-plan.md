# 参与者个人中心实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `/me` 与 `/me/$publicCode`：参与者的报名/材料/个人赛程/我的赛果，以及派生通知收件箱和已读状态。

**Architecture:** 新增 `participant_notification_read` 表只存已读状态；`getParticipantCenter` 用真实 PostgreSQL 组合现有报名、材料、formal schedule release、public results 与公开资料，按 `actor.actorId` 过滤；通知由当前状态纯函数派生。API 为 `GET /api/me` 与 `POST /api/me/notifications/read`，前端复用 Portal 壳。

**Tech Stack:** Node 24、TypeScript、Fastify 5、Kysely、PostgreSQL 18、React 19、TanStack Router/Query、Vitest、Playwright。

**Spec:** [`2026-11-18-participant-center-design.md`](../specs/2026-11-18-participant-center-design.md)

---

## Test architecture

按 spec §8 执行：**契约**（不新增 capability/命令；`GET /api/me` 是投影，`POST /api/me/notifications/read` 是 actor-scoped UI 偏好）；
**消费者**（新路由 `/api/me`、`/api/me/notifications/read`，Web `/me`、`/me/$publicCode`，`participant_notification_read` 表）；
**生命周期**（draft→active→closed→archived；报名/材料状态；formal schedule release 撤销；result release 撤销；归档只读；test/rehearsal 不出现）；
**适配器**（不新增 capability adapter；真实 PostgreSQL + 真实读服务，扩展 `registration-repository.test.ts`）；
**故障**（跨参与者隔离、未知/伪造已读 key、重复已读、撤销 release、归档、缺 profile/材料/release）；
**防膨胀 / anti-bloat**（一个 service 测试文件、一个 `/me` E2E 旅程，扩展已有 `registration-loop.spec.ts`，不复制模板）；
**门禁**（下方命令）。

聚焦命令：

```powershell
Set-Location plus
pnpm --filter @artflow-plus/runtime test -- participant-center-service
pnpm --filter @artflow-plus/api test -- me
pnpm --filter @artflow-plus/web test -- me
pnpm run check
```

---

## Task 1: 已读表与参与者查询

**Files:**
- Create: `plus/packages/db/src/migrations/0032_participant_notification_read.ts`
- Create: `plus/packages/db/src/participant-notification-repository.ts`
- Modify: `plus/packages/db/src/migrations.ts`
- Modify: `plus/packages/db/src/index.ts`
- Modify: `plus/packages/db/src/registration-repository.ts`
- Modify: `plus/packages/db/src/material-repository.ts`
- Test: `plus/packages/db/test/registration-repository.test.ts`

- [ ] **Step 1: 写迁移**

```ts
import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable("participant_notification_read")
      .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
      .addColumn("notification_key", "varchar(300)", (column) => column.notNull())
      .addColumn("read_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint("participant_notification_read_pk", ["actor_id", "notification_key"])
      .execute();
  },
  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.dropTable("participant_notification_read").ifExists().execute();
  },
};
```

- [ ] **Step 2: 注册迁移并生成 schema**

在 `migrations.ts` 增加 import 与表项 `"0032_participant_notification_read"`，然后：

```powershell
Set-Location plus
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm --filter @artflow-plus/db run schema:snapshot
pnpm --filter @artflow-plus/db run schema:types
```

Expected：`ParticipantNotificationReadRow` 出现在 `types.ts`。

- [ ] **Step 3: 写已读 repository**

`plus/packages/db/src/participant-notification-repository.ts`：

```ts
import type { Kysely } from "kysely";

import type { Database } from "./types.js";

export async function listNotificationReadKeys(
  db: Kysely<Database>,
  actorId: string,
  keys: readonly string[],
): Promise<ReadonlySet<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db
    .selectFrom("participant_notification_read")
    .select("notification_key")
    .where("actor_id", "=", actorId)
    .where("notification_key", "in", [...keys])
    .execute();
  return new Set(rows.map((row) => row.notification_key));
}

export async function markNotificationKeysRead(
  db: Kysely<Database>,
  actorId: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  await db
    .insertInto("participant_notification_read")
    .values(keys.map((key) => ({ actor_id: actorId, notification_key: key })))
    .onConflict((conflict) => conflict.columns(["actor_id", "notification_key"]).doNothing())
    .execute();
}
```

在 `db/src/index.ts` 增加 `export * from "./participant-notification-repository.js";`。

- [ ] **Step 4: 扩展注册仓储**

在 `registration-repository.ts` 增加：

```ts
export interface ParticipantRegistrationRecord {
  readonly registration: StoredRegistration;
  readonly activity: {
    readonly id: string;
    readonly publicCode: string;
    readonly title: string;
    readonly status: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export async function listRegistrationsByParticipant(
  db: Kysely<Database>,
  participantId: string,
): Promise<readonly ParticipantRegistrationRecord[]> {
  const rows = await db
    .selectFrom("registration")
    .innerJoin("activity", "activity.id", "registration.activity_id")
    .selectAll("registration")
    .select([
      "activity.id as activity_join_id",
      "activity.public_code as activity_join_public_code",
      "activity.title as activity_join_title",
      "activity.status as activity_join_status",
    ])
    .where("registration.participant_id", "=", participantId)
    .orderBy("registration.updated_at", "desc")
    .orderBy("registration.id", "asc")
    .execute();
  return rows.map((row) => ({
    registration: registration(row),
    activity: {
      id: row.activity_join_id,
      publicCode: row.activity_join_public_code,
      title: row.activity_join_title,
      status: row.activity_join_status,
    },
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  }));
}
```

- [ ] **Step 5: 给材料加时间戳**

`material-repository.ts` 的 `StoredMaterial` 增加：

```ts
readonly createdAt?: string;
readonly updatedAt?: string;
```

`material()` 映射增加：

```ts
createdAt: iso(row.created_at) ?? "",
updatedAt: iso(row.updated_at) ?? "",
```

不改变 `insertMaterial`/`updateMaterialReview` 的写入值。

- [ ] **Step 6: 写仓储失败测试**

在 `registration-repository.test.ts` 增加：

```ts
it("lists only the participant's registrations with activity context", async () => {
  const activityId = await seedActivity();
  await insertRegistration(db, {
    id: "reg-a", activityId, participantId: "participant-a",
    questionnaireVersion: "v1", questionnaireHash: "hash",
    status: "approved", answers: {}, supplementKeys: [], revision: 1,
  });
  await insertRegistration(db, {
    id: "reg-b", activityId, participantId: "participant-b",
    questionnaireVersion: "v1", questionnaireHash: "hash",
    status: "submitted", answers: {}, supplementKeys: [], revision: 1,
  });
  const rows = await listRegistrationsByParticipant(db, "participant-a");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.registration.id).toBe("reg-a");
  expect(rows[0]?.activity.publicCode).toBe("REG-1");
  expect(rows[0]?.updatedAt).toEqual(expect.any(String));
});
```

（`seedActivity` 用现有测试 helper；若没有，插入一个 active activity，`public_code: "REG-1"`。）

- [ ] **Step 7: 运行测试**

```powershell
$env:REQUIRE_DB = "1"
pnpm --filter @artflow-plus/db test -- registration-repository
pnpm --filter @artflow-plus/db run check
```

Expected：PASS。

- [ ] **Step 8: 提交**

```bash
git add plus/packages/db
git commit -m "feat(db): add participant notification reads"
```

---

## Task 2: 参与者中心服务

**Files:**
- Create: `plus/packages/runtime/src/participant-center-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Test: `plus/packages/runtime/test/participant-center-service.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  insertMaterial,
  insertRegistration,
  insertResultPublication,
  insertResultRelease,
  insertStageResult,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";

import type { RuntimeDeps } from "../src/deps.js";
import { getParticipantCenter, markParticipantNotificationsRead } from "../src/participant-center-service.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_participant_center_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

function actor(actorId: string): ActorContext {
  return { actorId, actorType: "user", roles: ["participant"], permissions: [] };
}
function deps(actorId: string): RuntimeDeps {
  return {
    actor: actor(actorId),
    now: () => "2026-04-18T13:00:00.000Z",
    newEventId: () => randomUUID(),
  };
}

async function seedActivity(id: string, publicCode: string, title: string): Promise<void> {
  await db.insertInto("activity").values({
    id,
    public_code: publicCode,
    title,
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "questionnaire", "materials"]),
    active_definition_version: 1,
  }).execute();
}

async function seedRegistration(
  id: string,
  activityId: string,
  participantId: string,
  status: "approved" | "submitted",
): Promise<void> {
  await insertRegistration(db, {
    id,
    activityId,
    participantId,
    questionnaireVersion: "v1",
    questionnaireHash: "hash",
    status,
    answers: { name: participantId },
    supplementKeys: [],
    revision: 2,
    reviewNote: "欢迎",
    reviewedBy: "staff",
  });
}

async function seedMaterial(activityId: string, registrationId: string, ownerActorId: string): Promise<void> {
  await insertMaterial(db, {
    id: `mat-${ownerActorId}`,
    activityId,
    registrationId,
    questionKey: "audio",
    storageKey: `storage-${ownerActorId}`,
    originalName: "demo.mp3",
    contentType: "audio/mpeg",
    byteLength: 3,
    ownerActorId,
    status: "approved",
    reviewNote: "很好",
    reviewedBy: "staff",
    reviewedAt: "2026-04-18T12:00:00.000Z",
    revision: 1,
    current: true,
    contentReady: true,
  });
}

describe.skipIf(!connectionString)("participant center service", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);

    await seedActivity("act-me-1", "ME-1", "活动 ME-1");
    await seedActivity("act-me-2", "ME-2", "活动 ME-2");
    await seedRegistration("reg-a", "act-me-1", "participant-a", "approved");
    await seedRegistration("reg-b", "act-me-2", "participant-b", "submitted");
    await seedMaterial("act-me-1", "reg-a", "participant-a");
    await seedMaterial("act-me-2", "reg-b", "participant-b");

    await db.insertInto("schedule_release").values({
      id: "release-schedule-1",
      activity_id: "act-me-1",
      mode: "formal",
      version: 1,
      snapshot: JSON.stringify({
        version: 1,
        schemaVersion: 1,
        releasedAt: "2026-04-18T11:00:00.000Z",
        entries: [
          {
            order: 1, slotKey: "opening", slotLabel: "第一轮",
            participantId: "participant-a", title: "我的节目", note: "",
            startsAt: "2026-04-18T11:00:00.000Z",
          },
          {
            order: 2, slotKey: "opening", slotLabel: "第一轮",
            participantId: "participant-b", title: "别人的节目", note: "",
            startsAt: "2026-04-18T11:10:00.000Z",
          },
        ],
      }),
      note: "",
      released_at: new Date("2026-04-18T11:00:00.000Z"),
      revoked_at: null,
    }).execute();

    const decisions = [
      { rank: 1, contestantId: "participant-a", score: "98.00" },
      { rank: 2, contestantId: "participant-b", score: "97.00" },
    ];
    const awards = [{ award: "冠军", contestantId: "participant-a" }];
    await insertStageResult(db, {
      id: "stage-me-1",
      activityId: "act-me-1",
      stageKey: "final",
      status: "confirmed",
      candidateRevision: 1,
      sourceCandidateRevision: 1,
      inputFingerprint: "fp",
      source: {
        kind: "podium_candidate",
        aggregateId: "stage-me-1",
        definitionVersion: 1,
        releaseHash: "test",
        mode: "formal",
        sourceRevision: 1,
        inputFingerprint: "fp",
      },
      decisions,
      awards,
      note: "",
      revision: 1,
      confirmedAt: "2026-04-18T13:00:00.000Z",
      staleReason: "",
    });
    await insertResultPublication(db, {
      id: "pub-me-1",
      activityId: "act-me-1",
      stageKey: "final",
      title: "正式赛果",
      content: "",
      version: 1,
      revision: 0,
    });
    await insertResultRelease(db, {
      id: "release-result-1",
      activityId: "act-me-1",
      publicationId: "pub-me-1",
      stageResultId: "stage-me-1",
      stageKey: "final",
      status: "active",
      snapshot: {
        activityTitle: "活动 ME-1",
        publicTitle: "活动 ME-1 · 正式赛果",
        stageKey: "final",
        decisions,
        awards,
      },
      snapshotCandidateRevision: 1,
      resultVersion: 1,
      postVersion: 1,
      inputFingerprint: "fp",
      note: "",
      releasedAt: "2026-04-18T13:00:00.000Z",
      revision: 0,
    });
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns only the actor's events", async () => {
    const center = await getParticipantCenter(db, deps("participant-a"));
    expect(center.events).toHaveLength(1);
    expect(center.events[0]?.activity.publicCode).toBe("ME-1");
    expect(JSON.stringify(center)).not.toContain("ME-2");
  });

  it("filters schedule and results to the actor", async () => {
    const center = await getParticipantCenter(db, deps("participant-a"));
    expect(center.events[0]?.schedule).toEqual([
      expect.objectContaining({ title: "我的节目", startsAt: "2026-04-18T11:00:00.000Z" }),
    ]);
    expect(center.events[0]?.schedule).toHaveLength(1);
    expect(center.events[0]?.results[0]).toMatchObject({ rank: 1, awards: ["冠军"] });
  });

  it("derives notifications and marks keys read idempotently", async () => {
    const center = await getParticipantCenter(db, deps("participant-a"));
    const keys = center.notifications.items.map((item) => item.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(center.notifications.unreadCount).toBe(keys.length);
    const first = await markParticipantNotificationsRead(db, deps("participant-a"), keys);
    expect(first.unreadCount).toBe(0);
    const second = await markParticipantNotificationsRead(db, deps("participant-a"), keys);
    expect(second.unreadCount).toBe(0);
    const after = await getParticipantCenter(db, deps("participant-a"));
    expect(after.notifications.items.every((item) => item.read)).toBe(true);
  });

  it("ignores unknown keys and keeps actors isolated", async () => {
    const b = await markParticipantNotificationsRead(db, deps("participant-b"), [
      "ME-1:registration:approved:x:y",
    ]);
    expect(b.unreadCount).toBeGreaterThanOrEqual(0);
    const a = await getParticipantCenter(db, deps("participant-a"));
    expect(a.notifications.items.every((item) => !item.read)).toBe(true);
  });

  it("marks archived events read-only", async () => {
    await db.updateTable("activity").set({ status: "archived" }).where("id", "=", "act-me-1").execute();
    const center = await getParticipantCenter(db, deps("participant-a"));
    expect(center.events[0]?.archived).toBe(true);
    expect(center.events[0]?.links.event).toBeNull();
    expect(center.events[0]?.schedule).toEqual([]);
    expect(center.events[0]?.results).toEqual([]);
    expect(center.notifications.items.some((item) => item.kind === "schedule")).toBe(false);
    expect(center.notifications.items.some((item) => item.kind === "result")).toBe(false);
    expect(center.notifications.items.some((item) => item.kind === "registration")).toBe(true);
    await db.updateTable("activity").set({ status: "active" }).where("id", "=", "act-me-1").execute();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```powershell
pnpm --filter @artflow-plus/runtime test -- participant-center-service
```

Expected：FAIL，模块不存在。

- [ ] **Step 3: 写服务**

```ts
import { createHash } from "node:crypto";

import type { Database, StoredMaterial, StoredRegistration } from "@artflow-plus/db";
import {
  getActivityPublicProfile,
  listMaterials,
  listNotificationReadKeys,
  listRegistrationsByParticipant,
  markNotificationKeysRead,
  selectActiveScheduleRelease,
  selectPublicResults,
} from "@artflow-plus/db";
import type { Kysely } from "kysely";

import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { getPublicActivity } from "./registration-read-service.js";
```

实现类型与函数：

```ts
export interface MyNotification {
  readonly key: string;
  readonly kind: "registration" | "material" | "announcement" | "schedule" | "result";
  readonly title: string;
  readonly body: string;
  readonly activity: { readonly publicCode: string; readonly title: string };
  readonly createdAt: string;
  readonly read: boolean;
  readonly href: string;
}

export interface MyEvent {
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "draft" | "active" | "closed" | "archived";
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly venue: string;
    readonly organizer: string;
  };
  readonly registration: {
    readonly status: StoredRegistration["status"];
    readonly editable: boolean;
    readonly reviewNote?: string;
    readonly supplementKeys: readonly string[];
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly materials: readonly {
    readonly id: string;
    readonly questionKey: string;
    readonly originalName: string;
    readonly contentType: string;
    readonly byteLength: number;
    readonly status: StoredMaterial["status"];
    readonly reviewNote: string;
    readonly revision: number;
    readonly contentPath: string | null;
    readonly reviewedAt: string | null;
    readonly updatedAt: string | null;
  }[];
  readonly schedule: readonly {
    readonly order: number;
    readonly slotLabel: string;
    readonly title: string;
    readonly note: string;
    readonly startsAt: string | null;
  }[];
  readonly results: readonly {
    readonly stageKey: string;
    readonly publicTitle: string;
    readonly releasedAt: string;
    readonly rank: number;
    readonly score: string;
    readonly unit?: "score" | "percent";
    readonly awards: readonly string[];
  }[];
  readonly links: { readonly event: string | null; readonly edit: string | null };
  readonly archived: boolean;
}

export interface MyCenter {
  readonly events: readonly MyEvent[];
  readonly notifications: {
    readonly items: readonly MyNotification[];
    readonly unreadCount: number;
  };
}
```

核心实现：

```ts
function noteHash(note: string): string {
  return createHash("sha256").update(note).digest("hex").slice(0, 12);
}

function registrationKey(publicCode: string, registration: StoredRegistration): string {
  if (
    registration.status === "need_supplement" ||
    registration.status === "approved" ||
    registration.status === "rejected"
  ) {
    return `${publicCode}:registration:${registration.status}:${registration.reviewedBy ?? "system"}:${noteHash(registration.reviewNote ?? "")}`;
  }
  return `${publicCode}:registration:${registration.status}:${registration.revision}`;
}

function registrationCopy(registration: StoredRegistration): { title: string; body: string } {
  switch (registration.status) {
    case "submitted":
      return { title: "报名已提交", body: "主办方会尽快审核。" };
    case "need_supplement":
      return { title: "报名需要补交", body: registration.reviewNote || "请在报名页补充材料后重新提交。" };
    case "approved":
      return { title: "报名已通过", body: "你的报名已通过审核。" };
    case "rejected":
      return { title: "报名未通过", body: registration.reviewNote || "如有疑问，请联系主办方。" };
    case "withdrawn":
      return { title: "报名已撤回", body: "该报名已撤回。" };
    default:
      return { title: "报名状态更新", body: "" };
  }
}

export async function getParticipantCenter(
  db: Kysely<Database>,
  deps: RuntimeDeps,
): Promise<MyCenter> {
  const actorId = runtimeActor(deps).actorId;
  const records = await listRegistrationsByParticipant(db, actorId);
  const notifications: MyNotification[] = [];
  const events = await Promise.all(records.map(async (record) => {
    const { registration, activity } = record;
    const [profile, publicActivity, materials, schedule, results] = await Promise.all([
      getActivityPublicProfile(db, activity.id),
      getPublicActivity(db, activity.publicCode),
      listMaterials(db, registration.id),
      selectActiveScheduleRelease(db, activity.publicCode),
      selectPublicResults(db, activity.publicCode),
    ]);
    const archived = activity.status === "archived";
    const editable = publicActivity?.registrationOpen === true &&
      (registration.status === "draft" || registration.status === "need_supplement");
    const mySchedule = schedule === null ? [] : schedule.release.snapshot.entries
      .filter((entry) => entry.participantId === actorId)
      .map((entry) => ({
        order: entry.order,
        slotLabel: entry.slotLabel,
        title: entry.title,
        note: entry.note,
        startsAt: entry.startsAt ?? null,
      }));
    const myResults = results === null ? [] : results.results.flatMap((release) => {
      const decision = release.decisions.find((item) => item.contestantId === actorId);
      const awards = release.awards.filter((item) => item.contestantId === actorId).map((item) => item.award);
      if (decision === undefined && awards.length === 0) return [];
      return [{
        stageKey: release.stageKey,
        publicTitle: release.publicTitle,
        releasedAt: release.releasedAt,
        rank: decision?.rank ?? 0,
        score: decision?.score ?? "",
        ...(decision?.unit === undefined ? {} : { unit: decision.unit }),
        awards,
      }];
    });
    const event: MyEvent = {
      activity: {
        publicCode: activity.publicCode,
        title: activity.title,
        status: activity.status as MyEvent["activity"]["status"],
        startsAt: profile.startsAt,
        endsAt: profile.endsAt,
        venue: profile.venue,
        organizer: profile.organizer,
      },
      registration: {
        status: registration.status,
        editable,
        ...(registration.reviewNote === undefined ? {} : { reviewNote: registration.reviewNote }),
        supplementKeys: registration.supplementKeys ?? [],
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      materials: materials.map((material) => ({
        id: material.id,
        questionKey: material.questionKey,
        originalName: material.originalName,
        contentType: material.contentType,
        byteLength: material.byteLength,
        status: material.status,
        reviewNote: material.reviewNote,
        revision: material.revision,
        contentPath: material.ownerActorId === actorId
          ? `/api/activities/${encodeURIComponent(activity.id)}/materials/${encodeURIComponent(material.id)}/content`
          : null,
        reviewedAt: material.reviewedAt,
        updatedAt: material.updatedAt ?? null,
      })),
      schedule: mySchedule,
      results: myResults,
      links: {
        event: activity.status === "active" || activity.status === "closed"
          ? `/e/${encodeURIComponent(activity.publicCode)}`
          : null,
        edit: editable ? `/join/${encodeURIComponent(activity.publicCode)}` : null,
      },
      archived,
    };
    const copy = registrationCopy(registration);
    if (registration.status !== "draft") {
      notifications.push({
        key: registrationKey(activity.publicCode, registration),
        kind: "registration",
        title: copy.title,
        body: copy.body,
        activity: { publicCode: activity.publicCode, title: activity.title },
        createdAt: record.updatedAt,
        read: false,
        href: `/me/${encodeURIComponent(activity.publicCode)}`,
      });
    }
    for (const material of materials) {
      if (material.status !== "approved" && material.status !== "needs_supplement") continue;
      notifications.push({
        key: `${activity.publicCode}:material:${material.id}:${material.status}:${material.revision}`,
        kind: "material",
        title: material.status === "approved" ? "材料已通过" : "材料需要补交",
        body: `${material.originalName}${material.reviewNote ? `：${material.reviewNote}` : ""}`,
        activity: { publicCode: activity.publicCode, title: activity.title },
        createdAt: material.reviewedAt ?? material.updatedAt ?? record.updatedAt,
        read: false,
        href: `/me/${encodeURIComponent(activity.publicCode)}`,
      });
    }
    if (!archived && activity.status !== "draft" && profile.announcement.trim() !== "") {
      notifications.push({
        key: `${activity.publicCode}:announcement:${createHash("sha256").update(profile.announcement).digest("hex").slice(0, 16)}`,
        kind: "announcement",
        title: "活动公告",
        body: profile.announcement,
        activity: { publicCode: activity.publicCode, title: activity.title },
        createdAt: profile.updatedAt,
        read: false,
        href: `/me/${encodeURIComponent(activity.publicCode)}`,
      });
    }
    if (schedule !== null && mySchedule.length > 0) {
      notifications.push({
        key: `${activity.publicCode}:schedule:${schedule.release.id}`,
        kind: "schedule",
        title: "节目单已发布",
        body: "你的节目单条目已发布。",
        activity: { publicCode: activity.publicCode, title: activity.title },
        createdAt: schedule.release.releasedAt,
        read: false,
        href: `/me/${encodeURIComponent(activity.publicCode)}`,
      });
    }
    if (results !== null) {
      for (const release of results.results) {
        const decision = release.decisions.find((item) => item.contestantId === actorId);
        const awards = release.awards.filter((item) => item.contestantId === actorId).map((item) => item.award);
        if (decision === undefined && awards.length === 0) continue;
        notifications.push({
          key: `${activity.publicCode}:result:${release.releaseId}`,
          kind: "result",
          title: "赛果已发布",
          body: `${decision === undefined ? "" : `第 ${decision.rank} 名`}${awards.length > 0 ? ` · ${awards.join(" / ")}` : ""}`,
          activity: { publicCode: activity.publicCode, title: activity.title },
          createdAt: release.releasedAt,
          read: false,
          href: `/me/${encodeURIComponent(activity.publicCode)}`,
        });
      }
    }
    return event;
  }));
  const keys = notifications.map((item) => item.key);
  const readKeys = await listNotificationReadKeys(db, actorId, keys);
  const items = notifications
    .map((item) => ({ ...item, read: readKeys.has(item.key) }))
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.key.localeCompare(right.key),
    );
  return {
    events,
    notifications: { items, unreadCount: items.filter((item) => !item.read).length },
  };
}

export async function markParticipantNotificationsRead(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  keys: readonly string[],
): Promise<{ readonly unreadCount: number }> {
  const actorId = runtimeActor(deps).actorId;
  const center = await getParticipantCenter(db, deps);
  const allowed = new Set(center.notifications.items.map((item) => item.key));
  const unique = [...new Set(keys)].filter((key) => allowed.has(key));
  await markNotificationKeysRead(db, actorId, unique);
  const marked = new Set(unique);
  return {
    unreadCount: center.notifications.items.filter((item) => !item.read && !marked.has(item.key)).length,
  };
}
```

注意：`StoredActivityPublicProfile`/`StoredMaterial`/`StoredRegistration` 的 import 只保留实际用到的；`getPublicActivity` 从 `./registration-read-service.js` 导入，不要从 db 导入。`listRegistrationsByParticipant` 从 `@artflow-plus/db` 导入。

- [ ] **Step 4: 导出服务**

`plus/packages/runtime/src/index.ts` 增加：

```ts
export * from "./participant-center-service.js";
```

- [ ] **Step 5: 运行测试与类型检查**

```powershell
$env:REQUIRE_DB = "1"
pnpm --filter @artflow-plus/runtime test -- participant-center-service
pnpm --filter @artflow-plus/runtime run check
```

Expected：PASS。

- [ ] **Step 6: 提交**

```bash
git add plus/packages/runtime
git commit -m "feat(runtime): add the participant center read model"
```

---

## Task 3: API `/api/me`

**Files:**
- Create: `plus/apps/api/src/routes/me.ts`
- Modify: `plus/apps/api/src/app.ts`
- Modify: `plus/apps/api/src/http/schemas.ts`
- Test: `plus/apps/api/test/me.test.ts`

- [ ] **Step 1: 增加 body schema**

`http/schemas.ts`：

```ts
export const MarkNotificationsReadBody = Type.Object(
  {
    keys: Type.Array(
      Type.String({ minLength: 1, maxLength: 300 }),
      { minItems: 1, maxItems: 200, uniqueItems: true },
    ),
  },
  { additionalProperties: false },
);
```

- [ ] **Step 2: 写路由**

`routes/me.ts`：

```ts
import type { ApiContext } from "../http/context.js";
import { MarkNotificationsReadBody } from "../http/schemas.js";
import { getParticipantCenter, markParticipantNotificationsRead } from "@artflow-plus/runtime";

export function registerMeRoutes(ctx: ApiContext): void {
  const { app, db, requestDeps } = ctx;

  app.get(
    "/api/me",
    { config: { access: "session" } },
    async (request) => getParticipantCenter(db, await requestDeps(request)),
  );

  app.post(
    "/api/me/notifications/read",
    { schema: { body: MarkNotificationsReadBody } },
    async (request) => {
      const body = request.body as { keys: string[] };
      return markParticipantNotificationsRead(db, await requestDeps(request), body.keys);
    },
  );
}
```

- [ ] **Step 3: 注册模块**

`app.ts`：

```ts
import { registerMeRoutes } from "./routes/me.js";
```

在 `registerPublicRoutes(routeContext);` 之后：

```ts
registerMeRoutes(routeContext);
```

- [ ] **Step 4: 写 API 失败测试**

`apps/api/test/me.test.ts`：

```ts
import { randomUUID } from "node:crypto";
import { closeDb, createDb, insertMaterial, insertRegistration, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
const schema = `artflow_api_me_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;
let appA: FastifyInstance;
let appB: FastifyInstance;
let appAnonymous: FastifyInstance;

const deps: RuntimeDeps = { now: () => new Date().toISOString(), newEventId: () => randomUUID() };
const actorA: ActorContext = { actorId: "participant-a", actorType: "user", roles: ["participant"], permissions: [] };
const actorB: ActorContext = { actorId: "participant-b", actorType: "user", roles: ["participant"], permissions: [] };

async function seed(activityId: string, publicCode: string, participantId: string) {
  await db.insertInto("activity").values({
    id: activityId, public_code: publicCode, title: `活动 ${publicCode}`,
    status: "active", revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "questionnaire", "materials"]),
    active_definition_version: 1,
  }).execute();
  await insertRegistration(db, {
    id: `reg-${participantId}`, activityId, participantId,
    questionnaireVersion: "v1", questionnaireHash: "hash",
    status: "approved", answers: {}, supplementKeys: [], revision: 2,
    reviewNote: "欢迎", reviewedBy: "staff",
  });
  await insertMaterial(db, {
    id: `mat-${participantId}`, activityId, registrationId: `reg-${participantId}`,
    questionKey: "audio", storageKey: "k", originalName: "demo.mp3",
    contentType: "audio/mpeg", byteLength: 3, ownerActorId: participantId,
    status: "uploaded", reviewNote: "", reviewedBy: null, reviewedAt: null,
    revision: 1, current: true, contentReady: true,
  });
}

describe.skipIf(!connectionString)("participant center API", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await seed("act-a", "ME-A", "participant-a");
    await seed("act-b", "ME-B", "participant-b");
    appA = await buildApp({ db, deps, actor: actorA });
    appB = await buildApp({ db, deps, actor: actorB });
    appAnonymous = await buildApp({ db, deps });
    await Promise.all([appA.ready(), appB.ready(), appAnonymous.ready()]);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await Promise.all([appA.close(), appB.close(), appAnonymous.close()]);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns only the actor's events", async () => {
    const response = await appA.inject({ method: "GET", url: "/api/me" });
    expect(response.statusCode).toBe(200);
    expect(response.json().events).toHaveLength(1);
    expect(response.body).toContain("ME-A");
    expect(response.body).not.toContain("ME-B");
    const other = await appB.inject({ method: "GET", url: "/api/me" });
    expect(other.body).toContain("ME-B");
    expect(other.body).not.toContain("ME-A");
  });

  it("requires a session", async () => {
    const response = await appAnonymous.inject({ method: "GET", url: "/api/me" });
    expect(response.statusCode).toBe(401);
  });

  it("marks notifications read idempotently", async () => {
    const first = await appA.inject({ method: "GET", url: "/api/me" });
    const keys = (first.json().notifications.items as { key: string }[]).map((item) => item.key);
    expect(keys.length).toBeGreaterThan(0);
    const marked = await appA.inject({
      method: "POST", url: "/api/me/notifications/read",
      headers: { "content-type": "application/json" },
      payload: { keys },
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json().unreadCount).toBe(0);
    const again = await appA.inject({
      method: "POST", url: "/api/me/notifications/read",
      headers: { "content-type": "application/json" },
      payload: { keys },
    });
    expect(again.json().unreadCount).toBe(0);
  });
});
```

- [ ] **Step 5: 运行测试确认失败**

```powershell
$env:REQUIRE_DB = "1"
pnpm --filter @artflow-plus/api test -- me
```

Expected：FAIL，路由 404。

- [ ] **Step 6: 运行测试通过**

```powershell
pnpm --filter @artflow-plus/api test -- me
pnpm --filter @artflow-plus/api run check
```

Expected：PASS。

- [ ] **Step 7: 提交**

```bash
git add plus/apps/api
git commit -m "feat(api): expose the participant center"
```

---

## Task 4: `/me` 页面

**Files:**
- Create: `plus/apps/web/src/api/me.ts`
- Create: `plus/apps/web/src/components/me/MyEventCard.tsx`
- Create: `plus/apps/web/src/components/me/NotificationList.tsx`
- Create: `plus/apps/web/src/routes/me.tsx`
- Create: `plus/apps/web/src/styles/me.css`
- Modify: `plus/apps/web/src/styles/global.css`
- Modify: `plus/apps/web/src/router.tsx`
- Modify: `plus/apps/web/src/components/shell/PortalShell.tsx`
- Modify: `plus/apps/web/src/components/format/labels.ts`
- Test: `plus/apps/web/src/routes/me.test.tsx`

- [ ] **Step 1: 写 API 客户端**

`api/me.ts`：

```ts
import { apiFetch } from "./client.js";

export type MyRegistrationStatus =
  | "draft"
  | "submitted"
  | "need_supplement"
  | "approved"
  | "rejected"
  | "withdrawn";

export type MyMaterialStatus = "uploaded" | "approved" | "needs_supplement";

export interface MyEvent {
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "draft" | "active" | "closed" | "archived";
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly venue: string;
    readonly organizer: string;
  };
  readonly registration: {
    readonly status: MyRegistrationStatus;
    readonly editable: boolean;
    readonly reviewNote?: string;
    readonly supplementKeys: readonly string[];
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly materials: readonly {
    readonly id: string;
    readonly questionKey: string;
    readonly originalName: string;
    readonly contentType: string;
    readonly byteLength: number;
    readonly status: MyMaterialStatus;
    readonly reviewNote: string;
    readonly revision: number;
    readonly contentPath: string | null;
    readonly reviewedAt: string | null;
    readonly updatedAt: string | null;
  }[];
  readonly schedule: readonly {
    readonly order: number;
    readonly slotLabel: string;
    readonly title: string;
    readonly note: string;
    readonly startsAt: string | null;
  }[];
  readonly results: readonly {
    readonly stageKey: string;
    readonly publicTitle: string;
    readonly releasedAt: string;
    readonly rank: number;
    readonly score: string;
    readonly unit?: "score" | "percent";
    readonly awards: readonly string[];
  }[];
  readonly links: { readonly event: string | null; readonly edit: string | null };
  readonly archived: boolean;
}

export interface MyNotification {
  readonly key: string;
  readonly kind: "registration" | "material" | "announcement" | "schedule" | "result";
  readonly title: string;
  readonly body: string;
  readonly activity: { readonly publicCode: string; readonly title: string };
  readonly createdAt: string;
  readonly read: boolean;
  readonly href: string;
}

export interface MyCenter {
  readonly events: readonly MyEvent[];
  readonly notifications: {
    readonly items: readonly MyNotification[];
    readonly unreadCount: number;
  };
}

export function fetchMyCenter(signal?: AbortSignal): Promise<MyCenter> {
  return apiFetch<MyCenter>("/api/me", { signal });
}

export function markMyNotificationsRead(keys: readonly string[]): Promise<{ unreadCount: number }> {
  return apiFetch("/api/me/notifications/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys }),
  });
}
```

- [ ] **Step 2: 加标签**

`components/format/labels.ts` 的 `REGISTRATION_STATUS_LABELS` 增加：

```ts
withdrawn: "已撤回",
```

- [ ] **Step 3: 写活动卡**

`components/me/MyEventCard.tsx`：使用 `Card`/`Badge`/`Link`。核心：

```tsx
import { Link } from "@tanstack/react-router";
import { ACTIVITY_STATUS_LABELS, REGISTRATION_STATUS_LABELS, label } from "../format/labels.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Card } from "../ui/Card.js";
import type { MyEvent } from "../../api/me.js";

function registrationTone(status: MyEvent["registration"]["status"]): BadgeTone {
  if (status === "approved") return "success";
  if (status === "need_supplement") return "warning";
  if (status === "rejected") return "danger";
  if (status === "submitted") return "info";
  return "neutral";
}

export function MyEventCard({ event }: { readonly event: MyEvent }) {
  const code = event.activity.publicCode;
  const total = event.materials.length;
  const approved = event.materials.filter((material) => material.status === "approved").length;
  const needsSupplement = event.materials.some((material) => material.status === "needs_supplement");
  return (
    <Card className="me-event-card">
      <header className="me-event-card__head">
        <div>
          <h2 className="ui-card__title">
            <Link to="/me/$publicCode" params={{ publicCode: code }}>{event.activity.title}</Link>
          </h2>
          <p className="ui-card__description">
            {label(ACTIVITY_STATUS_LABELS, event.activity.status)} ·{" "}
            {label(REGISTRATION_STATUS_LABELS, event.registration.status)} · 更新{" "}
            {new Date(event.registration.updatedAt).toLocaleString("zh-CN")}
          </p>
        </div>
        <Badge tone={registrationTone(event.registration.status)}>
          {label(REGISTRATION_STATUS_LABELS, event.registration.status)}
        </Badge>
      </header>
      {event.registration.reviewNote ? (
        <p className="me-event-card__note">审核备注：{event.registration.reviewNote}</p>
      ) : null}
      <p className="ui-card__description">
        材料 {approved}/{total}{needsSupplement ? " · 有材料需要补交" : ""}
      </p>
      {event.schedule.length === 0 ? null : (
        <ul className="me-event-card__mini" aria-label="我的赛程">
          {event.schedule.slice(0, 3).map((entry) => (
            <li key={`${entry.order}-${entry.title}`}>
              {entry.slotLabel} · {entry.title}
            </li>
          ))}
        </ul>
      )}
      {event.results.length === 0 ? null : (
        <ul className="me-event-card__mini" aria-label="我的赛果">
          {event.results.slice(0, 2).map((result) => (
            <li key={`${result.stageKey}-${result.releasedAt}`}>
              {result.publicTitle} · 第 {result.rank} 名
              {result.awards.length === 0 ? "" : ` · ${result.awards.join(" / ")}`}
            </li>
          ))}
        </ul>
      )}
      <footer className="me-event-card__actions">
        <Link className="ui-button ui-button--primary ui-button--md" to="/me/$publicCode" params={{ publicCode: code }}>
          查看详情
        </Link>
        {event.links.event === null ? null : (
          <a className="ui-button ui-button--secondary ui-button--md" href={event.links.event}>查看活动</a>
        )}
        {event.links.edit === null ? null : (
          <a className="ui-button ui-button--secondary ui-button--md" href={event.links.edit}>编辑报名 / 补充材料</a>
        )}
        {event.archived ? <Badge tone="neutral">已归档</Badge> : null}
      </footer>
    </Card>
  );
}
```

- [ ] **Step 4: 写通知列表**

`components/me/NotificationList.tsx`：

```tsx
import { Button } from "../ui/Button.js";
import { EmptyState } from "../ui/EmptyState.js";
import type { MyNotification } from "../../api/me.js";

export function NotificationList({
  items,
  unreadCount,
  busy,
  onOpen,
  onMarkAll,
}: {
  readonly items: readonly MyNotification[];
  readonly unreadCount: number;
  readonly busy: boolean;
  readonly onOpen: (item: MyNotification) => void;
  readonly onMarkAll: () => void;
}) {
  return (
    <section className="me-notifications" aria-labelledby="me-notifications-title">
      <header className="me-notifications__head">
        <h2 className="ui-card__title" id="me-notifications-title">通知</h2>
        <span className="me-notifications__count">{unreadCount} 条未读</span>
        {unreadCount === 0 ? null : (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onMarkAll}>全部已读</Button>
        )}
      </header>
      {items.length === 0 ? (
        <EmptyState title="暂无通知" description="报名审核、材料、节目单和赛果更新会出现在这里。" />
      ) : (
        <ul className="me-notifications__list">
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className={item.read ? "me-notification" : "me-notification is-unread"}
                onClick={() => onOpen(item)}
              >
                <span className="me-notification__dot" aria-hidden="true" />
                <span className="me-notification__title">{item.title}</span>
                <span className="me-notification__body">{item.body}</span>
                <time className="me-notification__time" dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString("zh-CN")}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 5: 写页面**

`routes/me.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { fetchMyCenter, markMyNotificationsRead, type MyNotification } from "../api/me.js";
import { RequireSession } from "../auth/RequireSession.js";
import { MyEventCard } from "../components/me/MyEventCard.js";
import { NotificationList } from "../components/me/NotificationList.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";

export function MePage() {
  return <RequireSession><MeContent /></RequireSession>;
}

function MeContent() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["my-center"],
    queryFn: ({ signal }) => fetchMyCenter(signal),
    staleTime: 0,
    retry: false,
  });
  const markRead = useMutation({
    mutationFn: (keys: readonly string[]) => markMyNotificationsRead(keys),
    onSuccess: (result, keys) => {
      queryClient.setQueryData(["my-center"], (current: Awaited<ReturnType<typeof fetchMyCenter>> | undefined) => {
        if (current === undefined) return current;
        return {
          ...current,
          notifications: {
            ...current.notifications,
            items: current.notifications.items.map((item) =>
              keys.includes(item.key) ? { ...item, read: true } : item),
            unreadCount: result.unreadCount,
          },
        };
      });
    },
  });

  useEffect(() => { document.title = "我的 · ArtFlow"; }, []);

  function open(item: MyNotification): void {
    markRead.mutate([item.key]);
    void navigate({ to: "/me/$publicCode", params: { publicCode: item.activity.publicCode } });
  }

  if (query.isPending) return <p className="me-state">正在加载我的活动…</p>;
  if (query.error !== null) {
    return <ErrorState description="个人中心暂时无法加载。" onRetry={() => void query.refetch()} />;
  }
  const center = query.data;
  if (center === undefined) return null;
  return (
    <section className="me-page">
      <header className="me-header">
        <div>
          <p className="eyebrow">MY ARTFLOW</p>
          <h1 className="ui-page-title">我的</h1>
          <p className="ui-page-meta">报名、材料、个人赛程与赛果。</p>
        </div>
        <Link className="ui-button ui-button--secondary ui-button--md" to="/join">报名新活动</Link>
      </header>
      <div className="me-grid">
        <div className="me-events">
          {center.events.length === 0 ? (
            <EmptyState
              title="还没有报名任何活动"
              description="输入活动公开码开始报名。"
              action={<Link className="ui-button ui-button--primary ui-button--md" to="/join">去报名</Link>}
            />
          ) : center.events.map((event) => (
            <MyEventCard key={event.activity.publicCode} event={event} />
          ))}
        </div>
        <aside className="me-rail">
          <NotificationList
            items={center.notifications.items}
            unreadCount={center.notifications.unreadCount}
            busy={markRead.isPending}
            onOpen={open}
            onMarkAll={() => markRead.mutate(center.notifications.items.map((item) => item.key))}
          />
        </aside>
      </div>
    </section>
  );
}
```

- [ ] **Step 6: 路由与壳**

`router.tsx`：

```tsx
const meRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/me",
  component: lazyRouteComponent(() => import("./routes/me.js"), "MePage"),
});
```

加入 `routeTree.addChildren`。

`PortalShell.tsx` 导航增加：

```tsx
<Link to="/me" className="nav-link">我的</Link>
```

`joinActivity.tsx` 的 `onChanged` 增加：

```tsx
void queryClient.invalidateQueries({ queryKey: ["my-center"] });
```

- [ ] **Step 7: 写 CSS**

`styles/me.css` 写入以下样式：

```css
.me-page { max-width: 1180px; margin: 0 auto; padding: 48px 24px 72px; }
.me-header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-end; padding-bottom: 24px; border-bottom: 1px solid var(--line); }
.me-grid { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 24px; padding-top: 24px; }
.me-events { display: grid; gap: 16px; }
.me-rail { min-width: 0; }
.me-event-card__head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.me-event-card__note { margin: 12px 0; padding: 10px 12px; border-left: 2px solid var(--gold); background: var(--gold-soft); }
.me-event-card__mini { margin: 8px 0 0; padding-left: 18px; color: var(--bone-dim); font-size: 0.9rem; line-height: 1.8; }
.me-event-card__actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 16px; }
.me-detail { display: grid; gap: 24px; padding-top: 24px; }
.me-detail__section { padding: 20px; border: 1px solid var(--line); border-radius: 10px; }
.me-detail__section h2 { margin: 0 0 12px; font-size: 1.1rem; }
.me-material-list, .me-schedule-list, .me-results-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
.me-material-list li, .me-schedule-list li, .me-results-list li { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--line); }
.me-notifications__head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
.me-notifications__list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
.me-notification { display: grid; grid-template-columns: 8px 1fr; gap: 4px 10px; width: 100%; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.me-notification.is-unread { border-color: var(--gold); }
.me-notification__dot { width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--line); }
.me-notification.is-unread .me-notification__dot { background: var(--gold); }
.me-notification__title { font-weight: 700; }
.me-notification__body { grid-column: 2; color: var(--bone-dim); font-size: 0.9rem; }
.me-notification__time { grid-column: 2; color: var(--bone-subtle); font-size: 0.75rem; }
.me-state { max-width: 720px; margin: 0 auto; padding: 96px 24px; text-align: center; }
@media (max-width: 900px) {
  .me-grid { grid-template-columns: 1fr; }
  .me-page { padding: 24px 16px 56px; }
}
```

在 `global.css` 的 `portal-event.css` 后加入 `@import "./me.css";`。

- [ ] **Step 8: 写页面测试**

`routes/me.test.tsx`：

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useMutationMock = vi.hoisted(() => vi.fn());
const useQueryClientMock = vi.hoisted(() => vi.fn());
const useNavigateMock = vi.hoisted(() => vi.fn());
const markMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
  useMutation: useMutationMock,
  useQueryClient: useQueryClientMock,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: useNavigateMock,
  Link: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../api/me.js", () => ({ fetchMyCenter: vi.fn(), markMyNotificationsRead: markMock }));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import { MePage } from "./me.js";

const notification = {
  key: "ME-1:registration:approved:staff:abc",
  kind: "registration" as const,
  title: "报名已通过",
  body: "你的报名已通过审核。",
  activity: { publicCode: "ME-1", title: "活动 ME-1" },
  createdAt: "2026-04-18T13:00:00.000Z",
  read: false,
  href: "/me/ME-1",
};
const event = {
  activity: {
    publicCode: "ME-1", title: "活动 ME-1", status: "active" as const,
    startsAt: null, endsAt: null, venue: "剧场", organizer: "学生会",
  },
  registration: {
    status: "approved" as const, editable: false, reviewNote: "欢迎",
    supplementKeys: [], createdAt: "2026-04-18T10:00:00.000Z", updatedAt: "2026-04-18T13:00:00.000Z",
  },
  materials: [{
    id: "mat-1", questionKey: "audio", originalName: "demo.mp3", contentType: "audio/mpeg",
    byteLength: 3, status: "approved" as const, reviewNote: "很好", revision: 1,
    contentPath: "/api/activities/act-me-1/materials/mat-1/content",
    reviewedAt: "2026-04-18T12:00:00.000Z", updatedAt: "2026-04-18T12:00:00.000Z",
  }],
  schedule: [], results: [],
  links: { event: "/e/ME-1", edit: null },
  archived: false,
};
const center = { events: [event], notifications: { items: [notification], unreadCount: 1 } };

describe("MePage", () => {
  beforeEach(() => {
    useNavigateMock.mockReturnValue(vi.fn());
    useQueryClientMock.mockReturnValue({ setQueryData: vi.fn(), invalidateQueries: vi.fn() });
    markMock.mockResolvedValue({ unreadCount: 0 });
    useMutationMock.mockImplementation(({ mutationFn, onSuccess }: {
      readonly mutationFn: (keys: readonly string[]) => Promise<{ unreadCount: number }>;
      readonly onSuccess?: (result: { unreadCount: number }, keys: readonly string[]) => void;
    }) => ({
      mutate: (keys: readonly string[]) => {
        void mutationFn(keys).then((result) => onSuccess?.(result, keys));
      },
      isPending: false,
    }));
    useQueryMock.mockReturnValue({ data: center, error: null, isPending: false });
  });

  it("renders events and notifications", () => {
    render(<MePage />);
    expect(screen.getByText("活动 ME-1")).toBeInTheDocument();
    expect(screen.getByText("已通过")).toBeInTheDocument();
    expect(screen.getByText("报名已通过")).toBeInTheDocument();
  });

  it("marks all notifications read", async () => {
    render(<MePage />);
    fireEvent.click(screen.getByRole("button", { name: "全部已读" }));
    await waitFor(() => expect(markMock).toHaveBeenCalledWith([notification.key]));
  });

  it("shows the empty state", () => {
    useQueryMock.mockReturnValue({
      data: { events: [], notifications: { items: [], unreadCount: 0 } },
      error: null,
      isPending: false,
    });
    render(<MePage />);
    expect(screen.getByText("还没有报名任何活动")).toBeInTheDocument();
    expect(screen.getByText("暂无通知")).toBeInTheDocument();
  });
});
```

- [ ] **Step 9: 运行**

```powershell
pnpm --filter @artflow-plus/web test -- me
pnpm --filter @artflow-plus/web run check
```

Expected：PASS。

- [ ] **Step 10: 提交**

```bash
git add plus/apps/web/src
git commit -m "feat(web): add the participant center dashboard"
```

---

## Task 5: `/me/$publicCode` 详情页

**Files:**
- Create: `plus/apps/web/src/components/me/MeMaterialList.tsx`
- Create: `plus/apps/web/src/components/me/MeSchedule.tsx`
- Create: `plus/apps/web/src/components/me/MeResults.tsx`
- Create: `plus/apps/web/src/routes/meEvent.tsx`
- Modify: `plus/apps/web/src/router.tsx`
- Test: `plus/apps/web/src/routes/meEvent.test.tsx`

- [ ] **Step 1: 写组件**

`components/me/MeMaterialList.tsx`：

```tsx
import type { MyEvent } from "../../api/me.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MATERIAL_STATUS_LABELS: Readonly<Record<MyEvent["materials"][number]["status"], string>> = {
  uploaded: "已上传",
  approved: "已通过",
  needs_supplement: "需补交",
};

export function MeMaterialList({ event }: { readonly event: MyEvent }) {
  return (
    <section className="me-detail__section">
      <h2>材料</h2>
      {event.materials.length === 0 ? (
        <p className="state-copy">还没有上传材料。</p>
      ) : (
        <ul className="me-material-list">
          {event.materials.map((material) => (
            <li key={material.id}>
              <div>
                <strong>{material.originalName}</strong>
                <span> · {formatBytes(material.byteLength)} · {MATERIAL_STATUS_LABELS[material.status]}</span>
                {material.reviewNote === "" ? null : (
                  <p className="ui-card__description">审核备注：{material.reviewNote}</p>
                )}
              </div>
              {material.contentPath === null ? (
                <span className="ui-card__description">由主办方上传</span>
              ) : (
                <a className="ui-button ui-button--secondary ui-button--sm" href={material.contentPath}>
                  下载
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

`components/me/MeSchedule.tsx`：

```tsx
import type { MyEvent } from "../../api/me.js";

export function MeSchedule({ event }: { readonly event: MyEvent }) {
  return (
    <section className="me-detail__section">
      <h2>我的赛程</h2>
      {event.schedule.length === 0 ? (
        <p className="state-copy">节目单尚未发布或没有你的条目</p>
      ) : (
        <ol className="me-schedule-list">
          {event.schedule.map((entry) => (
            <li key={`${entry.order}-${entry.title}`}>
              <span>
                {entry.startsAt === null ? entry.slotLabel : new Date(entry.startsAt).toLocaleString("zh-CN")}
              </span>
              <strong>{entry.title}</strong>
              {entry.note === "" ? null : <span className="ui-card__description">{entry.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

`components/me/MeResults.tsx`：

```tsx
import type { MyEvent } from "../../api/me.js";

export function MeResults({ event }: { readonly event: MyEvent }) {
  return (
    <section className="me-detail__section">
      <h2>我的赛果</h2>
      {event.results.length === 0 ? (
        <p className="state-copy">赛果尚未发布</p>
      ) : (
        <ul className="me-results-list">
          {event.results.map((result) => (
            <li key={`${result.stageKey}-${result.releasedAt}`}>
              <span>{result.publicTitle}</span>
              <strong>第 {result.rank} 名</strong>
              <span>{result.unit === "percent" ? `${result.score}%` : result.score}</span>
              {result.awards.length === 0 ? null : <span>{result.awards.join(" / ")}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

每个组件接收 `event: MyEvent`，不自己 fetch。

- [ ] **Step 2: 写详情页**

```tsx
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { fetchMyCenter } from "../api/me.js";
import { RequireSession } from "../auth/RequireSession.js";
import { ACTIVITY_STATUS_LABELS, REGISTRATION_STATUS_LABELS, label } from "../components/format/labels.js";
import { MeMaterialList } from "../components/me/MeMaterialList.js";
import { MeResults } from "../components/me/MeResults.js";
import { MeSchedule } from "../components/me/MeSchedule.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";

export function MeEventPage() {
  return <RequireSession><MeEventContent /></RequireSession>;
}

function MeEventContent() {
  const { publicCode } = useParams({ from: "/me/$publicCode" });
  const query = useQuery({
    queryKey: ["my-center"],
    queryFn: ({ signal }) => fetchMyCenter(signal),
    staleTime: 0,
    retry: false,
  });
  const event = query.data?.events.find((item) => item.activity.publicCode === publicCode);
  useEffect(() => {
    document.title = event === undefined ? "我的 · ArtFlow" : `${event.activity.title} · 我的`;
  }, [event]);
  if (query.isPending) return <p className="me-state">正在加载…</p>;
  if (query.error !== null) {
    return <ErrorState description="活动暂时无法加载。" onRetry={() => void query.refetch()} />;
  }
  if (event === undefined) {
    return (
      <EmptyState
        title="没有找到这场活动的报名"
        description="请确认活动公开码，或从「我的」列表进入。"
        action={<Link className="ui-button ui-button--secondary ui-button--md" to="/me">返回我的</Link>}
      />
    );
  }
  return (
    <section className="me-page">
      <header className="me-header">
        <div>
          <Link to="/me" className="table-link">← 返回我的</Link>
          <h1 className="ui-page-title">{event.activity.title}</h1>
          <p className="ui-page-meta">
            {label(ACTIVITY_STATUS_LABELS, event.activity.status)} · 报名{" "}
            {label(REGISTRATION_STATUS_LABELS, event.registration.status)}
            {event.activity.venue ? ` · ${event.activity.venue}` : ""}
          </p>
        </div>
        {event.links.event === null ? null : (
          <a className="ui-button ui-button--secondary ui-button--md" href={event.links.event}>公开活动页</a>
        )}
      </header>
      <div className="me-detail">
        <section className="me-detail__section">
          <h2>报名</h2>
          <p>状态：{label(REGISTRATION_STATUS_LABELS, event.registration.status)}</p>
          {event.registration.reviewNote ? <p>审核备注：{event.registration.reviewNote}</p> : null}
          {event.registration.supplementKeys.length === 0 ? null : (
            <p>需要补交：{event.registration.supplementKeys.join("、")}</p>
          )}
          {event.links.edit === null ? null : (
            <a className="ui-button ui-button--primary ui-button--md" href={event.links.edit}>编辑报名 / 补充材料</a>
          )}
        </section>
        <MeMaterialList event={event} />
        <MeSchedule event={event} />
        <MeResults event={event} />
      </div>
    </section>
  );
}
```

- [ ] **Step 3: 注册路由**

`router.tsx`：

```tsx
const meEventRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/me/$publicCode",
  component: lazyRouteComponent(() => import("./routes/meEvent.js"), "MeEventPage"),
});
```

加入 `routeTree.addChildren`。

- [ ] **Step 4: 写详情测试**

`routes/meEvent.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({
  useParams: useParamsMock,
  Link: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../api/me.js", () => ({ fetchMyCenter: vi.fn() }));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import { MeEventPage } from "./meEvent.js";

const event = {
  activity: {
    publicCode: "ME-1", title: "活动 ME-1", status: "active" as const,
    startsAt: null, endsAt: null, venue: "剧场", organizer: "学生会",
  },
  registration: {
    status: "approved" as const, editable: false, reviewNote: "欢迎",
    supplementKeys: [], createdAt: "2026-04-18T10:00:00.000Z", updatedAt: "2026-04-18T13:00:00.000Z",
  },
  materials: [{
    id: "mat-1", questionKey: "audio", originalName: "demo.mp3", contentType: "audio/mpeg",
    byteLength: 3, status: "approved" as const, reviewNote: "很好", revision: 1,
    contentPath: "/api/activities/act-me-1/materials/mat-1/content",
    reviewedAt: "2026-04-18T12:00:00.000Z", updatedAt: "2026-04-18T12:00:00.000Z",
  }],
  schedule: [{
    order: 1, slotLabel: "第一轮", title: "我的节目", note: "",
    startsAt: "2026-04-18T11:00:00.000Z",
  }],
  results: [{
    stageKey: "final", publicTitle: "正式赛果", releasedAt: "2026-04-18T13:00:00.000Z",
    rank: 1, score: "98.00", awards: ["冠军"],
  }],
  links: { event: "/e/ME-1", edit: null },
  archived: false,
};

describe("MeEventPage", () => {
  beforeEach(() => useParamsMock.mockReturnValue({ publicCode: "ME-1" }));

  it("renders the detail sections", () => {
    useQueryMock.mockReturnValue({
      data: { events: [event], notifications: { items: [], unreadCount: 0 } },
      error: null,
      isPending: false,
    });
    render(<MeEventPage />);
    expect(screen.getByRole("heading", { name: "报名" })).toBeInTheDocument();
    expect(screen.getByText("demo.mp3")).toBeInTheDocument();
    expect(screen.getByText("我的节目")).toBeInTheDocument();
    expect(screen.getByText("第 1 名")).toBeInTheDocument();
  });

  it("shows not found for an event outside the actor's list", () => {
    useQueryMock.mockReturnValue({
      data: { events: [], notifications: { items: [], unreadCount: 0 } },
      error: null,
      isPending: false,
    });
    render(<MeEventPage />);
    expect(screen.getByText("没有找到这场活动的报名")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: 运行**

```powershell
pnpm --filter @artflow-plus/web test -- me
pnpm --filter @artflow-plus/web run check
```

Expected：PASS。

- [ ] **Step 6: 提交**

```bash
git add plus/apps/web/src
git commit -m "feat(web): add the participant event detail"
```

---

## Task 6: E2E、a11y 与最终门禁

**Files:**
- Modify: `plus/apps/web/e2e/registration-loop.spec.ts`
- Modify: `plus/apps/web/e2e/a11y.spec.ts`
- Modify: `docs/artflow-plus/specs/2026-11-18-participant-center-design.md`（仅当实现偏离时）

- [ ] **Step 1: 扩展 registration-loop**

在 Ops 批准并定稿后，参与者上下文增加：

```ts
await participant.goto("/me");
await expect(participant.getByText("2026 院十佳报名")).toBeVisible();
await expect(participant.getByText("已通过", { exact: true })).toBeVisible();
await expect(participant.getByText(/demo\.mp3/)).toBeVisible();
await expect(participant.getByText("报名已通过")).toBeVisible();
await participant.getByRole("link", { name: "查看详情" }).click();
await expect(participant).toHaveURL(/\/me\/E2E-REG$/);
await expect(participant.getByRole("heading", { name: "报名" })).toBeVisible();
await expect(participant.getByText("节目单尚未发布或没有你的条目")).toBeVisible();
await expect(participant.getByText("赛果尚未发布")).toBeVisible();
```

- [ ] **Step 2: a11y 加 `/me`**

`authenticatedSurfaces` 增加：

```ts
{ path: "/me", ready: (page) => page.locator(".me-page") },
```

（`e2e-ops` 没有报名，页面显示空态；`.me-page` 仍渲染。）

- [ ] **Step 3: 跑 E2E**

```powershell
Set-Location plus
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:NO_PROXY = "127.0.0.1,localhost,::1"
$env:no_proxy = "127.0.0.1,localhost,::1"
pnpm --filter @artflow-plus/web test:e2e -- registration-loop.spec.ts a11y.spec.ts
```

Expected：PASS。

- [ ] **Step 4: 全量门禁**

```powershell
pnpm run check
$env:REQUIRE_DB = "1"
pnpm run test
pnpm run schema:check
pnpm run build:prod
pnpm --filter @artflow-plus/contract-tools graph:check
```

仓库根：

```powershell
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
pwsh -NoProfile -File scripts/check_docs.ps1
```

- [ ] **Step 5: 提交并收尾**

```bash
git add -A
git commit -m "test: cover the participant center"
```

按仓库规则合并 `feat/participant-center` 到 `main`，推送后盯 Gates / Security / Workflow lint 全绿。
