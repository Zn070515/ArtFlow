# 观众体验与电子票实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `/t` 电子票页、公开当前节目/投票入口、活动站「现场」区，以及 Ops 入场链接复制。

**Architecture:** 电子票是只读票面（credential 只在 fragment 与 POST body 中）；投票仍由 `/vote` 兑换。当前节目 = formal active schedule release + `schedule_current` 指针，release 快照增加 `entryId`。投票入口只返回 formal open session 的 locator。

**Tech Stack:** Node 24、TypeScript、Fastify 5、Kysely、PostgreSQL 18、React 19、TanStack Router/Query、qrcode、Vitest、Playwright。

**Spec:** [`2026-11-18-audience-tickets-design.md`](../specs/2026-11-18-audience-tickets-design.md)

---

## Test architecture

按 spec §9 执行：**契约**（不新增 capability/命令；lookup 是只读投影，`entryId` 是 release snapshot 附加字段）；
**消费者**（新公开路由 lookup/current/voting，Web `/t`、`/e` 现场区，Ops 票据卡）；
**生命周期**（票据 issued/redeemed/revoked/expired；活动 draft/active/closed/archived；formal release 撤销；formal vote open/closed；test/rehearsal 不公开）；
**适配器**（不新增 capability adapter；真实 PostgreSQL + 真实命令路径，扩展 schedule 测试）；
**故障**（无效/撤销/过期 credential、轮换旧 credential、归档活动、release 撤销、旧快照无 entryId、rehearsal 指针、closed vote）；
**防膨胀 / anti-bloat**（两个服务测试文件；扩展 vote-page/schedule E2E；不复制票据签发流程）；
**门禁**（下方命令）。

---

## Task 1: release 快照 `entryId`

**Files:**
- Modify: `plus/packages/db/src/schedule-repository.ts`
- Modify: `plus/packages/runtime/src/schedule-service.ts`
- Test: `plus/packages/runtime/test/schedule-service.test.ts`

- [ ] **Step 1: 写失败测试**

在 `schedule-service.test.ts` 的 release 测试中增加：

```ts
expect(release.body.snapshot.entries[0]).toMatchObject({
  entryId: entry.body.entry.id,
});
```

在 legacy snapshot 测试中增加：

```ts
expect((await getPublicSchedule(db, activity.public_code))?.entries[0]?.entryId).toBeNull();
```

- [ ] **Step 2: 运行确认失败**

```powershell
Set-Location plus
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm --filter @artflow-plus/runtime test -- schedule-service
```

Expected：FAIL，`entryId` 未定义。

- [ ] **Step 3: 扩展类型与写入**

`schedule-repository.ts` 的 `ScheduleSnapshotEntry` 增加：

```ts
readonly entryId: string | null;
```

`release()` 的 normalization 增加：

```ts
entryId: entry.entryId ?? null,
```

`schedule-service.ts` 的 `releaseSchedule` snapshot 条目增加：

```ts
entryId: entry.id,
```

- [ ] **Step 4: 运行测试**

```powershell
pnpm --filter @artflow-plus/runtime test -- schedule-service
pnpm --filter @artflow-plus/db run check
```

Expected：PASS。

- [ ] **Step 5: 提交**

```bash
git add plus/packages/db plus/packages/runtime
git commit -m "feat(schedule): freeze entry ids into the release snapshot"
```

---

## Task 2: 票据只读 lookup

**Files:**
- Modify: `plus/packages/runtime/src/ticket-service.ts`
- Create: `plus/packages/runtime/src/ticket-read-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Test: `plus/packages/runtime/test/ticket-read-service.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, getTicket, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";

import type { RuntimeDeps } from "../src/deps.js";
import { getPublicTicketLookup } from "../src/ticket-read-service.js";
import { issueTicket, revokeTicket, rotateTicketCredential } from "../src/ticket-service.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_ticket_read_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;

const staff: ActorContext = {
  actorId: "ticket-staff", actorType: "user", roles: ["staff"], permissions: ["ticket.manage"],
};
const secret = "test-credential-secret-0123456789";
function deps(): RuntimeDeps {
  return {
    actor: staff,
    credentialSecret: secret,
    now: () => "2026-04-18T10:00:00.000Z",
    newEventId: () => randomUUID(),
  };
}

async function seedActivity(status: "active" | "closed" | "draft" | "archived" = "active") {
  await db.insertInto("activity").values({
    id: "act-ticket", public_code: "TICKET-1", title: "电子票活动",
    status, revision: 1, enabled_capabilities: JSON.stringify(["ticketing"]),
    active_definition_version: 1,
  }).execute();
}

