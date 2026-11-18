# Portal 公开活动站实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ArtFlow-Plus 上交付 `/e/$publicCode` 公开活动站、Studio 公开资料编辑、节目单开始时间、公开读 fail-closed/归档过滤修正，以及包含公开资料的归档快照。

**Architecture:** 公开资料使用独立 `activity_public_profile` 表与 `activity.public_profile.update` engine 命令；公开页读取新的聚合读 `GET /api/public/events/:publicCode`；`schedule_entry.starts_at` 通过既有 `schedule.entry.upsert` 写入，并进入 formal release 快照。所有公开读只暴露 `active|closed` 活动，内部 Ops/Studio/Admin 读取不变。

**Tech Stack:** Node 24、TypeScript、Fastify 5、Kysely、PostgreSQL 18、React 19、TanStack Router/Query、Vitest、Playwright。

**Spec:** [`2026-11-18-portal-public-event-site-design.md`](../specs/2026-11-18-portal-public-event-site-design.md)

---

## 0. 先决条件

- 当前分支：`feat/portal-public-event-site`（已包含设计提交）。
- 本地 PostgreSQL 容器 `artflow-plus-postgres` 在 `127.0.0.1:5433`。
- 每轮开始先确认基线：

```powershell
Set-Location C:\Users\16275\Desktop\ArtFlow\plus
pnpm install
pnpm run check
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm run test
```

若基线在上游已坏，先停下修基线，不带病叠加新功能。

## 文件结构

| 文件 | 责任 |
| --- | --- |
| `plus/packages/db/src/migrations/0030_activity_public_profile.ts` | 新建公开资料表 |
| `plus/packages/db/src/migrations/0031_schedule_entry_starts_at.ts` | 日程条目开始时间 |
| `plus/packages/db/src/activity-public-profile-repository.ts` | 公开资料读写、默认值、乐观并发 |
| `plus/packages/db/src/schedule-repository.ts` | `startsAt`、最新 release 查询、旧快照规范化 |
| `plus/packages/runtime/src/public-profile-service.ts` | `activity.public_profile.update` 命令 |
| `plus/packages/runtime/src/public-event-service.ts` | 公开聚合读 |
| `plus/packages/runtime/src/registration-read-service.ts` | `registrationEnabled`、`getPublicProgram` fail-closed |
| `plus/packages/runtime/src/schedule-service.ts` | `startsAt` 写入与 release 快照 |
| `plus/packages/runtime/src/studio-service.ts` | `StudioState.publicProfile` |
| `plus/packages/runtime/src/archive-service.ts` | 归档时读取公开资料 |
| `plus/packages/runtime/src/archive-package.ts` | `public-profile.json` artifact |
| `plus/apps/api/src/routes/public.ts` | `GET /api/public/events/:publicCode` |
| `plus/apps/api/src/routes/activity.ts` | `POST /api/activities/:id/public-profile` |
| `plus/apps/api/src/http/schemas.ts` | 公开资料 body schema、日程 `startsAt` |
| `plus/apps/web/src/api/publicEvent.ts` | 公开活动站 API 客户端 |
| `plus/apps/web/src/api/studio.ts` | `StudioState.publicProfile`、保存命令 |
| `plus/apps/web/src/api/schedule.ts` | `startsAt` 类型与 upsert 入参 |
| `plus/apps/web/src/routes/publicEvent.tsx` | `/e/$publicCode` 页面 |
| `plus/apps/web/src/routes/studioPublicProfile.tsx` | `/studio/$activityId/public` 编辑器 |
| `plus/apps/web/src/components/portal/Event*.tsx` | Hero / About / Program / Results / Share |
| `plus/apps/web/src/components/ops/ScheduleCard.tsx` | 开始时间与行内编辑 |
| `plus/apps/web/src/styles/portal-event.css` | 活动站样式与打印 |
| `plus/apps/web/src/router.tsx` | 两条新路由 |
| `plus/apps/api/scripts/seed-public-result.ts` | E2E 公开资料 seed |

## Test architecture

按 spec §9 执行，不在计划里重复整段。映射：

| Spec 要求 | 覆盖任务 |
| --- | --- |
| 公开资料命令成功/陈旧/归档/权限/幂等/回滚/并发首次保存 | Task 2、Task 7 |
| `startsAt` 写入、旧快照、release 快照 | Task 3、Task 10 |
| 公开读 fail-closed、归档过滤、`registrationEnabled` | Task 4、Task 6 |
| 聚合读、内部 ID 剥离、404、限流 | Task 5 |
| 公开页、空态、分享、打印、移动端 | Task 8、Task 12 |
| Studio 编辑器、冲突、预览 | Task 9、Task 12 |
| 归档 `public-profile.json` | Task 11 |
| mode 隔离、归档内部可见、unarchive 恢复 | Task 4、Task 11 |

聚焦命令：

```powershell
Set-Location plus
pnpm --filter @artflow-plus/runtime test -- public-profile-service public-event-service schedule-service
pnpm --filter @artflow-plus/api test -- public-event studio
pnpm --filter @artflow-plus/web test -- publicEvent studioPublicProfile ScheduleCard
pnpm run check
pnpm run schema:check
```

---

## Task 1: 公开资料表与 repository

**Files:**
- Create: `plus/packages/db/src/migrations/0030_activity_public_profile.ts`
- Create: `plus/packages/db/src/activity-public-profile-repository.ts`
- Modify: `plus/packages/db/src/migrations.ts:4-66`
- Modify: `plus/packages/db/src/index.ts:1-27`
- Generate: `plus/packages/db/schema.snapshot.json`, `plus/packages/db/src/types.ts`
- Test: `plus/packages/db/test/activity-public-profile-repository.test.ts`

- [ ] **Step 1: 写迁移**

```ts
import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable("activity_public_profile")
      .addColumn("activity_id", "varchar(100)", (column) =>
        column.primaryKey().references("activity.id").onDelete("cascade"),
      )
      .addColumn("tagline", "varchar(160)", (column) => column.notNull().defaultTo(""))
      .addColumn("description", "text", (column) => column.notNull().defaultTo(""))
      .addColumn("venue", "varchar(200)", (column) => column.notNull().defaultTo(""))
      .addColumn("starts_at", "timestamptz")
      .addColumn("ends_at", "timestamptz")
      .addColumn("organizer", "varchar(200)", (column) => column.notNull().defaultTo(""))
      .addColumn("contact", "varchar(200)", (column) => column.notNull().defaultTo(""))
      .addColumn("announcement", "text", (column) => column.notNull().defaultTo(""))
      .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("updated_by", "varchar(100)", (column) => column.notNull().defaultTo(""))
      .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .execute();
  },
  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.dropTable("activity_public_profile").ifExists().execute();
  },
};
```

- [ ] **Step 2: 注册迁移**

在 `migrations.ts` 增加 import：

```ts
import { migration as m0030_activity_public_profile } from "./migrations/0030_activity_public_profile.js";
```

并在 `migrations` 表末尾加入：

```ts
"0030_activity_public_profile": m0030_activity_public_profile,
```

- [ ] **Step 3: 生成 schema snapshot 与 types**

```powershell
Set-Location plus
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm --filter @artflow-plus/db run schema:snapshot
pnpm --filter @artflow-plus/db run schema:types
```

Expected：`schema.snapshot.json` 出现 `activity_public_profile`，`types.ts` 出现 `ActivityPublicProfileRow`。

- [ ] **Step 4: 写 repository 失败测试**

```ts
import { randomUUID } from "node:crypto";
import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  findActivityPublicProfile,
  getActivityPublicProfile,
  upsertActivityPublicProfile,
} from "../src/activity-public-profile-repository.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
const schema = `artflow_public_profile_repo_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;

describe.skipIf(!connectionString)("activity public profile repository", () => {
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

  async function seedActivity(): Promise<string> {
    const id = `act-${randomUUID()}`;
    await db.insertInto("activity").values({
      id, public_code: id, title: "公开资料", status: "active", revision: 1,
      enabled_capabilities: JSON.stringify(["publishing"]), active_definition_version: 1,
    }).execute();
    return id;
  }

  it("returns empty defaults when no row exists", async () => {
    const activityId = await seedActivity();
    expect(await findActivityPublicProfile(db, activityId)).toBeNull();
    expect(await getActivityPublicProfile(db, activityId)).toMatchObject({
      activityId, tagline: "", revision: 0,
    });
  });

  it("creates then rejects a stale revision", async () => {
    const activityId = await seedActivity();
    const created = await upsertActivityPublicProfile(db, {
      activityId, tagline: "春日", description: "", venue: "", startsAt: null, endsAt: null,
      organizer: "", contact: "", announcement: "", updatedBy: "staff",
      updatedAt: "2026-04-01T10:00:00.000Z",
    }, 0);
    expect(created.revision).toBe(1);
    await expect(upsertActivityPublicProfile(db, {
      activityId, tagline: "第二次", description: "", venue: "", startsAt: null, endsAt: null,
      organizer: "", contact: "", announcement: "", updatedBy: "staff",
      updatedAt: "2026-04-01T10:01:00.000Z",
    }, 0)).rejects.toMatchObject({ code: "STALE_REVISION" });
  });
});
```

- [ ] **Step 5: 运行测试确认失败**

```powershell
$env:REQUIRE_DB = "1"
pnpm --filter @artflow-plus/db test -- activity-public-profile-repository
```

Expected：FAIL，模块/函数不存在。

- [ ] **Step 6: 写 repository**

```ts
import { sql, type Kysely, type Selectable } from "kysely";

import { StaleRevisionError } from "./activity-repository.js";
import type { ActivityPublicProfileRow, Database } from "./types.js";