describe.skipIf(!connectionString)("public ticket lookup", () => {
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

  it("returns the ticket and public activity without changing state", async () => {
    await seedActivity();
    const issued = await issueTicket(db, deps(), { commandId: randomUUID(), activityId: "act-ticket" });
    const credential = issued.body.credential;
    if (credential === undefined) throw new Error("credential missing");
    const lookup = await getPublicTicketLookup(db, deps(), credential);
    expect(lookup.ticket.publicCode).toBe(issued.body.ticket.publicCode);
    expect(lookup.ticket.state).toBe("issued");
    expect(lookup.activity).toMatchObject({ publicCode: "TICKET-1", title: "电子票活动" });
    expect((await getTicket(db, issued.body.ticket.id))?.state).toBe("issued");
  });

  it("rejects rotated, archived and revoked tickets", async () => {
    const issued = await issueTicket(db, deps(), { commandId: randomUUID(), activityId: "act-ticket" });
    const credential = issued.body.credential;
    if (credential === undefined) throw new Error("credential missing");
    const rotated = await rotateTicketCredential(db, deps(), {
      commandId: randomUUID(), activityId: "act-ticket", ticketId: issued.body.ticket.id,
    });
    await expect(getPublicTicketLookup(db, deps(), credential)).rejects.toMatchObject({ code: "INVALID_TICKET" });
    const currentCredential = rotated.body.credential;
    if (currentCredential === undefined || currentCredential === null) {
      throw new Error("rotated credential missing");
    }
    // A valid ticket whose activity is archived is still not public.
    await db.updateTable("activity").set({ status: "archived" }).where("id", "=", "act-ticket").execute();
    await expect(getPublicTicketLookup(db, deps(), currentCredential))
      .rejects.toMatchObject({ code: "TICKET_ACTIVITY_NOT_PUBLIC" });
    await db.updateTable("activity").set({ status: "active" }).where("id", "=", "act-ticket").execute();
    await revokeTicket(db, deps(), {
      commandId: randomUUID(), activityId: "act-ticket", ticketId: issued.body.ticket.id, reason: "测试",
    });
    await expect(getPublicTicketLookup(db, deps(), currentCredential))
      .rejects.toMatchObject({ code: "TICKET_REVOKED" });
  });
});
```

- [ ] **Step 2: 运行确认失败**

```powershell
pnpm --filter @artflow-plus/runtime test -- ticket-read-service
```

Expected：FAIL，模块/函数不存在。

- [ ] **Step 3: 在 ticket-service 增加只读校验**

在 `ticket-service.ts` 增加：

```ts
export async function lookupTicketByCredential(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  rawCredential: string,
): Promise<StoredTicket> {
  const signingSecret = secret(deps);
  const parsed = parseCredential(rawCredential, "T", signingSecret);
  if (parsed === null) throw new DomainError("INVALID_TICKET", "The ticket credential is invalid.");
  const candidate = await findTicketByCredential(db, parsed.publicCode, parsed.version);
  if (
    candidate === null ||
    !validCredentialForRow(rawCredential, "T", candidate.publicCode, candidate.credentialVersion, signingSecret)
  ) {
    throw new DomainError("INVALID_TICKET", "The ticket credential is invalid.");
  }
  if (candidate.state === "revoked") {
    throw new DomainError("TICKET_REVOKED", "The ticket has been revoked.");
  }
  if (candidate.state === "expired") {
    throw new DomainError("TICKET_EXPIRED", "The ticket has expired.");
  }
  return candidate;
}
```

- [ ] **Step 4: 写读服务**

`ticket-read-service.ts`：

```ts
import type { Database, StoredTicket } from "@artflow-plus/db";
import { getActivityPublicProfile, getActivitySummary } from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import type { RuntimeDeps } from "./deps.js";
import { lookupTicketByCredential } from "./ticket-service.js";

export interface PublicTicketLookup {
  readonly ticket: {
    readonly publicCode: string;
    readonly state: StoredTicket["state"];
    readonly credentialVersion: number;
    readonly issuedAt: string;
    readonly redeemedAt?: string;
    readonly revokedAt?: string;
  };
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "active" | "closed";
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly venue: string;
    readonly organizer: string;
  };
  readonly links: { readonly event: string; readonly results: string };
}

export async function getPublicTicketLookup(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  credential: string,
): Promise<PublicTicketLookup> {
  const ticket = await lookupTicketByCredential(db, deps, credential);
  const activity = await getActivitySummary(db, ticket.activityId);
  if (activity === null || (activity.status !== "active" && activity.status !== "closed")) {
    throw new DomainError("TICKET_ACTIVITY_NOT_PUBLIC", "The activity is not public.");
  }
  const profile = await getActivityPublicProfile(db, activity.id);
  return {
    ticket: {
      publicCode: ticket.publicCode,
      state: ticket.state,
      credentialVersion: ticket.credentialVersion,
      issuedAt: ticket.issuedAt,
      ...(ticket.redeemedAt === undefined ? {} : { redeemedAt: ticket.redeemedAt }),
      ...(ticket.revokedAt === undefined ? {} : { revokedAt: ticket.revokedAt }),
    },
    activity: {
      publicCode: activity.publicCode,
      title: activity.title,
      status: activity.status,
      startsAt: profile.startsAt,
      endsAt: profile.endsAt,
      venue: profile.venue,
      organizer: profile.organizer,
    },
    links: {
      event: `/e/${encodeURIComponent(activity.publicCode)}`,
      results: `/results/${encodeURIComponent(activity.publicCode)}`,
    },
  };
}
```

- [ ] **Step 5: 导出并运行**

`runtime/index.ts` 增加：

```ts
export * from "./ticket-read-service.js";
```

```powershell
pnpm --filter @artflow-plus/runtime test -- ticket-read-service
pnpm --filter @artflow-plus/runtime run check
```

Expected：PASS。

- [ ] **Step 6: 提交**

```bash
git add plus/packages/runtime
git commit -m "feat(ticketing): add the public ticket lookup"
```

---

## Task 3: 公开现场服务

**Files:**
- Create: `plus/packages/runtime/src/public-live-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Test: `plus/packages/runtime/test/public-live-service.test.ts`

- [ ] **Step 1: 写测试**

测试 seed：