export interface StoredActivityPublicProfile {
  readonly activityId: string;
  readonly tagline: string;
  readonly description: string;
  readonly venue: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly organizer: string;
  readonly contact: string;
  readonly announcement: string;
  readonly revision: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface ActivityPublicProfileInput {
  readonly activityId: string;
  readonly tagline: string;
  readonly description: string;
  readonly venue: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly organizer: string;
  readonly contact: string;
  readonly announcement: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function rowToProfile(row: Selectable<ActivityPublicProfileRow>): StoredActivityPublicProfile {
  return {
    activityId: row.activity_id,
    tagline: row.tagline,
    description: row.description,
    venue: row.venue,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    organizer: row.organizer,
    contact: row.contact,
    announcement: row.announcement,
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at) ?? "",
  };
}

export async function findActivityPublicProfile(
  db: Kysely<Database>,
  activityId: string,
): Promise<StoredActivityPublicProfile | null> {
  const row = await db.selectFrom("activity_public_profile").selectAll()
    .where("activity_id", "=", activityId).executeTakeFirst();
  return row === undefined ? null : rowToProfile(row);
}

export async function getActivityPublicProfile(
  db: Kysely<Database>,
  activityId: string,
): Promise<StoredActivityPublicProfile> {
  return (await findActivityPublicProfile(db, activityId)) ?? {
    activityId, tagline: "", description: "", venue: "", startsAt: null, endsAt: null,
    organizer: "", contact: "", announcement: "", revision: 0, updatedBy: "", updatedAt: "",
  };
}

async function lockProfile(
  trx: Kysely<Database>,
  activityId: string,
): Promise<StoredActivityPublicProfile | null> {
  const row = await trx.selectFrom("activity_public_profile").selectAll()
    .where("activity_id", "=", activityId).forUpdate().executeTakeFirst();
  return row === undefined ? null : rowToProfile(row);
}

export async function upsertActivityPublicProfile(
  trx: Kysely<Database>,
  input: ActivityPublicProfileInput,
  expectedRevision: number,
): Promise<StoredActivityPublicProfile> {
  // Callers lock the activity row first; this second lock serializes first creation.
  const existing = await lockProfile(trx, input.activityId);
  if (existing === null) {
    if (expectedRevision !== 0) throw new StaleRevisionError(input.activityId);
    const row = await trx.insertInto("activity_public_profile").values({
      activity_id: input.activityId,
      tagline: input.tagline,
      description: input.description,
      venue: input.venue,
      starts_at: input.startsAt === null ? null : new Date(input.startsAt),
      ends_at: input.endsAt === null ? null : new Date(input.endsAt),
      organizer: input.organizer,
      contact: input.contact,
      announcement: input.announcement,
      revision: 1,
      updated_by: input.updatedBy,
      updated_at: new Date(input.updatedAt),
    }).returningAll().executeTakeFirstOrThrow();
    return rowToProfile(row);
  }
  if (existing.revision !== expectedRevision) throw new StaleRevisionError(input.activityId);
  const row = await trx.updateTable("activity_public_profile").set({
    tagline: input.tagline,
    description: input.description,
    venue: input.venue,
    starts_at: input.startsAt === null ? null : new Date(input.startsAt),
    ends_at: input.endsAt === null ? null : new Date(input.endsAt),
    organizer: input.organizer,
    contact: input.contact,
    announcement: input.announcement,
    revision: sql`revision + 1`,
    updated_by: input.updatedBy,
    updated_at: new Date(input.updatedAt),
  }).where("activity_id", "=", input.activityId)
    .where("revision", "=", expectedRevision)
    .returningAll().executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(input.activityId);
  return rowToProfile(row);
}
```

- [ ] **Step 7: 导出 repository**

在 `plus/packages/db/src/index.ts` 增加：

```ts
export * from "./activity-public-profile-repository.js";
```

- [ ] **Step 8: 运行测试**

```powershell
pnpm --filter @artflow-plus/db test -- activity-public-profile-repository
```

Expected：PASS。

- [ ] **Step 9: 提交**

```bash
git add plus/packages/db
git commit -m "feat(db): add activity public profile storage"
```

---

## Task 2: `activity.public_profile.update` 命令

**Files:**
- Create: `plus/packages/runtime/src/public-profile-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Test: `plus/packages/runtime/test/public-profile-service.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { randomUUID } from "node:crypto";
import { closeDb, createDb, findActivityPublicProfile, migrate, readEventsSince } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { createDefaultCapabilityRegistry } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { duplicateActivity } from "../src/activity-service.js";
import { updateActivityPublicProfile } from "../src/public-profile-service.js";
import type { RuntimeDeps } from "../src/deps.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
const schema = `artflow_public_profile_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "public-profile-staff", actorType: "user", roles: ["staff"],
  permissions: ["studio.manage"],
};
const participant: ActorContext = {
  actorId: "public-profile-participant", actorType: "user", roles: ["participant"], permissions: [],
};
function deps(actor: ActorContext = staff): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 3, 1, 10, 0, tick++)).toISOString(),
    newEventId: () => `public-profile-${randomUUID()}`,
  };
}
async function seed(status: "draft" | "active" | "closed" | "archived" = "active"): Promise<string> {
  const id = `act-${randomUUID()}`;
  await db.insertInto("activity").values({
    id, public_code: id, title: "公开资料", status, revision: 1,
    enabled_capabilities: JSON.stringify(["publishing"]), active_definition_version: 1,
  }).execute();
  return id;
}
function input(activityId: string, overrides: Record<string, unknown> = {}) {
  return {
    commandId: randomUUID(), activityId, expectedRevision: 0,
    tagline: "春日声场", description: "介绍", venue: "剧场",
    startsAt: "2026-04-18T11:00:00.000Z", endsAt: "2026-04-18T13:30:00.000Z",
    organizer: "学生会", contact: "联系", announcement: "公告",
    ...overrides,
  };
}