```ts
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";

import { getPublicCurrentProgram, getPublicVoteEntry } from "../src/public-live-service.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
const schema = `artflow_public_live_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;

async function seedSchedule(): Promise<void> {
  await db.insertInto("activity").values({
    id: "act-live", public_code: "LIVE-1", title: "现场活动",
    status: "active", revision: 1,
    enabled_capabilities: JSON.stringify(["schedule", "voting"]),
    active_definition_version: 1,
  }).execute();
  await db.insertInto("schedule_release").values({
    id: "release-live", activity_id: "act-live", mode: "formal", version: 1,
    snapshot: JSON.stringify({
      version: 1, schemaVersion: 1, releasedAt: "2026-04-18T10:00:00.000Z",
      entries: [
        { entryId: "entry-1", order: 1, slotKey: "opening", slotLabel: "开场", participantId: null, title: "开场舞", note: "", startsAt: "2026-04-18T19:00:00.000Z" },
        { entryId: "entry-2", order: 2, slotKey: "program", slotLabel: "第一轮", participantId: null, title: "第一首", note: "", startsAt: "2026-04-18T19:10:00.000Z" },
        { entryId: "entry-3", order: 3, slotKey: "program", slotLabel: "第一轮", participantId: null, title: "第二首", note: "", startsAt: "2026-04-18T19:20:00.000Z" },
      ],
    }),
    note: "", released_at: new Date("2026-04-18T10:00:00.000Z"), revoked_at: null,
  }).execute();
  await db.insertInto("schedule_current").values({
    activity_id: "act-live", mode: "formal", entry_id: "entry-2",
    updated_at: new Date("2026-04-18T10:00:00.000Z"),
  }).execute();
  await db.insertInto("vote_session").values({
    id: "vote-open", activity_id: "act-live", definition_version: 1, mode: "formal",
    purpose: "popularity", selection_type: "single", max_selections: 1,
    identity_policy: "browser", scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
    status: "open", revision: 0, opened_at: new Date("2026-04-18T10:00:00.000Z"), closed_at: null,
  }).execute();
}