describe.skipIf(!connectionString)("activity.public_profile.update", () => {
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

  it("creates the profile and writes an engine event", async () => {
    const activityId = await seed();
    const outcome = await updateActivityPublicProfile(db, deps(), input(activityId));
    expect(outcome.body).toMatchObject({ activityId, tagline: "春日声场", revision: 1 });
    expect((await readEventsSince(db, { activityId, after: 0, limit: 20 })).map((e) => e.type))
      .toContain("ActivityPublicProfileUpdated");
  });

  it("rejects stale revisions, invalid order, archived activities and participants", async () => {
    const activityId = await seed();
    await updateActivityPublicProfile(db, deps(), input(activityId));
    await expect(updateActivityPublicProfile(db, deps(), input(activityId)))
      .rejects.toMatchObject({ code: "STALE_REVISION" });
    await expect(updateActivityPublicProfile(db, deps(), input(activityId, {
      expectedRevision: 1, startsAt: "2026-04-18T14:00:00.000Z", endsAt: "2026-04-18T13:00:00.000Z",
    }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const archived = await seed("archived");
    await expect(updateActivityPublicProfile(db, deps(), input(archived)))
      .rejects.toMatchObject({ code: "ACTIVITY_ARCHIVED" });
    const participantActivity = await seed();
    await expect(updateActivityPublicProfile(db, deps(participant), input(participantActivity)))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rolls back the profile when the event append fails, then retries cleanly", async () => {
    const activityId = await seed();
    const failing: RuntimeDeps = { ...deps(), newEventId: () => { throw new Error("event id failed"); } };
    await expect(updateActivityPublicProfile(db, failing, input(activityId))).rejects.toThrow("event id failed");
    expect(await findActivityPublicProfile(db, activityId)).toBeNull();
    const retried = await updateActivityPublicProfile(db, deps(), input(activityId));
    expect(retried.body.revision).toBe(1);
  });

  it("serializes two first saves through the activity lock", async () => {
    const activityId = await seed();
    const first = input(activityId);
    const second = input(activityId, { tagline: "第二位" });
    await updateActivityPublicProfile(db, deps(), first);
    await expect(updateActivityPublicProfile(db, deps(), second))
      .rejects.toMatchObject({ code: "STALE_REVISION" });
    const rows = await db.selectFrom("activity_public_profile").select("activity_id")
      .where("activity_id", "=", activityId).execute();
    expect(rows).toHaveLength(1);
  });

  it("replays the same command id without a second revision", async () => {
    const activityId = await seed();
    const body = input(activityId);
    const first = await updateActivityPublicProfile(db, deps(), body);
    const second = await updateActivityPublicProfile(db, deps(), body);
    expect(second.replayed).toBe(true);
    expect(second.body.revision).toBe(first.body.revision);
  });

  it("does not copy the public profile when an activity is duplicated", async () => {
    const source = await seed();
    await updateActivityPublicProfile(db, deps(), input(source));
    const duplicated = await duplicateActivity(db, createDefaultCapabilityRegistry(), deps(), {
      commandId: randomUUID(),
      sourceActivityId: source,
    });
    expect(await findActivityPublicProfile(db, duplicated.body.id)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
$env:REQUIRE_DB = "1"
pnpm --filter @artflow-plus/runtime test -- public-profile-service
```

Expected：FAIL，模块不存在。

- [ ] **Step 3: 写命令**

```ts
import type { Database } from "@artflow-plus/db";
import {
  getActivityForUpdate,
  upsertActivityPublicProfile,
  type StoredActivityPublicProfile,
} from "@artflow-plus/db";
import { DomainError, requirePermission } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";

export interface UpdatePublicProfileInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly expectedRevision: number;
  readonly tagline: string;
  readonly description: string;
  readonly venue: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly organizer: string;
  readonly contact: string;
  readonly announcement: string;
}

function requireText(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length > max) throw new DomainError("INVALID_INPUT", `${field} must be at most ${max} characters.`);
  return trimmed;
}

function requireInstant(value: string | null, field: string): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new DomainError("INVALID_INPUT", `${field} must be an ISO timestamp.`);
  return new Date(parsed).toISOString();
}

export async function updateActivityPublicProfile(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: UpdatePublicProfileInput,
): Promise<CommandOutcome<StoredActivityPublicProfile>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "engine",
    commandType: "activity.public_profile.update",
    actor,
    payload: {
      expectedRevision: input.expectedRevision,
      tagline: input.tagline,
      description: input.description,
      venue: input.venue,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      organizer: input.organizer,
      contact: input.contact,
      announcement: input.announcement,
    },
  }, async (trx) => {
    requirePermission(actor, "studio.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    if (activity.status === "archived") {
      throw new DomainError("ACTIVITY_ARCHIVED", "An archived activity cannot be modified.");
    }
    const startsAt = requireInstant(input.startsAt, "startsAt");
    const endsAt = requireInstant(input.endsAt, "endsAt");
    if (startsAt !== null && endsAt !== null && endsAt < startsAt) {
      throw new DomainError("INVALID_INPUT", "endsAt must not be before startsAt.");
    }
    const saved = await upsertActivityPublicProfile(trx, {
      activityId: activity.id,
      tagline: requireText(input.tagline, "tagline", 160),
      description: requireText(input.description, "description", 4000),
      venue: requireText(input.venue, "venue", 200),
      startsAt,
      endsAt,
      organizer: requireText(input.organizer, "organizer", 200),
      contact: requireText(input.contact, "contact", 200),
      announcement: requireText(input.announcement, "announcement", 2000),
      updatedBy: actor.actorId,
      updatedAt: deps.now(),
    }, input.expectedRevision);
    await appendEngineEvent(trx, deps, {
      type: "ActivityPublicProfileUpdated",
      activityId: activity.id,
      aggregateType: "activity",
      aggregateId: activity.id,
      revision: saved.revision,
      payload: { activityId: activity.id, revision: saved.revision },
    });
    return { body: saved };
  });
}
```

- [ ] **Step 4: 导出命令**

在 `plus/packages/runtime/src/index.ts` 增加：

```ts
export * from "./public-profile-service.js";
```

- [ ] **Step 5: 运行测试**

```powershell
pnpm --filter @artflow-plus/runtime test -- public-profile-service
```

Expected：PASS。

- [ ] **Step 6: 提交**

```bash
git add plus/packages/runtime
git commit -m "feat(runtime): add activity public profile command"
```

---

## Task 3: `schedule_entry.starts_at`

**Files:**
- Create: `plus/packages/db/src/migrations/0031_schedule_entry_starts_at.ts`
- Modify: `plus/packages/db/src/migrations.ts`
- Modify: `plus/packages/db/src/schedule-repository.ts`
- Modify: `plus/packages/runtime/src/schedule-service.ts`
- Modify: `plus/apps/api/src/http/schemas.ts`
- Modify: `plus/apps/api/src/routes/schedule.ts`
- Modify: `plus/apps/web/src/api/schedule.ts`
- Test: `plus/packages/runtime/test/schedule-service.test.ts`

- [ ] **Step 1: 写迁移**

```ts
import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema.alterTable("schedule_entry").addColumn("starts_at", "timestamptz").execute();
  },
  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.alterTable("schedule_entry").dropColumn("starts_at").execute();
  },
};
```

注册到 `migrations.ts`（与 Task 1 相同的模式，键 `0031_schedule_entry_starts_at`），并重新运行 snapshot/types。

- [ ] **Step 2: 写失败测试**

在 `schedule-service.test.ts` 增加：

```ts
it("stores startsAt, preserves it on update, and freezes it into the release snapshot", async () => {
  const activityId = await seed();
  const first = await upsertScheduleEntry(db, deps, {
    commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 0,
    slotKey: "opening", title: "开场舞", startsAt: "2026-04-18T11:00:00.000Z",
  });
  expect(first.body.entry.startsAt).toBe("2026-04-18T11:00:00.000Z");
  const second = await upsertScheduleEntry(db, deps, {
    commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 1,
    entryId: first.body.entry.id, slotKey: "opening", title: "开场舞 2",
  });
  expect(second.body.entry.startsAt).toBe("2026-04-18T11:00:00.000Z");
  const cleared = await upsertScheduleEntry(db, deps, {
    commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 2,
    entryId: first.body.entry.id, slotKey: "opening", title: "开场舞 3", startsAt: null,
  });
  expect(cleared.body.entry.startsAt).toBeNull();
  await expect(upsertScheduleEntry(db, deps, {
    commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 3,
    slotKey: "opening", title: "坏时间", startsAt: "not-a-date",
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

it("normalizes a legacy snapshot without startsAt", async () => {
  const activityId = await seed();
  await db.insertInto("schedule_release").values({
    id: `release-legacy-${randomUUID()}`,
    activity_id: activityId,
    mode: "formal",
    version: 1,
    snapshot: JSON.stringify({
      version: 1, schemaVersion: 1, releasedAt: "2026-04-01T10:00:00.000Z",
      entries: [{ order: 1, slotKey: "opening", slotLabel: "开场", participantId: null, title: "旧版", note: "" }],
    }),
    note: "", released_at: new Date("2026-04-01T10:00:00.000Z"), revoked_at: null,
  }).execute();
  const activity = await db.selectFrom("activity").select("public_code")
    .where("id", "=", activityId).executeTakeFirstOrThrow();
  expect((await getPublicSchedule(db, activity.public_code))?.entries[0]?.startsAt).toBeNull();
});
```

- [ ] **Step 3: 运行测试确认失败**

```powershell
pnpm --filter @artflow-plus/runtime test -- schedule-service
```

Expected：FAIL，`startsAt` 未识别。

- [ ] **Step 4: 扩展 repository**

在 `StoredScheduleEntry`、`ScheduleSnapshotEntry` 增加：

```ts
readonly startsAt: string | null;
```

`entry()` 增加：

```ts
startsAt: iso(row.starts_at),
```

`insertScheduleEntry` 的 `.values({...})` 增加：

```ts
starts_at: value.startsAt === null ? null : new Date(value.startsAt),
```

`updateScheduleEntry` 的 `.set({...})` 增加：

```ts
starts_at: value.startsAt === null ? null : new Date(value.startsAt),
```

`release()` 对旧快照补 `null`：

```ts
function release(row: Selectable<ScheduleReleaseRow>): StoredScheduleRelease {
  const stored = snapshot(row.snapshot);
  return {
    ...existing,
    snapshot: {
      ...stored,
      entries: stored.entries.map((entry) => ({ ...entry, startsAt: entry.startsAt ?? null })),
    },
  };
}
```

- [ ] **Step 5: 扩展 runtime 命令**

`UpsertScheduleEntryInput` 增加：

```ts
readonly startsAt?: string | null;
```

在命令 payload 中加入 `startsAt: input.startsAt ?? null`，在 `current` 对象中加入：

```ts
startsAt: input.startsAt === undefined ? null : normalizeInstant(input.startsAt),
```

更新分支使用：

```ts
startsAt: input.startsAt === undefined ? existing.startsAt : normalizeInstant(input.startsAt),
```

新增：

```ts
function normalizeInstant(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new DomainError("INVALID_INPUT", "startsAt must be an ISO timestamp.");
  return new Date(parsed).toISOString();
}
```

`releaseSchedule` 的 snapshot 条目增加：

```ts
startsAt: entry.startsAt,
```

- [ ] **Step 6: 扩展 API schema 与 route**

`http/schemas.ts` 的 `ScheduleEntryBody` 增加：

```ts
startsAt: Type.Optional(Type.Union([
  Type.String({ minLength: 1, maxLength: 40 }),
  Type.Null(),
])),
```

`routes/schedule.ts` 的 body 类型增加：

```ts
startsAt?: string | null;
```

- [ ] **Step 7: 扩展 Web API 类型**

`plus/apps/web/src/api/schedule.ts`：

```ts
readonly startsAt: string | null; // ScheduleEntryView
```

`ScheduleReleaseView.snapshot.entries` 增加同样的字段；`upsertScheduleEntry` 入参增加：

```ts
readonly startsAt?: string | null;
```

- [ ] **Step 8: 运行测试**

```powershell
pnpm --filter @artflow-plus/runtime test -- schedule-service
pnpm --filter @artflow-plus/web test -- schedule
```

Expected：PASS。

- [ ] **Step 9: 提交**

```bash
git add plus/packages/db plus/packages/runtime plus/apps/api plus/apps/web/src/api/schedule.ts
git commit -m "feat(schedule): add entry start times"
```

---

## Task 4: 公开读 fail-closed 与归档过滤

**Files:**
- Modify: `plus/packages/db/src/publishing-repository.ts:423-464`
- Modify: `plus/packages/db/src/schedule-repository.ts:372-395`
- Modify: `plus/packages/runtime/src/registration-read-service.ts:80-111,245-276`
- Test: `plus/packages/runtime/test/schedule-service.test.ts`
- Test: `plus/packages/runtime/test/golden-result-release-lifecycle.test.ts`

- [ ] **Step 1: 写失败测试**

在 `schedule-service.test.ts` 的 runtime import 中加入 `getPublicProgram`，然后增加：

```ts
it("fails the public program closed when the newest release is revoked", async () => {
  const activityId = await seed();
  const entry = await upsertScheduleEntry(db, deps, {
    commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 0,
    slotKey: "opening", title: "开场舞",
  });
  const first = await releaseSchedule(db, deps, {
    commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 1,
  });
  await upsertScheduleEntry(db, deps, {
    commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 2,
    slotKey: "programs", title: "第二版",
  });
  const second = await releaseSchedule(db, deps, {
    commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 3,
  });
  await revokeScheduleReleaseCommand(db, deps, {
    commandId: randomUUID(), activityId, releaseId: second.body.id, expectedRevision: 4,
  });
  const activity = await db.selectFrom("activity").select("public_code")
    .where("id", "=", activityId).executeTakeFirstOrThrow();
  expect(await getPublicSchedule(db, activity.public_code)).toBeNull();
  expect(await getPublicProgram(db, activity.public_code)).toBeNull();
  expect((await getPublicProgram(db, activity.public_code))).not.toMatchObject({
    entries: [{ title: "开场舞" }],
  });
  expect(first.body.version).toBe(1);
});

it("never exposes a rehearsal schedule release", async () => {
  const activityId = await seed();
  await upsertScheduleEntry(db, deps, {
    commandId: randomUUID(), activityId, mode: "rehearsal", expectedRevision: 0,
    slotKey: "opening", title: "彩排节目",
  });
  await releaseSchedule(db, deps, {
    commandId: randomUUID(), activityId, mode: "rehearsal", expectedRevision: 1,
  });
  const activity = await db.selectFrom("activity").select("public_code")
    .where("id", "=", activityId).executeTakeFirstOrThrow();
  expect(await getPublicSchedule(db, activity.public_code)).toBeNull();
  expect((await getPublicProgram(db, activity.public_code))?.entries).toEqual([]);
});
```

在 `golden-result-release-lifecycle.test.ts` 增加归档断言（复用同一 activity，在现有用例末尾）：

```ts
await db.updateTable("activity").set({ status: "archived" }).where("id", "=", activityId).execute();
expect(await selectPublicResults(db, "ABC123")).toBeNull();
await db.updateTable("activity").set({ status: "closed" }).where("id", "=", activityId).execute();
expect(await selectPublicResults(db, "ABC123")).not.toBeNull();
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm --filter @artflow-plus/runtime test -- schedule-service golden-result-release-lifecycle
```

Expected：FAIL：撤销后 program 仍回退；归档后 results 仍非空。

- [ ] **Step 3: 修改 `selectPublicResults`**

```ts
const activity = await db.selectFrom("activity")
  .select(["id", "public_code", "status"])
  .where("public_code", "=", publicCode)
  .executeTakeFirst();
if (activity === undefined) return null;
if (activity.status !== "active" && activity.status !== "closed") return null;
```

- [ ] **Step 4: 修改 `schedule-repository`**

```ts
export async function getNewestScheduleRelease(
  db: Kysely<Database>,
  publicCode: string,
): Promise<ActiveScheduleRelease | null> {
  const row = await db
    .selectFrom("schedule_release")
    .innerJoin("activity", "activity.id", "schedule_release.activity_id")
    .selectAll("schedule_release")
    .select(["activity.public_code", "activity.title"])
    .where("activity.public_code", "=", publicCode)
    .where("activity.status", "in", ["active", "closed"])
    .where("schedule_release.mode", "=", "formal")
    .orderBy("schedule_release.version", "desc")
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    activityId: row.activity_id,
    publicCode: row.public_code,
    activityTitle: row.title,
    release: release(row),
  };
}

export async function selectActiveScheduleRelease(
  db: Kysely<Database>,
  publicCode: string,
): Promise<ActiveScheduleRelease | null> {
  const newest = await getNewestScheduleRelease(db, publicCode);
  return newest === null || newest.release.revokedAt !== null ? null : newest;
}
```

- [ ] **Step 5: 修改 `getPublicProgram`**

```ts
export async function getPublicProgram(
  db: Kysely<Database>,
  publicCode: string,
): Promise<PublicProgram | null> {
  const activity = await getActivityByPublicCode(db, publicCode);
  if (activity === null || (activity.status !== "active" && activity.status !== "closed")) return null;
  const newest = await getNewestScheduleRelease(db, publicCode);
  if (newest !== null) {
    if (newest.release.revokedAt !== null) return null;
    return {
      activity: { publicCode: newest.publicCode, title: newest.activityTitle },
      entries: newest.release.snapshot.entries.map((entry) => ({
        order: entry.order,
        participantId: entry.participantId ?? `schedule-${entry.order}`,
        name: entry.title,
        song: entry.slotLabel,
        note: entry.note,
        startsAt: entry.startsAt ?? null,
      })),
    };
  }
  const registrations = (await listRegistrations(db, activity.id))
    .filter((registration) => registration.status === "approved");
  return {
    activity: { publicCode: activity.publicCode, title: activity.title },
    entries: registrations.map((registration, index) => ({
      order: index + 1,
      participantId: registration.participantId,
      name: programAnswer(registration.answers, ["name", "displayName", "title"]) || registration.participantId,
      song: programAnswer(registration.answers, ["song", "program", "program_name"]),
      note: programAnswer(registration.answers, ["description", "note"]),
      startsAt: null,
    })),
  };
}
```

同时把 `PublicProgramEntry` 增加 `startsAt: string | null`，并 import `getNewestScheduleRelease`。

- [ ] **Step 6: 增加 `registrationEnabled`**

`getPublicActivity`：

```ts
const registrationEnabled = ["registration", "questionnaire", "materials"]
  .every((capability) => activity.enabledCapabilities.includes(capability));
const registrationOpen = activity.status === "active" &&
  registrationEnabled &&
  release !== null &&
  registrationLifecycle === "open" &&
  roster?.status !== "final" &&
  release.capabilities.questionnaire?.ok === true &&
  release.capabilities.materials?.ok === true;
return { ..., registrationEnabled, registrationOpen };
```

`PublicActivity` 接口增加 `readonly registrationEnabled: boolean;`。
Web `api/registrations.ts` 的 `PublicActivity` 同步增加。

- [ ] **Step 7: 运行测试**

```powershell
pnpm --filter @artflow-plus/runtime test -- schedule-service golden-result-release-lifecycle
pnpm --filter @artflow-plus/api test -- registration-read
```

Expected：PASS。

- [ ] **Step 8: 提交**

```bash
git add plus/packages/db plus/packages/runtime plus/apps/web/src/api/registrations.ts
git commit -m "fix(public): close archived and revoked public reads"
```

---

## Task 5: 公开聚合读与 API

**Files:**
- Create: `plus/packages/runtime/src/public-event-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Modify: `plus/apps/api/src/routes/public.ts`
- Test: `plus/packages/runtime/test/public-event-service.test.ts`
- Test: `plus/apps/api/test/public-event.test.ts`

- [ ] **Step 1: 写聚合读测试**

```ts
import { randomUUID } from "node:crypto";
import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPublicEventSite } from "../src/public-event-service.js";
import { updateActivityPublicProfile } from "../src/public-profile-service.js";
import type { RuntimeDeps } from "../src/deps.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
const schema = `artflow_public_event_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "public-event-staff", actorType: "user", roles: ["staff"], permissions: ["studio.manage"],
};
function deps(): RuntimeDeps {
  return {
    actor: staff,
    now: () => new Date(Date.UTC(2026, 3, 1, 10, 0, tick++)).toISOString(),
    newEventId: () => `public-event-${randomUUID()}`,
  };
}
async function seed(status: "draft" | "active" | "closed" | "archived") {
  const id = `act-${randomUUID()}`;
  const publicCode = `SITE-${randomUUID()}`;
  await db.insertInto("activity").values({
    id, public_code: publicCode, title: "春日声场", status, revision: 1,
    enabled_capabilities: JSON.stringify(["publishing"]), active_definition_version: 1,
  }).execute();
  return { id, publicCode };
}
function input(activityId: string) {
  return {
    commandId: randomUUID(), activityId, expectedRevision: 0,
    tagline: "春日", description: "介绍", venue: "剧场",
    startsAt: null, endsAt: null, organizer: "学生会", contact: "联系", announcement: "公告",
  };
}

describe.skipIf(!connectionString)("public event site read model", () => {
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

  it("returns null for draft and archived activities", async () => {
    const draft = await seed("draft");
    expect(await getPublicEventSite(db, draft.publicCode)).toBeNull();
    const archived = await seed("archived");
    expect(await getPublicEventSite(db, archived.publicCode)).toBeNull();
  });

  it("composes the profile without internal ids", async () => {
    const activity = await seed("active");
    await updateActivityPublicProfile(db, deps(), input(activity.id));
    const site = await getPublicEventSite(db, activity.publicCode);
    expect(site?.profile.tagline).toBe("春日");
    expect(site?.activity.publicCode).toBe(activity.publicCode);
    expect(JSON.stringify(site)).not.toContain(activity.id);
  });

  it("returns default profile and null sections when nothing is published", async () => {
    const activity = await seed("active");
    const site = await getPublicEventSite(db, activity.publicCode);
    expect(site?.profile.tagline).toBe("");
    expect(site?.results).toBeNull();
  });

  it("restores the public event after unarchive", async () => {
    const activity = await seed("archived");
    expect(await getPublicEventSite(db, activity.publicCode)).toBeNull();
    await db.updateTable("activity").set({ status: "closed" }).where("id", "=", activity.id).execute();
    expect(await getPublicEventSite(db, activity.publicCode)).not.toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm --filter @artflow-plus/runtime test -- public-event-service
```

Expected：FAIL，模块不存在。

- [ ] **Step 3: 写聚合读**

```ts
import type { Database } from "@artflow-plus/db";
import {
  getActivityPublicProfile,
  selectPublicResults,
} from "@artflow-plus/db";
import type { Kysely } from "kysely";

import { getPublicSchedule } from "./schedule-service.js";
import {
  getPublicActivity,
  getPublicProgram,
} from "./registration-read-service.js";

export interface PublicEventSite {
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "active" | "closed";
    readonly registrationEnabled: boolean;
    readonly registrationOpen: boolean;
  };
  readonly profile: {
    readonly tagline: string;
    readonly description: string;
    readonly venue: string;
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly organizer: string;
    readonly contact: string;
    readonly announcement: string;
  };
  readonly schedule: {
    readonly entries: readonly {
      readonly order: number;
      readonly slotLabel: string;
      readonly title: string;
      readonly note: string;
      readonly startsAt: string | null;
    }[];
  } | null;
  readonly program: {
    readonly entries: readonly {
      readonly order: number;
      readonly name: string;
      readonly song: string;
      readonly note: string;
      readonly startsAt: string | null;
    }[];
  } | null;
  readonly results: {
    readonly activityTitle: string;
    readonly results: readonly {
      readonly stageKey: string;
      readonly publicTitle: string;
      readonly releasedAt: string;
      readonly decisions: readonly {
        readonly rank: number;
        readonly contestantName: string;
        readonly score: string;
        readonly unit?: "score" | "percent";
      }[];
      readonly awards: readonly { readonly award: string; readonly contestantName: string }[];
    }[];
  } | null;
}

export async function getPublicEventSite(
  db: Kysely<Database>,
  publicCode: string,
): Promise<PublicEventSite | null> {
  const activity = await getPublicActivity(db, publicCode);
  if (activity === null) return null;
  const status = activity.status === "active" || activity.status === "closed" ? activity.status : null;
  if (status === null) return null;
  const [profile, schedule, program, results] = await Promise.all([
    getActivityPublicProfile(db, activity.id),
    getPublicSchedule(db, publicCode),
    getPublicProgram(db, publicCode),
    selectPublicResults(db, publicCode),
  ]);
  return {
    activity: {
      publicCode: activity.publicCode,
      title: activity.title,
      status,
      registrationEnabled: activity.registrationEnabled,
      registrationOpen: activity.registrationOpen,
    },
    profile: {
      tagline: profile.tagline,
      description: profile.description,
      venue: profile.venue,
      startsAt: profile.startsAt,
      endsAt: profile.endsAt,
      organizer: profile.organizer,
      contact: profile.contact,
      announcement: profile.announcement,
    },
    schedule: schedule === null ? null : {
      entries: schedule.entries.map((entry) => ({
        order: entry.order,
        slotLabel: entry.slotLabel,
        title: entry.title,
        note: entry.note,
        startsAt: entry.startsAt ?? null,
      })),
    },
    program: program === null ? null : {
      entries: program.entries.map((entry) => ({
        order: entry.order,
        name: entry.name,
        song: entry.song,
        note: entry.note,
        startsAt: entry.startsAt ?? null,
      })),
    },
    results: results === null ? null : {
      activityTitle: results.activityTitle,
      results: results.results.map((result) => ({
        stageKey: result.stageKey,
        publicTitle: result.publicTitle,
        releasedAt: result.releasedAt,
        decisions: result.decisions.map((decision) => ({
          rank: decision.rank,
          contestantName: decision.contestantName,
          score: decision.score,
          ...(decision.unit === undefined ? {} : { unit: decision.unit }),
        })),
        awards: result.awards.map((award) => ({
          award: award.award,
          contestantName: award.contestantName,
        })),
      })),
    },
  };
}
```

`activity.status` 在第 2 行后已收窄为 `"active" | "closed"`；TypeScript 需要显式窄化，若报错用：

```ts
const status = activity.status === "active" || activity.status === "closed" ? activity.status : null;
if (status === null) return null;
```

- [ ] **Step 4: 导出聚合读**

`plus/packages/runtime/src/index.ts` 增加：

```ts
export * from "./public-event-service.js";
```

- [ ] **Step 5: 写 API 测试**

在 `apps/api/test/public-event.test.ts` 按 `public-vote.test.ts` 的 `buildApp` setup，seed 一个 `active`/`closed` 活动与公开资料，然后：

```ts
const ok = await app.inject({ method: "GET", url: "/api/public/events/SITE-1" });
expect(ok.statusCode).toBe(200);
expect(ok.json()).toMatchObject({ activity: { publicCode: "SITE-1" } });
expect(ok.body).not.toContain("act-");
const missing = await app.inject({ method: "GET", url: "/api/public/events/NOPE" });
expect(missing.statusCode).toBe(404);
```

- [ ] **Step 6: 增加 API 路由**

在 `routes/public.ts` 的 `registerPublicRoutes` 内：

```ts
app.get(
  "/api/public/events/:publicCode",
  { schema: { params: PublicActivityParams }, config: { access: "public" } },
  async (request, reply) => {
    const { publicCode } = request.params as { publicCode: string };
    await requirePublicRateLimit(request, `public-event:${publicCode}`, 120);
    const site = await getPublicEventSite(db, publicCode);
    reply.header("cache-control", "no-store");
    if (site === null) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "The public event was not found." });
    }
    return site;
  },
);
```

在 `public.ts` 的 runtime import 中加入 `getPublicEventSite`。

- [ ] **Step 7: 运行测试**

```powershell
pnpm --filter @artflow-plus/runtime test -- public-event-service
pnpm --filter @artflow-plus/api test -- public-event
```

Expected：PASS。

- [ ] **Step 8: 提交**

```bash
git add plus/packages/runtime plus/apps/api
git commit -m "feat(api): expose the public event site read model"
```

---

## Task 6: Studio 公开资料读与更新路由

**Files:**
- Modify: `plus/packages/runtime/src/studio-service.ts`
- Modify: `plus/apps/api/src/http/schemas.ts`
- Modify: `plus/apps/api/src/routes/activity.ts`
- Modify: `plus/apps/web/src/api/studio.ts`
- Test: `plus/apps/api/test/studio.test.ts`

- [ ] **Step 1: 扩展 `StudioState`**

`studio-service.ts` 的 `StudioState` 增加：

```ts
readonly publicProfile: StoredActivityPublicProfile;
```

`getStudioState` 返回：

```ts
const publicProfile = await getActivityPublicProfile(db, activityId);
return { ..., publicProfile };
```

import `getActivityPublicProfile` 与 `StoredActivityPublicProfile`。

- [ ] **Step 2: 写 API 失败测试**

在 `apps/api/test/studio.test.ts` 增加（沿用该文件的登录/session helper）：

```ts
const state = await app.inject({ method: "GET", url: `/api/activities/${activityId}/studio`, headers: studioAuth });
expect(state.json().publicProfile).toMatchObject({ revision: 0, tagline: "" });

const created = await app.inject({
  method: "POST",
  url: `/api/activities/${activityId}/public-profile`,
  headers: { ...studioAuth, "idempotency-key": "profile-1", "content-type": "application/json" },
  payload: {
    expectedRevision: 0, tagline: "春日声场", description: "介绍", venue: "剧场",
    startsAt: "2026-04-18T11:00:00.000Z", endsAt: "2026-04-18T13:30:00.000Z",
    organizer: "学生会", contact: "联系", announcement: "公告",
  },
});
expect(created.statusCode).toBe(200);
expect(created.json()).toMatchObject({ tagline: "春日声场", revision: 1 });
```

- [ ] **Step 3: 运行测试确认失败**

```powershell
pnpm --filter @artflow-plus/api test -- studio
```

Expected：FAIL，`publicProfile` 不存在 / 404。

- [ ] **Step 4: 增加 body schema**

`http/schemas.ts`：

```ts
export const UpdatePublicProfileBody = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    tagline: Type.String({ maxLength: 160 }),
    description: Type.String({ maxLength: 4000 }),
    venue: Type.String({ maxLength: 200 }),
    startsAt: Type.Union([Type.String({ minLength: 1, maxLength: 40 }), Type.Null()]),
    endsAt: Type.Union([Type.String({ minLength: 1, maxLength: 40 }), Type.Null()]),
    organizer: Type.String({ maxLength: 200 }),
    contact: Type.String({ maxLength: 200 }),
    announcement: Type.String({ maxLength: 2000 }),
  },
  { additionalProperties: false },
);
```

- [ ] **Step 5: 增加 POST 路由**

`routes/activity.ts`：

```ts
app.post(
  "/api/activities/:id/public-profile",
  { schema: { params: ActivityParams, body: UpdatePublicProfileBody } },
  async (request, reply) => {
    const commandId = requireIdempotency(request);
    const { id } = request.params as { id: string };
    const body = request.body as {
      expectedRevision: number;
      tagline: string;
      description: string;
      venue: string;
      startsAt: string | null;
      endsAt: string | null;
      organizer: string;
      contact: string;
      announcement: string;
    };
    const outcome = await updateActivityPublicProfile(db, await requestDeps(request), {
      commandId,
      activityId: id,
      ...body,
    });
    return reply.status(outcome.status).send(outcome.body);
  },
);
```

import `UpdatePublicProfileBody` 与 `updateActivityPublicProfile`。

- [ ] **Step 6: 扩展 Web `StudioState` 与保存函数**

`plus/apps/web/src/api/studio.ts`：

```ts
export interface StudioPublicProfile {
  readonly activityId: string;
  readonly tagline: string;
  readonly description: string;
  readonly venue: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly organizer: string;
  readonly contact: string;
  readonly announcement: string;
  readonly revision: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface StudioState {
  // existing fields
  readonly publicProfile: StudioPublicProfile;
}

export async function savePublicProfile(
  activityId: string,
  input: {
    readonly expectedRevision: number;
    readonly tagline: string;
    readonly description: string;
    readonly venue: string;
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly organizer: string;
    readonly contact: string;
    readonly announcement: string;
  },
): Promise<StudioPublicProfile> {
  return apiFetch(`/api/activities/${activityId}/public-profile`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}
```

- [ ] **Step 7: 运行测试**

```powershell
pnpm --filter @artflow-plus/api test -- studio
pnpm --filter @artflow-plus/web test -- studio
```

Expected：PASS。

- [ ] **Step 8: 提交**

```bash
git add plus/packages/runtime plus/apps/api plus/apps/web/src/api/studio.ts
git commit -m "feat(studio): expose the public profile editor API"
```

---

## Task 7: `/e/$publicCode` 公开活动站

**Files:**
- Create: `plus/apps/web/src/api/publicEvent.ts`
- Create: `plus/apps/web/src/components/portal/EventHero.tsx`
- Create: `plus/apps/web/src/components/portal/EventAbout.tsx`
- Create: `plus/apps/web/src/components/portal/EventProgram.tsx`
- Create: `plus/apps/web/src/components/portal/EventResults.tsx`
- Create: `plus/apps/web/src/components/portal/EventShare.tsx`
- Create: `plus/apps/web/src/routes/publicEvent.tsx`
- Create: `plus/apps/web/src/styles/portal-event.css`
- Modify: `plus/apps/web/src/styles/global.css`
- Modify: `plus/apps/web/src/router.tsx`
- Modify: `plus/apps/web/src/components/shell/PortalShell.tsx`
- Test: `plus/apps/web/src/routes/publicEvent.test.tsx`

- [ ] **Step 1: 写页面测试**

`publicEvent.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({
  useParams: useParamsMock,
  Link: ({ children }: { readonly children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../api/publicEvent.js", () => ({
  fetchPublicEvent: vi.fn(),
  PublicEventNotFound: class PublicEventNotFound extends Error {},
}));

import { PublicEventNotFound } from "../api/publicEvent.js";
import { PublicEventPage } from "./publicEvent.js";

const site = {
  activity: { publicCode: "SPRING-1", title: "春日声场", status: "active" as const, registrationEnabled: true, registrationOpen: true },
  profile: { tagline: "春日", description: "介绍", venue: "剧场", startsAt: "2026-04-18T11:00:00.000Z", endsAt: null, organizer: "学生会", contact: "联系", announcement: "公告" },
  schedule: { entries: [{ order: 1, slotLabel: "开场", title: "开场舞", note: "", startsAt: "2026-04-18T11:00:00.000Z" }] },
  program: null,
  results: { activityTitle: "春日声场", results: [{ stageKey: "final", publicTitle: "正式赛果", releasedAt: "2026-04-18T13:00:00.000Z", decisions: [{ rank: 1, contestantName: "林晓", score: "98.30" }], awards: [] }] },
};

describe("PublicEventPage", () => {
  beforeEach(() => useParamsMock.mockReturnValue({ publicCode: "SPRING-1" }));

  it("renders the event home", () => {
    useQueryMock.mockReturnValue({ data: site, error: null, isPending: false });
    render(<PublicEventPage />);
    expect(screen.getByRole("heading", { name: "春日声场" })).toBeInTheDocument();
    expect(screen.getByText("关于本次活动")).toBeInTheDocument();
    expect(screen.getByText("开场舞")).toBeInTheDocument();
    expect(screen.getByText("林晓")).toBeInTheDocument();
  });

  it("shows the not-found state", () => {
    useQueryMock.mockReturnValue({ data: undefined, error: new PublicEventNotFound("SPRING-1"), isPending: false });
    render(<PublicEventPage />);
    expect(screen.getByText("活动不存在或尚未公开")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm --filter @artflow-plus/web test -- publicEvent
```

Expected：FAIL，模块不存在。

- [ ] **Step 3: 写 API 客户端**

```ts
export interface PublicEventSite {
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "active" | "closed";
    readonly registrationEnabled: boolean;
    readonly registrationOpen: boolean;
  };
  readonly profile: {
    readonly tagline: string;
    readonly description: string;
    readonly venue: string;
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly organizer: string;
    readonly contact: string;
    readonly announcement: string;
  };
  readonly schedule: { readonly entries: readonly { readonly order: number; readonly slotLabel: string; readonly title: string; readonly note: string; readonly startsAt: string | null }[] } | null;
  readonly program: { readonly entries: readonly { readonly order: number; readonly name: string; readonly song: string; readonly note: string; readonly startsAt: string | null }[] } | null;
  readonly results: { readonly activityTitle: string; readonly results: readonly { readonly stageKey: string; readonly publicTitle: string; readonly releasedAt: string; readonly decisions: readonly { readonly rank: number; readonly contestantName: string; readonly score: string; readonly unit?: "score" | "percent" }[]; readonly awards: readonly { readonly award: string; readonly contestantName: string }[] }[] } | null;
}

export class PublicEventNotFound extends Error {
  constructor(publicCode: string) {
    super(`No public event for ${publicCode}`);
    this.name = "PublicEventNotFound";
  }
}

export async function fetchPublicEvent(publicCode: string, signal?: AbortSignal): Promise<PublicEventSite> {
  const response = await fetch(`/api/public/events/${encodeURIComponent(publicCode)}`, {
    signal, headers: { accept: "application/json" },
  });
  if (response.status === 404) throw new PublicEventNotFound(publicCode);
  if (!response.ok) throw new Error(`加载活动失败（${response.status}）`);
  return (await response.json()) as PublicEventSite;
}
```

- [ ] **Step 3b: 更新 `/program` 与公开节目单类型**

`api/public-results.ts`：

```ts
export interface PublicProgramEntry {
  readonly order: number;
  readonly participantId: string;
  readonly name: string;
  readonly song: string;
  readonly note: string;
  readonly startsAt: string | null;
}

export class PublicProgramNotFound extends Error {
  constructor(publicCode: string) {
    super(`No public program for ${publicCode}`);
    this.name = "PublicProgramNotFound";
  }
}

export async function fetchPublicProgram(publicCode: string, signal?: AbortSignal): Promise<PublicProgram> {
  const response = await fetch(`/api/public/programs/${encodeURIComponent(publicCode)}`, {
    signal, headers: { accept: "application/json" },
  });
  if (response.status === 404) throw new PublicProgramNotFound(publicCode);
  if (!response.ok) throw new Error(`加载节目单失败（${response.status}）`);
  return (await response.json()) as PublicProgram;
}
```

`program.tsx` 的错误分支与列表：

```tsx
import { PublicProgramNotFound } from "../api/public-results.js";

if (query.error instanceof PublicProgramNotFound) {
  return (
    <section className="console-state">
      <p className="eyebrow">PROGRAM · 节目单</p>
      <h1 className="console-page-title">节目单未发布或已撤回</h1>
      <p className="state-copy">主办方尚未发布节目单，或最新版本已撤回。</p>
    </section>
  );
}
if (query.error !== null) return <p className="console-state form-error" role="alert">节目单暂时无法加载。</p>;
```

列表条目增加时间：

```tsx
{entry.startsAt === null ? null : (
  <time dateTime={entry.startsAt}>
    {new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.startsAt))}
  </time>
)}
```

底部增加回链：

```tsx
<Link className="table-link" to="/e/$publicCode" params={{ publicCode }}>
  返回活动主页
</Link>
```

- [ ] **Step 3c: 给 `/results` 与 `/join` 加回链**

`results.tsx` 在现有节目单链接旁加入：

```tsx
<Link className="table-link" to="/e/$publicCode" params={{ publicCode }}>
  返回活动主页
</Link>
```

`joinActivity.tsx` 在 `<RegistrationForm ... />` 之后加入（并在 import 中加入 `Link`）：

```tsx
<p className="state-copy">
  <Link className="table-link" to="/e/$publicCode" params={{ publicCode }}>
    返回活动主页
  </Link>
</p>
```

- [ ] **Step 4: 写组件**

`EventHero.tsx`（presentational）：

```tsx
import { Link } from "@tanstack/react-router";

export function formatEventTime(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "long", timeStyle: "short" }).format(date);
}

export interface EventHeroProps {
  readonly publicCode: string;
  readonly title: string;
  readonly status: "active" | "closed";
  readonly tagline: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly venue: string;
  readonly organizer: string;
  readonly registrationEnabled: boolean;
  readonly registrationOpen: boolean;
  readonly resultsAvailable: boolean;
  readonly preview?: boolean;
}

export function EventHero(props: EventHeroProps) {
  const time = [formatEventTime(props.startsAt), formatEventTime(props.endsAt)].filter(Boolean).join(" – ");
  const meta = [time, props.venue, props.organizer].filter(Boolean);
  const showResults = props.status === "closed" && props.resultsAvailable && props.preview !== true;
  const showJoin = props.status !== "closed" && props.registrationOpen && props.preview !== true;
  const mutedLabel = props.status === "closed"
    ? null
    : props.registrationOpen
      ? null
      : props.registrationEnabled
        ? "报名已截止"
        : "本活动无需报名";
  const showMuted = props.preview !== true && mutedLabel !== null;
  return (
    <header className="event-hero">
      <p className="eyebrow">EVENT · {props.status === "closed" ? "已结束" : "活动"}</p>
      <h1 className="event-hero__title">{props.title}</h1>
      {props.tagline === "" ? null : <p className="event-hero__tagline">{props.tagline}</p>}
      {meta.length === 0 ? null : <p className="event-hero__meta">{meta.join(" · ")}</p>}
      <div className="event-hero__actions">
        {showResults ? (
          <Link className="event-button event-button--primary" to="/results/$publicCode" params={{ publicCode: props.publicCode }}>
            查看赛果
          </Link>
        ) : null}
        {showJoin ? (
          <Link className="event-button event-button--primary" to="/join/$publicCode" params={{ publicCode: props.publicCode }}>
            立即报名
          </Link>
        ) : null}
        {showMuted ? (
          <span className="event-button event-button--muted">{mutedLabel}</span>
        ) : null}
      </div>
    </header>
  );
}
```

`EventAbout.tsx`：

```tsx
export function EventAbout({ description }: { readonly description: string }) {
  if (description.trim() === "") return null;
  return (
    <section className="event-section" id="about" aria-labelledby="event-about-title">
      <h2 className="event-section__title" id="event-about-title">关于本次活动</h2>
      <p className="event-about__copy">{description}</p>
    </section>
  );
}
```

`EventProgram.tsx`：

```tsx
import { useState } from "react";
import type { PublicEventSite } from "../../api/publicEvent.js";

function formatEntryTime(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function EventProgram({ site }: { readonly site: PublicEventSite }) {
  const [hostMode, setHostMode] = useState(false);
  const schedule = site.schedule;
  const program = site.program;
  if (schedule === null && (program === null || program.entries.length === 0)) return null;
  return (
    <section className="event-section" id="program" aria-labelledby="event-program-title">
      <div className="event-section__head">
        <h2 className="event-section__title" id="event-program-title">节目单</h2>
        <div className="event-section__actions">
          <label className="event-toggle">
            <input type="checkbox" checked={hostMode} onChange={(event) => setHostMode(event.target.checked)} />
            主持大字
          </label>
          <button type="button" className="event-button event-button--ghost" onClick={() => window.print()}>打印</button>
        </div>
      </div>
      <ol className={hostMode ? "event-program event-program--host" : "event-program"}>
        {schedule !== null
          ? schedule.entries.map((entry) => (
              <li className="event-program__row" key={`${entry.order}-${entry.title}`}>
                <span className="event-program__time">{formatEntryTime(entry.startsAt) || entry.slotLabel}</span>
                <span className="event-program__title">{entry.title}</span>
                {entry.note === "" ? null : <span className="event-program__note">{entry.note}</span>}
              </li>
            ))
          : program?.entries.map((entry) => (
              <li className="event-program__row" key={`${entry.order}-${entry.name}`}>
                <span className="event-program__title">{entry.name}</span>
                {entry.song === "" ? null : <span className="event-program__note">{entry.song}</span>}
                {entry.note === "" ? null : <span className="event-program__note">{entry.note}</span>}
              </li>
            ))}
      </ol>
    </section>
  );
}
```

`EventResults.tsx`：

```tsx
import { Link } from "@tanstack/react-router";
import type { PublicEventSite } from "../../api/publicEvent.js";

export function EventResults({ site }: { readonly site: PublicEventSite }) {
  const results = site.results;
  if (results === null || results.results.length === 0) return null;
  const latest = [...results.results].sort((left, right) =>
    right.releasedAt.localeCompare(left.releasedAt) || left.stageKey.localeCompare(right.stageKey),
  )[0];
  if (latest === undefined) return null;
  return (
    <section className="event-section" id="results" aria-labelledby="event-results-title">
      <div className="event-section__head">
        <h2 className="event-section__title" id="event-results-title">赛果</h2>
        <Link className="event-link" to="/results/$publicCode" params={{ publicCode: site.activity.publicCode }}>
          查看完整赛果 →
        </Link>
      </div>
      <p className="event-results__stage">{latest.publicTitle}</p>
      <ol className="event-results__list">
        {latest.decisions.slice(0, 3).map((decision) => (
          <li key={`${decision.rank}-${decision.contestantName}`}>
            <span className="event-results__rank">{String(decision.rank).padStart(2, "0")}</span>
            <span>{decision.contestantName}</span>
            <span className="event-results__score">{decision.unit === "percent" ? `${decision.score}%` : decision.score}</span>
          </li>
        ))}
      </ol>
      {latest.awards.length === 0 ? null : (
        <ul className="event-results__awards">
          {latest.awards.map((award) => (
            <li key={`${award.award}-${award.contestantName}`}>
              <span>{award.award}</span>
              <strong>{award.contestantName}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

`EventShare.tsx`：

```tsx
import { useState } from "react";

export function EventShare({ title }: { readonly title: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  async function share(): Promise<void> {
    const url = window.location.href;
    try {
      if (navigator.share !== undefined) {
        await navigator.share({ title, url });
      } else {
        await navigator.clipboard.writeText(url);
        setStatus("copied");
        window.setTimeout(() => setStatus("idle"), 2000);
      }
    } catch {
      setStatus("error");
      window.setTimeout(() => setStatus("idle"), 2000);
    }
  }
  return (
    <>
      <button type="button" className="event-button event-button--ghost" onClick={() => void share()}>
        分享
      </button>
      <span className="event-share-status" role="status">
        {status === "copied" ? "链接已复制" : status === "error" ? "复制失败，请手动复制地址" : ""}
      </span>
    </>
  );
}
```

- [ ] **Step 5: 写页面**

```tsx
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { fetchPublicEvent, PublicEventNotFound } from "../api/publicEvent.js";
import { EventAbout } from "../components/portal/EventAbout.js";
import { EventHero } from "../components/portal/EventHero.js";
import { EventProgram } from "../components/portal/EventProgram.js";
import { EventResults } from "../components/portal/EventResults.js";
import { EventShare } from "../components/portal/EventShare.js";

export function PublicEventPage() {
  const { publicCode } = useParams({ from: "/e/$publicCode" });
  const query = useQuery({
    queryKey: ["public-event", publicCode],
    queryFn: ({ signal }) => fetchPublicEvent(publicCode, signal),
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    document.title = query.data === undefined ? `活动 · ${publicCode}` : `${query.data.activity.title} · 活动主页`;
    if (query.data === undefined) return;
    const meta = document.querySelector('meta[name="description"]')
      ?? (() => {
        const element = document.createElement("meta");
        element.setAttribute("name", "description");
        document.head.appendChild(element);
        return element;
      })();
    meta.setAttribute("content", query.data.profile.description.slice(0, 160));
  }, [publicCode, query.data]);

  if (query.isPending) return <p className="event-state">正在加载活动…</p>;
  if (query.error instanceof PublicEventNotFound) {
    return (
      <section className="event-state">
        <p className="eyebrow">EVENT</p>
        <h1 className="event-state__title">活动不存在或尚未公开</h1>
        <p className="event-state__copy">请确认公开码，或联系活动主办方。</p>
      </section>
    );
  }
  if (query.error !== null) {
    return (
      <section className="event-state">
        <h1 className="event-state__title">活动暂时无法加载</h1>
        <button type="button" className="event-button event-button--primary" onClick={() => void query.refetch()}>重试</button>
      </section>
    );
  }
  const site = query.data;
  if (site === undefined) return null;
  const hasAbout = site.profile.description.trim() !== "";
  const hasProgram = site.schedule !== null || (site.program !== null && site.program.entries.length > 0);
  const hasResults = site.results !== null && site.results.results.length > 0;
  return (
    <article className="event-page">
      <EventHero
        publicCode={site.activity.publicCode}
        title={site.activity.title}
        status={site.activity.status}
        tagline={site.profile.tagline}
        startsAt={site.profile.startsAt}
        endsAt={site.profile.endsAt}
        venue={site.profile.venue}
        organizer={site.profile.organizer}
        registrationEnabled={site.activity.registrationEnabled}
        registrationOpen={site.activity.registrationOpen}
        resultsAvailable={hasResults}
      />
      {site.profile.announcement.trim() === "" ? null : (
        <p className="event-announcement" role="note">{site.profile.announcement}</p>
      )}
      <nav className="event-anchor-nav" aria-label="活动导航">
        {hasAbout ? <a href="#about">概览</a> : null}
        {hasProgram ? <a href="#program">节目单</a> : null}
        {hasResults ? <a href="#results">赛果</a> : null}
      </nav>
      <EventAbout description={site.profile.description} />
      <EventProgram site={site} />
      <EventResults site={site} />
      <footer className="event-footer">
        <span>{site.profile.organizer || "主办方"}</span>
        {site.profile.contact === "" ? null : <span>{site.profile.contact}</span>}
        <span>公开码 {site.activity.publicCode}</span>
        <EventShare title={site.activity.title} />
      </footer>
    </article>
  );
}
```

- [ ] **Step 6: 写 CSS**

`portal-event.css` 至少覆盖：

```css
.event-page { max-width: 1180px; margin: 0 auto; padding: 48px 24px 72px; }
.event-hero { padding: 48px 0 32px; border-bottom: 1px solid var(--line); }
.event-hero__title { margin: 0; font-family: var(--display); font-size: clamp(2.8rem, 7vw, 5.6rem); line-height: 1.02; }
.event-hero__tagline { max-width: 42ch; margin: 16px 0 0; color: var(--bone-dim); font-size: 1.1rem; }
.event-hero__meta { margin: 16px 0 0; color: var(--bone-subtle); font-size: 0.9rem; }
.event-hero__actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 24px; }
.event-button { display: inline-flex; align-items: center; min-height: 40px; padding: 0 18px; border-radius: 6px; border: 1px solid var(--line-strong); color: inherit; text-decoration: none; }
.event-button--primary { background: var(--gold); color: #1a1408; border-color: var(--gold); font-weight: 700; }
.event-button--ghost { background: transparent; }
.event-button--muted { color: var(--bone-subtle); }
.event-announcement { margin: 24px 0 0; padding: 14px 18px; border-left: 2px solid var(--gold); background: rgba(201,168,106,.08); }
.event-anchor-nav { display: flex; flex-wrap: wrap; gap: 20px; padding: 18px 0; border-bottom: 1px solid var(--line); }
.event-anchor-nav a { color: var(--bone-dim); text-decoration: none; font-size: 0.8rem; letter-spacing: .16em; text-transform: uppercase; }
.event-section { padding: 40px 0; border-bottom: 1px solid var(--line); scroll-margin-top: 24px; }
.event-section__head { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; }
.event-section__title { margin: 0 0 18px; font-size: 1.3rem; }
.event-section__actions { display: flex; gap: 12px; align-items: center; }
.event-program { margin: 0; padding: 0; list-style: none; }
.event-program__row { display: grid; grid-template-columns: 130px 1fr; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.event-program__time { color: var(--gold); font-variant-numeric: tabular-nums; }
.event-program__note { grid-column: 2; color: var(--bone-subtle); font-size: 0.9rem; }
.event-program--host .event-program__title { font-size: 1.6rem; }
.event-results__list { margin: 0; padding: 0; list-style: none; }
.event-results__list li { display: grid; grid-template-columns: 48px 1fr auto; gap: 12px; padding: 10px 0; }
.event-results__rank { color: var(--gold); font-variant-numeric: tabular-nums; }
.event-results__score { font-variant-numeric: tabular-nums; }
.event-footer { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 28px 0 0; color: var(--bone-subtle); font-size: 0.8rem; }
.event-share-status { color: var(--bone-subtle); font-size: 0.8rem; }
.event-state { max-width: 720px; margin: 0 auto; padding: 96px 24px; text-align: center; }
@media (max-width: 720px) {
  .event-page { padding: 24px 16px 56px; }
  .event-program__row { grid-template-columns: 1fr; gap: 4px; }
  .event-program__note { grid-column: 1; }
  .event-anchor-nav { gap: 14px; overflow-x: auto; }
}
@media print {
  .event-page { max-width: none; padding: 0; color: #000; background: #fff; }
  .event-hero__actions, .event-anchor-nav, .event-section__actions, .event-footer .event-button, .event-share-status { display: none; }
  .event-hero__title, .event-hero__tagline, .event-hero__meta, .event-program__title, .event-program__note { color: #000; }
  .event-section { break-inside: avoid; }
}
```

在 `global.css` 的 `portal.css` 后加入：

```css
@import "./portal-event.css";
```

- [ ] **Step 7: 注册路由与 Portal 壳**

`router.tsx`：

```tsx
const publicEventRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/e/$publicCode",
  component: lazyRouteComponent(() => import("./routes/publicEvent.js"), "PublicEventPage"),
});
```

加入 `routeTree.addChildren([...])`。

`PortalShell.tsx`：

```tsx
const isEventPage = pathname.startsWith("/e/");
const subtitle = isEventPage ? "活动主页" : "赛果公示";
const showStaticBackdrop = pathname.startsWith("/vote/") || isEventPage;
```

把品牌副标题 `赛果公示` 替换为 `{subtitle}`。

- [ ] **Step 8: 写页面单测**

用 `vi.stubGlobal("fetch", ...)` 返回一个 `PublicEventSite`，断言：

```tsx
expect(await screen.findByRole("heading", { name: "春日声场" })).toBeInTheDocument();
expect(screen.getByText("关于本次活动")).toBeInTheDocument();
expect(screen.getByText("开场舞")).toBeInTheDocument();
expect(screen.getByText("林晓")).toBeInTheDocument();
```

再 mock 404，断言“活动不存在或尚未公开”。

- [ ] **Step 9: 运行测试**

```powershell
pnpm --filter @artflow-plus/web test -- publicEvent
pnpm --filter @artflow-plus/web run check
```

Expected：PASS。

- [ ] **Step 10: 提交**

```bash
git add plus/apps/web/src
git commit -m "feat(web): add the public event site page"
```

---

## Task 8: `/studio/$activityId/public` 公开资料编辑器

**Files:**
- Create: `plus/apps/web/src/routes/studioPublicProfile.tsx`
- Create: `plus/apps/web/src/components/studio/PublicProfileEditor.tsx`
- Modify: `plus/apps/web/src/router.tsx`
- Modify: `plus/apps/web/src/routes/studioActivity.tsx`
- Modify: `plus/apps/web/src/components/workspace/WorkspaceActivityCard.tsx`
- Test: `plus/apps/web/src/routes/studioPublicProfile.test.tsx`

- [ ] **Step 1: 写失败测试**

Mock `fetchStudioState` 返回 `publicProfile`，断言表单预填、保存调用、`STALE_REVISION` 提示。参考 `studioActivity.test.tsx` 的 mock 方式。

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm --filter @artflow-plus/web test -- studioPublicProfile
```

Expected：FAIL，模块不存在。

- [ ] **Step 3: 写编辑器组件**

```tsx
import { useState } from "react";
import type { StudioPublicProfile } from "../../api/studio.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Input.js";
import { Textarea } from "../ui/Textarea.js";

export interface PublicProfileDraft {
  readonly tagline: string;
  readonly description: string;
  readonly venue: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly organizer: string;
  readonly contact: string;
  readonly announcement: string;
}

export function toDraft(profile: StudioPublicProfile): PublicProfileDraft {
  return {
    tagline: profile.tagline,
    description: profile.description,
    venue: profile.venue,
    startsAt: profile.startsAt === null ? "" : toLocalInput(profile.startsAt),
    endsAt: profile.endsAt === null ? "" : toLocalInput(profile.endsAt),
    organizer: profile.organizer,
    contact: profile.contact,
    announcement: profile.announcement,
  };
}

function toLocalInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  return value === "" ? null : new Date(value).toISOString();
}

export function PublicProfileEditor({
  draft,
  onChange,
  disabled,
}: {
  readonly draft: PublicProfileDraft;
  readonly onChange: (next: PublicProfileDraft) => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="editor-grid">
      <Input label="标语" value={draft.tagline} disabled={disabled} onChange={(e) => onChange({ ...draft, tagline: e.target.value })} />
      <Input label="地点" value={draft.venue} disabled={disabled} onChange={(e) => onChange({ ...draft, venue: e.target.value })} />
      <Input label="开始时间" type="datetime-local" value={draft.startsAt} disabled={disabled} onChange={(e) => onChange({ ...draft, startsAt: e.target.value })} />
      <Input label="结束时间" type="datetime-local" value={draft.endsAt} disabled={disabled} onChange={(e) => onChange({ ...draft, endsAt: e.target.value })} />
      <Input label="主办方" value={draft.organizer} disabled={disabled} onChange={(e) => onChange({ ...draft, organizer: e.target.value })} />
      <Input label="联系方式" value={draft.contact} disabled={disabled} onChange={(e) => onChange({ ...draft, contact: e.target.value })} />
      <Textarea label="介绍" value={draft.description} disabled={disabled} onChange={(e) => onChange({ ...draft, description: e.target.value })} />
      <Textarea label="公告" value={draft.announcement} disabled={disabled} onChange={(e) => onChange({ ...draft, announcement: e.target.value })} />
    </div>
  );
}
```

- [ ] **Step 4: 写页面**

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { fetchStudioState, savePublicProfile } from "../api/studio.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasStudioAccess, useSession } from "../auth/SessionProvider.js";
import { EventAbout } from "../components/portal/EventAbout.js";
import { EventHero } from "../components/portal/EventHero.js";
import { PublicProfileEditor, fromLocalInput, toDraft, type PublicProfileDraft } from "../components/studio/PublicProfileEditor.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { apiErrorText } from "../components/ui/apiError.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";

export function StudioPublicProfilePage() {
  return <RequireSession><StudioPublicProfileContent /></RequireSession>;
}

function StudioPublicProfileContent() {
  const { activityId } = useParams({ from: "/studio/$activityId/public" });
  const { session } = useSession();
  const allowed = hasStudioAccess(session);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["studio-state", activityId],
    queryFn: () => fetchStudioState(activityId),
    enabled: allowed,
    retry: false,
  });
  const [draft, setDraft] = useState<PublicProfileDraft | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.data === undefined) return;
    setDraft(toDraft(query.data.publicProfile));
    setRevision(query.data.publicProfile.revision);
  }, [query.data]);

  async function save(): Promise<void> {
    if (draft === null || query.data === undefined) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await savePublicProfile(activityId, {
        expectedRevision: revision,
        tagline: draft.tagline,
        description: draft.description,
        venue: draft.venue,
        startsAt: fromLocalInput(draft.startsAt),
        endsAt: fromLocalInput(draft.endsAt),
        organizer: draft.organizer,
        contact: draft.contact,
        announcement: draft.announcement,
      });
      setRevision(saved.revision);
      setMessage("已保存");
      void queryClient.invalidateQueries({ queryKey: ["studio-state", activityId] });
    } catch (caught) {
      setError(apiErrorText(caught, "保存失败，请稍后重试。", "公开资料已被其他操作更新，请刷新后重试。"));
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) return <EmptyState title="没有 Studio 权限" description="当前账号缺少 studio.manage。" />;
  if (query.isPending) return <p className="auth-loading">正在加载公开资料…</p>;
  if (query.error !== null) return <ErrorState description="公开资料暂时无法加载。" onRetry={() => void query.refetch()} />;
  const state = query.data;
  if (state === undefined || draft === null) return null;
  const readOnly = state.activity.status === "archived";
  return (
    <section className="studio-page">
      <header className="studio-header">
        <div>
          <Link to="/studio/$activityId" params={{ activityId }} className="table-link">← 返回 Studio</Link>
          <h1 className="ui-page-title">公开主页</h1>
          <p className="ui-page-meta">公开码 {state.activity.publicCode} · revision {revision}</p>
        </div>
        <div className="task-actions">
          {state.activity.status === "draft" ? <span className="ui-card__description">活动激活后公开页才可见</span> : null}
          <a className="ui-button ui-button--secondary ui-button--md" href={`/e/${state.activity.publicCode}`} target="_blank" rel="noreferrer">查看公开页</a>
          <Button variant="primary" disabled={busy || readOnly} onClick={() => void save()}>{busy ? "正在保存…" : "保存"}</Button>
        </div>
      </header>
      {message === null ? null : <p className="ui-field__hint" role="status">{message}</p>}
      {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}
      <div className="studio-grid studio-workspace">
        <Card className="studio-main-column">
          <PublicProfileEditor draft={draft} onChange={setDraft} disabled={readOnly} />
        </Card>
        <aside className="studio-rail" aria-label="公开页预览">
          <Card>
            <h2 className="ui-card__title">预览</h2>
            <EventHero
              preview
              publicCode={state.activity.publicCode}
              title={state.activity.title}
              status={state.activity.status === "closed" ? "closed" : "active"}
              tagline={draft.tagline}
              startsAt={fromLocalInput(draft.startsAt)}
              endsAt={fromLocalInput(draft.endsAt)}
              venue={draft.venue}
              organizer={draft.organizer}
              registrationEnabled={false}
              registrationOpen={false}
              resultsAvailable={false}
            />
            <EventAbout description={draft.description} />
          </Card>
        </aside>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: 注册路由与入口**

`router.tsx` 增加：

```tsx
const studioPublicProfileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio/$activityId/public",
  component: lazyRouteComponent(() => import("./routes/studioPublicProfile.js"), "StudioPublicProfilePage"),
});
```

`studioActivity.tsx` 头部增加：

```tsx
<Link className="ui-button ui-button--secondary ui-button--md" to="/studio/$activityId/public" params={{ activityId }}>
  公开主页
</Link>
```

`WorkspaceActivityCard.tsx` 在卡片操作区增加：

```tsx
<Link className="ui-button ui-button--ghost ui-button--sm" to="/studio/$activityId/public" params={{ activityId: activity.id }}>
  公开主页
</Link>
```

- [ ] **Step 6: 运行测试**

```powershell
pnpm --filter @artflow-plus/web test -- studioPublicProfile
pnpm --filter @artflow-plus/web run check
```

Expected：PASS。

- [ ] **Step 7: 提交**

```bash
git add plus/apps/web/src
git commit -m "feat(web): add the Studio public profile editor"
```

---

## Task 9: Ops 节目排期开始时间与行内编辑

**Files:**
- Modify: `plus/apps/web/src/components/ops/ScheduleCard.tsx`
- Create: `plus/apps/web/src/components/ops/ScheduleCard.test.tsx`
- Test: `plus/apps/web/e2e/schedule.spec.ts`

- [ ] **Step 1: 写失败测试**

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useMutationMock = vi.hoisted(() => vi.fn());
const useQueryClientMock = vi.hoisted(() => vi.fn());
const fetchScheduleMock = vi.hoisted(() => vi.fn());
const upsertScheduleEntryMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
  useMutation: useMutationMock,
  useQueryClient: useQueryClientMock,
}));
vi.mock("../../api/schedule.js", () => ({
  advanceSchedule: vi.fn(),
  fetchSchedule: fetchScheduleMock,
  releaseSchedule: vi.fn(),
  removeScheduleEntry: vi.fn(),
  reorderSchedule: vi.fn(),
  revokeScheduleRelease: vi.fn(),
  upsertScheduleEntry: upsertScheduleEntryMock,
}));
vi.mock("../../api/voting.js", () => ({
  closeExecution: vi.fn(),
  fetchExecutions: vi.fn(),
  startExecution: vi.fn(),
}));

import { ScheduleCard } from "./ScheduleCard.js";

describe("ScheduleCard", () => {
  beforeEach(() => {
    useQueryClientMock.mockReturnValue({ invalidateQueries: vi.fn() });
    useMutationMock.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });
    fetchScheduleMock.mockResolvedValue({});
    upsertScheduleEntryMock.mockResolvedValue({});
    useQueryMock.mockImplementation(({ queryKey }: { readonly queryKey: readonly unknown[] }) => {
      if (queryKey[0] === "schedule") {
        return {
          data: {
            revision: 3,
            entries: [{
              id: "entry-1", activityId: "act-1", mode: "formal", position: 0,
              slotKey: "opening", slotLabel: "开场", participantId: null,
              title: "开场舞", note: "", startsAt: "2026-04-18T11:00:00.000Z",
              revision: 1, createdAt: "", updatedAt: "",
            }],
            releases: [],
            currentEntryId: null,
            slots: [{ key: "opening", label: "开场", durationMinutes: 10, kind: "program" }],
          },
          error: null,
          isPending: false,
        };
      }
      return { data: [], error: null, isPending: false };
    });
  });

  it("shows the start time and saves an inline edit", async () => {
    render(<ScheduleCard activityId="act-1" canManage />);
    expect(screen.getByText("开场舞")).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("节目名称"), { target: { value: "开场舞 2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(upsertScheduleEntryMock).toHaveBeenCalledWith("act-1", expect.objectContaining({
      entryId: "entry-1",
      title: "开场舞 2",
      startsAt: "2026-04-18T11:00:00.000Z",
    })));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm --filter @artflow-plus/web test -- ScheduleCard
```

Expected：FAIL，没有编辑/时间控件。

- [ ] **Step 3: 扩展 ScheduleCard**

在现有 state 旁增加：

```tsx
const [startsAt, setStartsAt] = useState("");
const [editing, setEditing] = useState<string | null>(null);
const [editTitle, setEditTitle] = useState("");
const [editNote, setEditNote] = useState("");
const [editStartsAt, setEditStartsAt] = useState("");
const [editError, setEditError] = useState<string | null>(null);
```

新增：

```ts
function toLocalInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  return value === "" ? null : new Date(value).toISOString();
}
```

并在新增表单中加入：

```tsx
<Input label="开始时间" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
```

`add.mutate` 的入参增加 `startsAt: fromLocalInput(startsAt)`；成功后 `setStartsAt("")`。

条目行增加：

```tsx
<span>{entry.startsAt === null ? "未排时间" : new Date(entry.startsAt).toLocaleString("zh-CN")}</span>
```

并增加“编辑”按钮：

```tsx
<Button variant="secondary" size="sm" onClick={() => {
  setEditing(entry.id);
  setEditTitle(entry.title);
  setEditNote(entry.note);
  setEditStartsAt(entry.startsAt === null ? "" : toLocalInput(entry.startsAt));
}}>编辑</Button>
```

编辑表单：

```tsx
{editing === entry.id ? (
  <div className="editor-grid">
    <Input label="节目名称" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} />
    <Input label="备注" value={editNote} onChange={(event) => setEditNote(event.target.value)} />
    <Input label="开始时间" type="datetime-local" value={editStartsAt} onChange={(event) => setEditStartsAt(event.target.value)} />
    <Button variant="primary" disabled={editTitle.trim() === ""} onClick={() => {
      setEditError(null);
      upsertScheduleEntry(activityId, {
        mode, expectedRevision: data?.revision ?? 0, entryId: entry.id, slotKey: entry.slotKey,
        title: editTitle, note: editNote, startsAt: fromLocalInput(editStartsAt),
      }).then(() => { setEditing(null); refresh(); })
        .catch((caught) => setEditError(apiErrorText(caught, "保存失败，请稍后重试。", "排期已更新，请刷新后重试。")));
    }}>保存</Button>
    <Button variant="secondary" onClick={() => setEditing(null)}>取消</Button>
    {editError === null ? null : <p className="ui-field__error" role="alert">{editError}</p>}
  </div>
) : null}
```

（`upsertScheduleEntry` 已从现有 import 引入；若未引入则补上。）

- [ ] **Step 4: 运行测试**

```powershell
pnpm --filter @artflow-plus/web test -- ScheduleCard
pnpm --filter @artflow-plus/web run check
```

Expected：PASS。

- [ ] **Step 5: 扩展 E2E**

在 `schedule.spec.ts` 的添加节目步骤中：

```ts
await page.getByLabel("开始时间").fill("2026-04-18T19:00");
```

发布后增加：

```ts
await page.goto(`/e/${publicCode}`);
await expect(page.getByText("合唱《夜空中最亮的星》")).toBeVisible();
await expect(page.getByText(/4月18日.*19:00/)).toBeVisible();
```

- [ ] **Step 6: 提交**

```bash
git add plus/apps/web/src/components/ops plus/apps/web/e2e/schedule.spec.ts
git commit -m "feat(ops): edit schedule entry start times"
```

---

## Task 10: 归档包公开资料快照

**Files:**
- Modify: `plus/packages/runtime/src/archive-package.ts`
- Modify: `plus/packages/runtime/src/archive-service.ts`
- Test: `plus/packages/runtime/test/archive-package.test.ts`
- Test: `plus/packages/runtime/test/archive-service.test.ts`
- Test: `plus/packages/runtime/test/golden-archive-identity.test.ts`

- [ ] **Step 1: 写失败测试**

在 `archive-package.test.ts` 的精确 artifact 列表中加入 `"public-profile.json"`，并断言：

```ts
const profileJson = entries["public-profile.json"];
expect(profileJson).toBeDefined();
expect(JSON.parse(strFromU8(profileJson ?? new Uint8Array()))).toBeNull();
```

再加一个带 `publicProfile` 的输入，断言字段写入。

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm --filter @artflow-plus/runtime test -- archive-package
```

Expected：FAIL，artifact 不存在。

- [ ] **Step 3: 扩展 `ArchivePackageInput` 与打包**

```ts
export interface ArchivePackagePublicProfile {
  readonly activityId: string;
  readonly tagline: string;
  readonly description: string;
  readonly venue: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly organizer: string;
  readonly contact: string;
  readonly announcement: string;
  readonly revision: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface ArchivePackageInput {
  // existing
  readonly publicProfile?: ArchivePackagePublicProfile | null;
}
```

在 `buildArchivePackage` 中：

```ts
add("public-profile.json", JSON.stringify(input.publicProfile ?? null, null, 2), "application/json");
```

`README.txt` 的“包含”行增加：

```ts
"包含：活动身份、活动公开资料快照（如有）、正式结果 release 快照、stage result、正式执行场次、事件摘要。",
```

- [ ] **Step 4: 在 `archiveActivity` 中读取公开资料**

```ts
import { findActivityPublicProfile } from "@artflow-plus/db";
...
const publicProfile = await findActivityPublicProfile(trx, activity.id);
const built = buildArchivePackage({ ...existing, publicProfile });
```

- [ ] **Step 5: 运行测试**

```powershell
pnpm --filter @artflow-plus/runtime test -- archive-package archive-service golden-archive-identity
```

Expected：PASS。

- [ ] **Step 6: 提交**

```bash
git add plus/packages/runtime
git commit -m "feat(archive): freeze the public profile in the archive package"
```

---

## Task 11: E2E seed、公开页 E2E 与 a11y

**Files:**
- Modify: `plus/apps/api/scripts/seed-public-result.ts`
- Create: `plus/apps/web/e2e/public-event.spec.ts`
- Modify: `plus/apps/web/e2e/a11y.spec.ts`

- [ ] **Step 1: 扩展 seed**

在 `seed-public-result.ts` 的活动创建/刷新后插入公开资料（若已存在则更新）：

```ts
await db.insertInto("activity_public_profile").values({
  activity_id: activityId,
  tagline: "春日声场",
  description: "2026 院十佳公开活动介绍。",
  venue: "大学生活动中心剧场",
  starts_at: new Date("2026-04-18T11:00:00.000Z"),
  ends_at: new Date("2026-04-18T13:30:00.000Z"),
  organizer: "校学生会文艺部",
  contact: "学生会办公室",
  announcement: "初赛抽签结果已公布，请选手确认曲目。",
  revision: 1,
  updated_by: "seed",
  updated_at: new Date("2026-04-01T10:00:00.000Z"),
}).onConflict((conflict) => conflict.column("activity_id").doUpdateSet({
  tagline: "春日声场",
  description: "2026 院十佳公开活动介绍。",
  venue: "大学生活动中心剧场",
  starts_at: new Date("2026-04-18T11:00:00.000Z"),
  ends_at: new Date("2026-04-18T13:30:00.000Z"),
  organizer: "校学生会文艺部",
  contact: "学生会办公室",
  announcement: "初赛抽签结果已公布，请选手确认曲目。",
  updated_by: "seed",
  updated_at: new Date("2026-04-01T10:00:00.000Z"),
})).execute();
```

- [ ] **Step 2: 写公开页 E2E**

```ts
import { expect, test } from "@playwright/test";

test("anonymous visitor reads the event home and shares it", async ({ page }) => {
  await page.goto("/e/E2E-DEMO");
  await expect(page.getByRole("heading", { name: "2026 院十佳" })).toBeVisible();
  await expect(page.getByText("春日声场")).toBeVisible();
  await expect(page.getByText("大学生活动中心剧场")).toBeVisible();
  await expect(page.getByText("林晓").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test("organizer edits the public profile and sees it on the public page", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await page.goto("/studio/act-e2e-demo/public");
  await page.getByLabel("标语").fill("新标语");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已保存")).toBeVisible();
  await page.goto("/e/E2E-DEMO");
  await expect(page.getByText("新标语")).toBeVisible();
});
```

（第二段按 `schedule.spec.ts` 的创建/激活/发布步骤补全；不要复制它的模板到多个测试，保持单条旅程。）

- [ ] **Step 3: 加 a11y**

在 `a11y.spec.ts` 的公开路由列表加入 `/e/E2E-DEMO`。

- [ ] **Step 4: 运行 E2E**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm --filter @artflow-plus/web test:e2e -- public-event.spec.ts a11y.spec.ts
```

Expected：PASS。

- [ ] **Step 5: 提交**

```bash
git add plus/apps/api/scripts/seed-public-result.ts plus/apps/web/e2e
git commit -m "test(e2e): cover the public event site"
```

---

## Task 12: 文档、配置与最终门禁

**Files:**
- Modify: `docs/artflow-plus/frontend-design-direction.md`（仅在需要说明 `/e` 静态背景时）
- Verify: `.gitignore`, `.dockerignore`, `tsconfig*.json`, Tailwind 不需要改（Portal CSS 是全局样式）

- [ ] **Step 1: 更新视觉方向中的 Portal 路由清单**

把 `/`、`/results/*`、`/vote/*`、`/e/*` 的静态背景规则补一行，说明 `/e/*` 不挂 WebGL。

- [ ] **Step 2: 跑完整门禁**

```powershell
Set-Location plus
pnpm run check
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm run test
pnpm run schema:check
pnpm --filter @artflow-plus/web test:e2e
```

仓库根：

```powershell
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
pwsh -NoProfile -File scripts/check_docs.ps1
```

- [ ] **Step 3: 配置清扫**

确认新增文件都被至少一个检查覆盖：

- `tsconfig*.json` 的 include 覆盖 `plus/apps/web/src/**` 与 `plus/packages/**`；
- Tailwind 不使用（Portal 是全局 CSS），无需 content glob；
- `.env` 模板没有新变量；
- `.dockerignore` 不包含新目录；
- `dependabot.yml` 无新生态。

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "chore: verify the public event site delivery"
```

- [ ] **Step 5: 合并**

按仓库规则，单 workstream 可在聚焦门禁通过后：

```bash
git switch main
git pull --ff-only origin main
git merge --no-ff feat/portal-public-event-site
git push origin main
```

若 CI/评审要求 PR，则走 PR 路径，等 Gates/Security/Workflow lint 全绿再合并。

---

## 完成定义

- `/e/$publicCode` 对匿名访客可用；draft/archived 404；active/closed 正常。
- Studio 可以编辑公开资料；首次保存并发由 activity 锁序列化；保存后 revision 正确。
- 节目单条目可设开始时间；公开页按时间排序；旧快照兼容。
- 最新节目单撤销后公开节目单/日程下线，不回退报名名单。
- 归档活动公开读全部下线，内部 Ops/Studio/Admin 仍可见；unarchive 恢复公开页。
- 归档包包含 `public-profile.json`。
- `pnpm check`、`REQUIRE_DB=1 pnpm test`、`schema:check`、E2E、gates、docs 全绿。