describe.skipIf(!connectionString)("public live reads", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await seedSchedule();
  });
  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns the current entry and the next entries from the formal release", async () => {
    const view = await getPublicCurrentProgram(db, "LIVE-1");
    expect(view?.current).toMatchObject({ title: "第一首", order: 2 });
    expect(view?.next.map((entry) => entry.title)).toEqual(["第二首"]);
  });

  it("ignores a rehearsal pointer and returns null for draft/archived", async () => {
    await db.insertInto("schedule_current").values({
      activity_id: "act-live", mode: "rehearsal", entry_id: "entry-3",
      updated_at: new Date("2026-04-18T10:00:00.000Z"),
    }).onConflict((conflict) => conflict.columns(["activity_id", "mode"]).doUpdateSet({ entry_id: "entry-3" })).execute();
    const view = await getPublicCurrentProgram(db, "LIVE-1");
    expect(view?.current?.title).toBe("第一首");
    await db.updateTable("activity").set({ status: "archived" }).where("id", "=", "act-live").execute();
    expect(await getPublicCurrentProgram(db, "LIVE-1")).toBeNull();
    expect(await getPublicVoteEntry(db, "LIVE-1")).toBeNull();
    await db.updateTable("activity").set({ status: "active" }).where("id", "=", "act-live").execute();
  });

  it("returns only the latest open formal vote session", async () => {
    await db.insertInto("vote_session").values({
      id: "vote-closed", activity_id: "act-live", definition_version: 1, mode: "formal",
      purpose: "popularity", selection_type: "single", max_selections: 1,
      identity_policy: "browser", scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
      status: "closed", revision: 1, opened_at: new Date("2026-04-18T09:00:00.000Z"), closed_at: new Date("2026-04-18T09:30:00.000Z"),
    }).execute();
    expect(await getPublicVoteEntry(db, "LIVE-1")).toEqual({ sessionId: "vote-open", status: "open" });
    await db.updateTable("activity").set({ status: "closed" }).where("id", "=", "act-live").execute();
    expect(await getPublicVoteEntry(db, "LIVE-1")).toBeNull();
    await db.updateTable("activity").set({ status: "active" }).where("id", "=", "act-live").execute();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```powershell
pnpm --filter @artflow-plus/runtime test -- public-live-service
```

Expected：FAIL，模块不存在。

- [ ] **Step 3: 写服务**

```ts
import type { Database } from "@artflow-plus/db";
import {
  getActivityByPublicCode,
  getScheduleCurrent,
  listVoteSessionsForActivity,
  selectActiveScheduleRelease,
} from "@artflow-plus/db";
import type { Kysely } from "kysely";

export interface PublicScheduleEntry {
  readonly order: number;
  readonly slotLabel: string;
  readonly title: string;
  readonly note: string;
  readonly startsAt: string | null;
}

export interface PublicCurrentProgram {
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "active" | "closed";
  };
  readonly current: PublicScheduleEntry | null;
  readonly next: readonly PublicScheduleEntry[];
}

export type PublicVoteEntry = { readonly sessionId: string; readonly status: "open" } | null;

export async function getPublicCurrentProgram(
  db: Kysely<Database>,
  publicCode: string,
): Promise<PublicCurrentProgram | null> {
  const activity = await getActivityByPublicCode(db, publicCode);
  if (activity === null || (activity.status !== "active" && activity.status !== "closed")) return null;
  const release = await selectActiveScheduleRelease(db, publicCode);
  if (release === null) {
    return { activity: { publicCode: activity.publicCode, title: activity.title, status: activity.status }, current: null, next: [] };
  }
  const entries = release.release.snapshot.entries;
  const currentId = await getScheduleCurrent(db, activity.id, "formal");
  const current = currentId === null
    ? undefined
    : entries.find((entry) => entry.entryId === currentId);
  const toPublic = (entry: (typeof entries)[number]): PublicScheduleEntry => ({
    order: entry.order,
    slotLabel: entry.slotLabel,
    title: entry.title,
    note: entry.note,
    startsAt: entry.startsAt ?? null,
  });
  const next = current === undefined
    ? entries.slice(0, 5).map(toPublic)
    : entries.filter((entry) => entry.order > current.order).slice(0, 5).map(toPublic);
  return {
    activity: { publicCode: activity.publicCode, title: activity.title, status: activity.status },
    current: current === undefined ? null : toPublic(current),
    next,
  };
}

export async function getPublicVoteEntry(
  db: Kysely<Database>,
  publicCode: string,
): Promise<PublicVoteEntry> {
  const activity = await getActivityByPublicCode(db, publicCode);
  if (activity === null || activity.status !== "active") return null;
  const sessions = await listVoteSessionsForActivity(db, activity.id);
  const open = sessions
    .filter((session) => session.mode === "formal" && session.status === "open")
    .sort((left, right) => (right.openedAt ?? "").localeCompare(left.openedAt ?? ""))[0];
  return open === undefined ? null : { sessionId: open.id, status: "open" };
}
```

- [ ] **Step 4: 导出并运行**

`runtime/index.ts` 增加 `export * from "./public-live-service.js";`。

```powershell
pnpm --filter @artflow-plus/runtime test -- public-live-service
pnpm --filter @artflow-plus/runtime run check
```

Expected：PASS。

- [ ] **Step 5: 提交**

```bash
git add plus/packages/runtime
git commit -m "feat(public): add current program and vote entry reads"
```

---

## Task 4: API 路由

**Files:**
- Modify: `plus/apps/api/src/routes/public.ts`
- Test: `plus/apps/api/test/public-live.test.ts`
- Test: `plus/apps/api/test/public-ticket.test.ts`

- [ ] **Step 1: 写 API 测试**

`public-live.test.ts`：

```ts
import { randomUUID } from "node:crypto";
import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
const schema = `artflow_api_public_live_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;
const deps: RuntimeDeps = { now: () => new Date().toISOString(), newEventId: () => randomUUID() };

describe.skipIf(!connectionString)("public live routes", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await db.insertInto("activity").values({
      id: "act-live", public_code: "LIVE-1", title: "现场活动", status: "active",
      revision: 1, enabled_capabilities: JSON.stringify(["schedule", "voting"]),
      active_definition_version: 1,
    }).execute();
    await db.insertInto("schedule_release").values({
      id: "release-live", activity_id: "act-live", mode: "formal", version: 1,
      snapshot: JSON.stringify({
        version: 1, schemaVersion: 1, releasedAt: "2026-04-18T10:00:00.000Z",
        entries: [
          { entryId: "entry-1", order: 1, slotKey: "opening", slotLabel: "开场", participantId: null, title: "开场舞", note: "", startsAt: "2026-04-18T19:00:00.000Z" },
          { entryId: "entry-2", order: 2, slotKey: "program", slotLabel: "第一轮", participantId: null, title: "第一首", note: "", startsAt: "2026-04-18T19:10:00.000Z" },
          { entryId: "entry-3", order: 3, slotKey: "program", slotLabel: "第一轮", participantId: null, title: "第二首", note: "", startsAt: "2026-04-18T19:20:00.000Z" },
        ],
      }),
      note: "", released_at: new Date("2026-04-18T10:00:00.000Z"), revoked_at: null,
    }).execute();
    await db.insertInto("schedule_current").values({
      activity_id: "act-live", mode: "formal", entry_id: "entry-2",
      updated_at: new Date("2026-04-18T10:00:00.000Z"),
    }).execute();
    await db.insertInto("vote_session").values({
      id: "vote-open", activity_id: "act-live", definition_version: 1, mode: "formal",
      purpose: "popularity", selection_type: "single", max_selections: 1,
      identity_policy: "browser",
      scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
      status: "open", revision: 0, opened_at: new Date("2026-04-18T10:00:00.000Z"), closed_at: null,
    }).execute();
    app = await buildApp({ db, deps });
    await app.ready();
  });
  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns the current program without participant ids", async () => {
    const response = await app.inject({ method: "GET", url: "/api/public/activities/LIVE-1/current" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ current: { title: "第一首", order: 2 } });
    expect(response.json().next.map((entry: { title: string }) => entry.title)).toEqual(["第二首"]);
    expect(response.body).not.toContain("participantId");
  });

  it("returns the open formal vote locator and 404 for archived", async () => {
    const vote = await app.inject({ method: "GET", url: "/api/public/activities/LIVE-1/voting" });
    expect(vote.json()).toEqual({ sessionId: "vote-open", status: "open" });
    await db.updateTable("activity").set({ status: "archived" }).where("id", "=", "act-live").execute();
    expect((await app.inject({ method: "GET", url: "/api/public/activities/LIVE-1/current" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/public/activities/LIVE-1/voting" })).statusCode).toBe(404);
    await db.updateTable("activity").set({ status: "active" }).where("id", "=", "act-live").execute();
  });
});
```

`public-ticket.test.ts`：

```ts
import { randomUUID } from "node:crypto";
import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { issueTicket, type RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
const schema = `artflow_api_public_ticket_${Date.now()}_${process.pid}`;
const secret = "test-credential-secret-0123456789";
let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;
let credential = "";

const staff: ActorContext = {
  actorId: "ticket-staff", actorType: "user", roles: ["staff"], permissions: ["ticket.manage"],
};
const deps: RuntimeDeps = {
  actor: staff, credentialSecret: secret,
  now: () => new Date().toISOString(), newEventId: () => randomUUID(),
};

describe.skipIf(!connectionString)("public ticket lookup", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await db.insertInto("activity").values({
      id: "act-ticket", public_code: "TICKET-1", title: "电子票活动", status: "active",
      revision: 1, enabled_capabilities: JSON.stringify(["ticketing"]),
      active_definition_version: 1,
    }).execute();
    const issued = await issueTicket(db, deps, { commandId: randomUUID(), activityId: "act-ticket" });
    if (issued.body.credential === undefined) throw new Error("credential missing");
    credential = issued.body.credential;
    app = await buildApp({ db, deps });
    await app.ready();
  });
  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns the ticket and activity without echoing the credential", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/public/tickets/lookup",
      headers: { "content-type": "application/json" },
      payload: { credential },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ticket: { state: "issued" },
      activity: { publicCode: "TICKET-1", title: "电子票活动" },
    });
    expect(response.body).not.toContain(credential);
  });
});
```

- [ ] **Step 2: 增加路由**

`routes/public.ts`：

```ts
app.post(
  "/api/public/tickets/lookup",
  { schema: { body: TicketCredentialBodySchema }, config: { access: "public" } },
  async (request, reply) => {
    await requirePublicRateLimit(request, "ticket-lookup", 30);
    const body = request.body as { credential: string };
    const lookup = await getPublicTicketLookup(db, publicDeps(), body.credential);
    reply.header("cache-control", "no-store");
    return lookup;
  },
);

app.get(
  "/api/public/activities/:publicCode/current",
  { schema: { params: PublicActivityParams }, config: { access: "public" } },
  async (request, reply) => {
    const { publicCode } = request.params as { publicCode: string };
    await requirePublicRateLimit(request, `public-current:${publicCode}`, 120);
    const view = await getPublicCurrentProgram(db, publicCode);
    reply.header("cache-control", "no-store");
    if (view === null) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "The current program was not found." });
    }
    return view;
  },
);

app.get(
  "/api/public/activities/:publicCode/voting",
  { schema: { params: PublicActivityParams }, config: { access: "public" } },
  async (request, reply) => {
    const { publicCode } = request.params as { publicCode: string };
    await requirePublicRateLimit(request, `public-vote-entry:${publicCode}`, 120);
    const entry = await getPublicVoteEntry(db, publicCode);
    reply.header("cache-control", "no-store");
    return entry;
  },
);
```

导入 `TicketCredentialBodySchema`（contracts）、`getPublicTicketLookup`、`getPublicCurrentProgram`、`getPublicVoteEntry`。

- [ ] **Step 3: 运行测试**

```powershell
$env:REQUIRE_DB = "1"
pnpm --filter @artflow-plus/api test -- public-live public-ticket
pnpm --filter @artflow-plus/api run check
```

Expected：PASS。

- [ ] **Step 4: 提交**

```bash
git add plus/apps/api
git commit -m "feat(api): expose the public ticket and live reads"
```

---

## Task 5: `/t` 电子票页

**Files:**
- Create: `plus/apps/web/src/api/tickets-public.ts`
- Create: `plus/apps/web/src/routes/ticket.tsx`
- Create: `plus/apps/web/src/styles/ticket.css`
- Modify: `plus/apps/web/src/styles/global.css`
- Modify: `plus/apps/web/src/router.tsx`
- Modify: `plus/apps/web/src/components/ops/TicketsCard.tsx`
- Test: `plus/apps/web/src/routes/ticket.test.tsx`
- Test: `plus/apps/web/src/components/ops/TicketsCard.test.tsx`

- [ ] **Step 1: 写 API client**

`api/tickets-public.ts`：

```ts
import { apiFetch } from "./client.js";

export interface PublicTicketLookup {
  readonly ticket: {
    readonly publicCode: string;
    readonly state: "issued" | "redeemed" | "revoked" | "expired";
    readonly credentialVersion: number;
    readonly issuedAt: string;
    readonly redeemedAt?: string;
    readonly revokedAt?: string;
  };
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "active" | "closed";
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly venue: string;
    readonly organizer: string;
  };
  readonly links: { readonly event: string; readonly results: string };
}

export interface PublicScheduleEntry {
  readonly order: number;
  readonly slotLabel: string;
  readonly title: string;
  readonly note: string;
  readonly startsAt: string | null;
}

export interface PublicCurrentProgram {
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "active" | "closed";
  };
  readonly current: PublicScheduleEntry | null;
  readonly next: readonly PublicScheduleEntry[];
}

export type PublicVoteEntry = { readonly sessionId: string; readonly status: "open" } | null;

export function lookupTicket(credential: string): Promise<PublicTicketLookup> {
  return apiFetch("/api/public/tickets/lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
}

export function fetchPublicCurrent(publicCode: string, signal?: AbortSignal): Promise<PublicCurrentProgram> {
  return apiFetch(`/api/public/activities/${encodeURIComponent(publicCode)}/current`, { signal });
}

export function fetchPublicVoteEntry(publicCode: string, signal?: AbortSignal): Promise<PublicVoteEntry> {
  return apiFetch(`/api/public/activities/${encodeURIComponent(publicCode)}/voting`, { signal });
}
```

- [ ] **Step 2: 写页面**

`routes/ticket.tsx` 的核心：

```tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import * as QRCode from "qrcode";

import { ApiError } from "../api/client.js";
import { fetchPublicCurrent, fetchPublicVoteEntry, lookupTicket, type PublicTicketLookup } from "../api/tickets-public.js";
import { Button } from "../components/ui/Button.js";
import { Input } from "../components/ui/Input.js";

function readCredential(): string {
  if (typeof window === "undefined") return "";
  const value = new URLSearchParams(window.location.hash.slice(1)).get("ticket");
  return value?.trim() ?? "";
}

function errorCopy(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "TICKET_REVOKED") return "票据已撤销，请联系主办方。";
  if (code === "TICKET_EXPIRED") return "票据已过期。";
  if (code === "TICKET_ACTIVITY_NOT_PUBLIC") return "活动已结束或尚未公开。";
  return "票据无效，请确认链接完整。";
}

export function TicketPage() {
  const [credential, setCredential] = useState(readCredential);
  const [input, setInput] = useState("");
  const [lookup, setLookup] = useState<PublicTicketLookup | undefined>();
  const [qr, setQr] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const lookupMutation = useMutation({ mutationFn: (value: string) => lookupTicket(value) });
  const publicCode = lookup?.activity.publicCode;
  const active = lookup?.activity.status === "active";
  const current = useQuery({
    queryKey: ["public-current", publicCode],
    queryFn: ({ signal }) => fetchPublicCurrent(publicCode ?? "", signal),
    enabled: publicCode !== undefined && active,
    refetchInterval: 30_000,
    retry: false,
  });
  const vote = useQuery({
    queryKey: ["public-vote-entry", publicCode],
    queryFn: ({ signal }) => fetchPublicVoteEntry(publicCode ?? "", signal),
    enabled: publicCode !== undefined && active,
    refetchInterval: 30_000,
    retry: false,
  });

  async function submit(value: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed === "") { setError("请输入入场凭证。"); return; }
    setError(null);
    try {
      const data = await lookupMutation.mutateAsync(trimmed);
      setCredential(trimmed);
      setLookup(data);
      setQr(await QRCode.toDataURL(trimmed, { margin: 1, width: 240 }));
    } catch (caught) {
      setLookup(undefined);
      setQr(undefined);
      setError(errorCopy(caught));
    }
  }

  useEffect(() => {
    const value = readCredential();
    if (value !== "") void submit(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { document.title = "入场票 · ArtFlow"; }, []);

  return (
    <section className="ticket-page">
      <header className="ticket-header">
        <p className="eyebrow">E-TICKET · 入场票</p>
        <h1 className="ticket-title">{lookup?.activity.title ?? "电子票"}</h1>
        {lookup === undefined ? null : (
          <p className="ticket-meta">
            {lookup.activity.status === "closed" ? "已结束" : "入场凭证"} · 票号 {lookup.ticket.publicCode}
          </p>
        )}
      </header>
      {error === null ? null : <p className="ticket-error" role="alert">{error}</p>}
      {lookup === undefined ? (
        <div className="ticket-manual">
          <Input label="入场凭证" value={input} onChange={(event) => setInput(event.target.value)} placeholder="粘贴主办方发送的入场凭证" />
          <Button variant="primary" disabled={lookupMutation.isPending} onClick={() => void submit(input)}>
            {lookupMutation.isPending ? "正在校验…" : "查看票据"}
          </Button>
        </div>
      ) : (
        <>
          <div className="ticket-card">
            {qr === undefined ? null : <img className="ticket-qr" src={qr} alt="入场二维码" width={240} height={240} />}
            <p className="ticket-state">
              {lookup.ticket.state === "issued" ? "待领取" : lookup.ticket.state === "redeemed" ? "已领取" : lookup.ticket.state === "revoked" ? "已撤销" : "已过期"}
            </p>
            <p className="ticket-instruction">请在入场时出示二维码，或让工作人员输入下方凭证。</p>
            <p className="ticket-credential">{credential}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(credential).then(
                  () => { setCopyState("copied"); window.setTimeout(() => setCopyState("idle"), 2000); },
                  () => { setCopyState("failed"); window.setTimeout(() => setCopyState("idle"), 2000); },
                );
              }}
            >
              复制凭证
            </Button>
            <span role="status">
              {copyState === "copied" ? "凭证已复制" : copyState === "failed" ? "复制失败，请手动复制" : ""}
            </span>
            <p className="ticket-hint">此链接包含入场凭证，请勿转发；轮换票据后旧链接失效。</p>
            <Button variant="secondary" onClick={() => window.print()}>打印 / 保存</Button>
          </div>
          {active ? (
            <section className="ticket-live">
              <h2>现场</h2>
              {current.data?.current === undefined || current.data?.current === null ? <p>暂无当前节目</p> : (
                <p>当前：{current.data.current.title} · {current.data.current.slotLabel}</p>
              )}
              {current.data === undefined || current.data.next.length === 0 ? null : (
                <p>接下来：{current.data.next.slice(0, 3).map((entry) => entry.title).join(" · ")}</p>
              )}
              {vote.data === null || vote.data === undefined ? null : (
                <a className="ticket-vote" href={`/vote/${encodeURIComponent(vote.data.sessionId)}#ticket=${encodeURIComponent(credential)}`}>
                  投票进行中 · 去投票
                </a>
              )}
            </section>
          ) : null}
          <p className="ticket-links">
            <a href={lookup.links.event}>活动主页</a>
            {" · "}
            <a href={lookup.links.results}>赛果</a>
          </p>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 3: 路由与样式**

`router.tsx` 增加：

```tsx
const ticketRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/t",
  component: lazyRouteComponent(() => import("./routes/ticket.js"), "TicketPage"),
});
```

加入 `routeTree`。`styles/ticket.css`：

```css
.ticket-page { max-width: 720px; margin: 0 auto; padding: 48px 24px 72px; }
.ticket-header { padding-bottom: 20px; border-bottom: 1px solid var(--line); }
.ticket-title { margin: 0; font-family: var(--display); font-size: clamp(2rem, 6vw, 3.2rem); }
.ticket-meta { margin: 12px 0 0; color: var(--bone-subtle); font-size: 0.85rem; }
.ticket-error { margin: 20px 0; padding: 12px 14px; border-left: 2px solid var(--ember); background: var(--ember-soft); }
.ticket-manual { display: grid; gap: 12px; padding-top: 24px; }
.ticket-card { display: grid; justify-items: center; gap: 12px; margin-top: 24px; padding: 24px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); text-align: center; }
.ticket-qr { display: block; width: 240px; height: 240px; padding: 8px; border-radius: 8px; background: #fff; }
.ticket-state { margin: 0; color: var(--gold); font-size: 0.8rem; letter-spacing: 0.16em; text-transform: uppercase; }
.ticket-instruction { margin: 0; color: var(--bone-dim); }
.ticket-credential { max-width: 100%; margin: 0; padding: 10px 12px; border: 1px dashed var(--line-strong); border-radius: 6px; font-family: "JetBrains Mono Variable", monospace; font-size: 0.8rem; word-break: break-all; }
.ticket-hint { margin: 0; color: var(--bone-subtle); font-size: 0.75rem; }
.ticket-live { display: grid; gap: 8px; margin-top: 24px; padding: 20px; border: 1px solid var(--line); border-radius: 10px; }
.ticket-live h2 { margin: 0; font-size: 1.1rem; }
.ticket-vote { color: var(--gold); font-weight: 700; text-decoration: none; }
.ticket-links { margin: 24px 0 0; color: var(--bone-subtle); }
.ticket-links a { color: var(--gold); }
@media (max-width: 720px) { .ticket-page { padding: 24px 16px 56px; } }
@media print {
  .ticket-page { max-width: none; padding: 0; color: #000; background: #fff; }
  .ticket-manual, .ticket-live, .ticket-links, .ticket-page .ui-button, .ticket-page [role="status"] { display: none; }
  .ticket-card { border: 1px solid #000; background: #fff; }
  .ticket-credential, .ticket-hint, .ticket-instruction { color: #000; }
}
```

`global.css` 在 `me.css` 后导入。`styles/ticket.css` 的 `.ticket-page` 必须始终渲染（无 credential 时是手动输入态），供 a11y 使用。

- [ ] **Step 4: Ops 复制链接**

`TicketsCard.tsx` 在 credential 显示区增加：

```tsx
const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
async function copyEntryLink(credential: string): Promise<void> {
  const link = `${window.location.origin}/t#ticket=${encodeURIComponent(credential)}`;
  try {
    await navigator.clipboard.writeText(link);
    setCopyState("copied");
  } catch {
    setCopyState("failed");
  }
  window.setTimeout(() => setCopyState("idle"), 2000);
}
```

按钮与可见状态：

```tsx
<Button variant="secondary" size="sm" onClick={() => void copyEntryLink(issued.credential)}>
  复制入场链接
</Button>
<span role="status">{copyState === "copied" ? "入场链接已复制" : copyState === "failed" ? "复制失败，请手动复制" : ""}</span>
```

- [ ] **Step 5: 写测试**

`ticket.test.tsx`：mock `lookupTicket`/`fetchPublicCurrent`/`fetchPublicVoteEntry`/`qrcode.toDataURL`；设置 `window.history.replaceState(..., "#ticket=T.CRED")`；断言标题、二维码 `alt`、票号、投票链接；错误态；无 fragment 时手动输入。`TicketsCard.test.tsx` 增加 mock clipboard，点击「复制入场链接」，断言写入 `/t#ticket=...` 和可见状态。

- [ ] **Step 6: 运行**

```powershell
pnpm --filter @artflow-plus/web test -- ticket
pnpm --filter @artflow-plus/web run check
```

Expected：PASS。

- [ ] **Step 7: 提交**

```bash
git add plus/apps/web
git commit -m "feat(web): add the e-ticket page and entry link"
```

---

## Task 6: 活动站「现场」区

**Files:**
- Create: `plus/apps/web/src/components/portal/EventLive.tsx`
- Modify: `plus/apps/web/src/routes/publicEvent.tsx`
- Test: `plus/apps/web/src/routes/publicEvent.test.tsx`

- [ ] **Step 1: 写组件**

```tsx
import type { PublicCurrentProgram, PublicVoteEntry } from "../../api/tickets-public.js";

export function EventLive({
  current,
  vote,
}: {
  readonly current: PublicCurrentProgram | undefined;
  readonly vote: PublicVoteEntry | undefined;
}) {
  const hasCurrent = current?.current !== undefined && current?.current !== null;
  const hasNext = (current?.next.length ?? 0) > 0;
  if (!hasCurrent && !hasNext && (vote === null || vote === undefined)) return null;
  return (
    <section className="event-section event-live" id="live" aria-labelledby="event-live-title">
      <h2 className="event-section__title" id="event-live-title">现场</h2>
      {hasCurrent && current?.current !== null && current.current !== undefined ? (
        <p className="event-live__current">
          当前：{current.current.title} · {current.current.slotLabel}
        </p>
      ) : null}
      {hasNext ? (
        <p className="event-live__next">
          接下来：{current?.next.slice(0, 3).map((entry) => entry.title).join(" · ")}
        </p>
      ) : null}
      {vote === null || vote === undefined ? null : (
        <a className="event-button event-button--primary" href={`/vote/${encodeURIComponent(vote.sessionId)}`}>
          投票进行中 · 去投票
        </a>
      )}
    </section>
  );
}
```

- [ ] **Step 2: 页面接入**

`publicEvent.tsx` 的顶部 import：

```tsx
import { fetchPublicCurrent, fetchPublicVoteEntry } from "../api/tickets-public.js";
import { EventLive } from "../components/portal/EventLive.js";
```

在主 `query` 之后、任何 early return 之前增加（Rules of Hooks）：

```tsx
const current = useQuery({
  queryKey: ["public-current", publicCode],
  queryFn: ({ signal }) => fetchPublicCurrent(publicCode, signal),
  enabled: query.data?.activity.status === "active",
  refetchInterval: 30_000,
  retry: false,
});
const vote = useQuery({
  queryKey: ["public-vote-entry", publicCode],
  queryFn: ({ signal }) => fetchPublicVoteEntry(publicCode, signal),
  enabled: query.data?.activity.status === "active",
  refetchInterval: 30_000,
  retry: false,
});
```

在公告之后、`EventAbout` 之前渲染：

```tsx
<EventLive current={current.data} vote={vote.data} />
```

锚点导航增加：

```tsx
{site.activity.status === "active" &&
 (current.data?.current != null || (current.data?.next.length ?? 0) > 0 || vote.data != null) ? (
  <a href="#live">现场</a>
) : null}
```

- [ ] **Step 3: 测试**

`publicEvent.test.tsx` 的 `useQueryMock` 按 `queryKey[0]` 返回 site/current/vote；断言「当前：」「接下来：」「去投票」；无数据时「现场」不渲染。

- [ ] **Step 4: 运行**

```powershell
pnpm --filter @artflow-plus/web test -- publicEvent
pnpm --filter @artflow-plus/web run check
```

Expected：PASS。

- [ ] **Step 5: 提交**

```bash
git add plus/apps/web
git commit -m "feat(web): show the live program on the event site"
```

---

## Task 7: E2E、a11y 与最终门禁

**Files:**
- Modify: `plus/apps/web/e2e/vote-page.spec.ts`
- Modify: `plus/apps/web/e2e/schedule.spec.ts`
- Modify: `plus/apps/web/e2e/a11y.spec.ts`

- [ ] **Step 1: 扩展 vote-page**

在票据流程中，签发 credential 后先打开 `/t#ticket=...`：

```ts
await voter.goto("/t#ticket=" + encodeURIComponent(issuedBody.credential));
await expect(voter.getByRole("heading", { name: "E2E 票据投票页" })).toBeVisible();
await expect(voter.getByAltText("入场二维码")).toBeVisible();
await expect(voter.getByText(issuedBody.ticket.publicCode)).toBeVisible();
await voter.getByRole("link", { name: /去投票/ }).click();
await expect(voter).toHaveURL(new RegExp(`/vote/${session.id}`));
await expect(voter.getByRole("radio", { name: "alice" })).toBeVisible();
```

随后沿用现有投票/重复投票断言。活动站投票入口：

```ts
await page.goto("/e/E2E-TICKET-VOTE");
await expect(page.getByRole("link", { name: /去投票/ })).toBeVisible();
```

- [ ] **Step 2: 扩展 schedule**

在发布节目单后启动排期会话、下一位，然后打开活动站：

```ts
await page.getByRole("button", { name: "启动排期会话" }).click();
await page.getByRole("button", { name: "下一位" }).click();
await page.goto(`/e/${publicCode}`);
await expect(page.getByText(/当前：/)).toBeVisible();
await expect(page.getByText(/接下来：/)).toBeVisible();
```

- [ ] **Step 3: a11y**

公开 surfaces 增加：

```ts
await page.goto("/t");
await expect(page.locator(".ticket-page")).toBeVisible();
await assertNoBlockingViolations(page, "/t");
```

- [ ] **Step 4: 跑 E2E**

```powershell
Set-Location plus
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:NO_PROXY = "127.0.0.1,localhost,::1"
$env:no_proxy = "127.0.0.1,localhost,::1"
pnpm --filter @artflow-plus/web test:e2e -- vote-page.spec.ts schedule.spec.ts a11y.spec.ts
```

Expected：PASS。

- [ ] **Step 5: 全量门禁**

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

- [ ] **Step 6: 提交并收尾**

```bash
git add -A
git commit -m "test: cover the audience ticket experience"
```

按仓库规则合并 `feat/audience-tickets` 到 `main`，推送后盯 Gates / Security / Workflow lint 全绿。
