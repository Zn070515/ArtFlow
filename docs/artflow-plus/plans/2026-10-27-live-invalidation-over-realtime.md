# Live Invalidation over the Realtime Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Live console's invalidation hint from SSE to an `activity:<id>` realtime topic, then delete SSE and `useLiveEvents`.

**Architecture:** A new realtime topic snapshots the activity's outbox head (`max(id)`). Live subscribes only for invalidation and refetches its authoritative state over HTTP, exactly as it did with SSE. The SSE route, client hook, and stream test are removed; `/events` remains the recovery authority.

**Tech Stack:** TypeScript 7, Kysely/PostgreSQL 18, Fastify 5, TypeBox, the existing `@artflow-plus/realtime` package, React 19, Playwright.

**Spec:** `docs/artflow-plus/specs/2026-10-27-live-invalidation-over-realtime-design.md`

---

## File map

| File | Responsibility |
|---|---|
| `plus/packages/db/src/outbox.ts` | `getActivityEventHead` |
| `plus/packages/contracts/src/events.ts` | Append `ActivityEventsSnapshotSchema` to the existing event contracts |
| `plus/apps/api/src/realtime-topics.ts` | `createActivityRealtimeTopic` |
| `plus/apps/api/src/app.ts` | Register the topic; delete the SSE route |
| `plus/apps/api/test/realtime-activity.test.ts` | Topic authorize/snapshot tests |
| `plus/apps/api/test/sse.test.ts` → `events.test.ts` | Drop SSE streaming; keep `/events` |
| `plus/apps/web/src/routes/liveActivity.tsx` | Subscribe to `activity:<id>` |
| `plus/apps/web/src/hooks/useLiveEvents.ts` | Delete |
| `docs/architecture/adr/0029-live-realtime-invalidation.md` | ADR |
| `docs/architecture/adr/0027-realtime-core.md` | Update consequences |
| `docs/artflow-plus/roadmap.md` | M13 |

---

## Task 1: Outbox head read and shared schema

**Files:**
- Modify: `plus/packages/db/src/outbox.ts`
- Modify: `plus/packages/contracts/src/events.ts` (append to the existing file; it
  already owns `DomainEventEnvelopeSchema` and is already exported from the index)

- [ ] **Step 1: Add the outbox head query**

In `plus/packages/db/src/outbox.ts`, append:

```ts
/** The activity's newest outbox id, or 0 when it has no events yet. */
export async function getActivityEventHead(
  db: Kysely<Database>,
  activityId: string,
): Promise<number> {
  const row = await db.selectFrom("outbox")
    .select(({ fn }) => fn.max("id").as("head"))
    .where("activity_id", "=", activityId)
    .executeTakeFirst();
  return Number(row?.head ?? 0);
}
```

`outbox.id` is a bigserial returned as a string; `Number(...)` is required.

- [ ] **Step 2: Add the shared schema**

Append to the existing `plus/packages/contracts/src/events.ts` (it already imports
`Type`/`Static` and exports `DomainEventEnvelopeSchema`; the index already re-exports
this file):

```ts
/** The invalidation-only payload of the `activity:<id>` realtime topic. */
export const ActivityEventsSnapshotSchema = Type.Object(
  { lastSequence: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export type ActivityEventsSnapshot = Static<typeof ActivityEventsSnapshotSchema>;
```

Do not overwrite the existing `DomainEventEnvelopeSchema`.

- [ ] **Step 3: Typecheck**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus"
pnpm --filter @artflow-plus/db check
pnpm --filter @artflow-plus/contracts check
```
Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add plus/packages/db/src/outbox.ts plus/packages/contracts/src/events.ts plus/packages/contracts/src/index.ts
git commit -m "feat(realtime): add the activity event head read"
```

---

## Task 2: Activity topic and registration

**Files:**
- Modify: `plus/apps/api/src/realtime-topics.ts`
- Modify: `plus/apps/api/src/app.ts`
- Create: `plus/apps/api/test/realtime-activity.test.ts`

- [ ] **Step 1: Write the failing topic test**

`plus/apps/api/test/realtime-activity.test.ts`:

```ts
import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createActivityRealtimeTopic } from "../src/realtime-topics.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_activity_topic_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

async function activity(): Promise<string> {
  const activityId = `act-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "Live",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  return activityId;
}

async function event(activityId: string): Promise<string> {
  const row = await db.insertInto("outbox").values({
    event_id: `event-${randomUUID()}`,
    event_type: "ProbeEvent",
    payload: "{}",
    occurred_at: "2026-10-27T09:00:00Z",
    activity_id: activityId,
    aggregate_type: "activity",
    aggregate_id: activityId,
    capability: "engine",
    revision: 1,
    mode: "formal",
    scope: null,
    attempts: 0,
  }).returning("id").executeTakeFirstOrThrow();
  return String(row.id);
}

describe.skipIf(!connectionString)("activity realtime topic", () => {
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

  it("snapshots the newest outbox id and returns zero with no events", async () => {
    const activityId = await activity();
    const topic = createActivityRealtimeTopic(db);
    const target = { topic: `activity:${activityId}`, activityId, aggregateId: activityId };

    const empty = await topic.snapshot(target);
    expect(empty).toEqual({ seq: 0, data: { lastSequence: 0 } });

    const head = Number(await event(activityId));
    const snapshot = await topic.snapshot(target);
    expect(snapshot?.seq).toBe(head);
    expect(snapshot?.data).toEqual({ lastSequence: head });
  });

  it("authorizes operations permissions and the admin role", async () => {
    const activityId = await activity();
    const topic = createActivityRealtimeTopic(db);
    const target = { topic: `activity:${activityId}`, activityId, aggregateId: activityId };

    expect(
      await topic.authorize({ actorId: "p", roles: [], permissions: [] }, target),
    ).toBe(false);
    for (const permission of ["studio.manage", "competition.manage", "judge.manage"]) {
      expect(
        await topic.authorize({ actorId: "s", roles: [], permissions: [permission] }, target),
      ).toBe(true);
    }
    expect(
      await topic.authorize({ actorId: "a", roles: ["admin"], permissions: [] }, target),
    ).toBe(true);
  });

  it("returns no snapshot for an unknown activity", async () => {
    const topic = createActivityRealtimeTopic(db);
    expect(
      await topic.snapshot({ topic: "activity:nope", activityId: "nope", aggregateId: "nope" }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\api"
pnpm exec vitest run test/realtime-activity.test.ts
```
Expected: FAIL — `createActivityRealtimeTopic` is not exported.

- [ ] **Step 3: Implement the topic**

In `plus/apps/api/src/realtime-topics.ts`:

```ts
import { ActivityEventsSnapshotSchema } from "@artflow-plus/contracts";
import { getActivity, getActivityEventHead } from "@artflow-plus/db";
```

```ts
export function createActivityRealtimeTopic(db: Kysely<Database>): RealtimeTopic {
  return {
    namespace: "activity",
    parse(topic) {
      const parsed = parseTopicString(topic);
      if (parsed === null || parsed.namespace !== "activity") return null;
      return { activityId: parsed.rest, aggregateId: parsed.rest };
    },
    async authorize(actor, target) {
      if (target.activityId.length === 0) return false;
      if (actor.roles.includes("admin")) return true;
      return (
        actor.permissions.includes("*") ||
        actor.permissions.includes("studio.manage") ||
        actor.permissions.includes("competition.manage") ||
        actor.permissions.includes("judge.manage")
      );
    },
    async snapshot(target) {
      const activity = await getActivity(db, target.activityId);
      if (activity === null) return null;
      const lastSequence = await getActivityEventHead(db, target.activityId);
      return { seq: lastSequence, data: { lastSequence } };
    },
    schema: ActivityEventsSnapshotSchema,
  };
}
```

- [ ] **Step 4: Register it in `buildApp`**

In `plus/apps/api/src/app.ts`:

```ts
import { createActivityRealtimeTopic, createVotingRealtimeTopic } from "./realtime-topics.js";
```

```ts
    topics: [createVotingRealtimeTopic(db), createActivityRealtimeTopic(db)],
```

- [ ] **Step 5: Run the topic test**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\api"
pnpm check
pnpm exec vitest run test/realtime-activity.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```powershell
git add plus/apps/api/src/realtime-topics.ts plus/apps/api/src/app.ts plus/apps/api/test/realtime-activity.test.ts
git commit -m "feat(api): add the activity realtime topic"
```

---

## Task 3: Live page subscribes to the activity topic

**Files:**
- Modify: `plus/apps/web/src/routes/liveActivity.tsx`
- Delete: `plus/apps/web/src/hooks/useLiveEvents.ts`

- [ ] **Step 1: Replace the SSE hook**

In `plus/apps/web/src/routes/liveActivity.tsx`:

Remove:

```tsx
import { useLiveEvents } from "../hooks/useLiveEvents.js";
```

Add:

```tsx
import { useRealtimeTopic } from "../realtime/useRealtimeTopic.js";
```

Replace:

```tsx
  const fallback = useLiveEvents(activityId, allowed, () => {
    void queryClient.invalidateQueries({ queryKey: ["live-state", activityId] });
  });
```

with:

```tsx
  const { fallback } = useRealtimeTopic<{ lastSequence: number }>(
    allowed ? `activity:${activityId}` : null,
    () => {
      void queryClient.invalidateQueries({ queryKey: ["live-state", activityId] });
    },
  );
```

Keep the query's `refetchInterval: fallback ? 5000 : false` unchanged.

- [ ] **Step 2: Delete the hook**

```powershell
git rm plus/apps/web/src/hooks/useLiveEvents.ts
```

- [ ] **Step 3: Confirm no client-side SSE remains**

Use the Grep tool with pattern `useLiveEvents|EventSource` under `plus/apps/web/src`
and `plus/apps/api/src`. Expected: no matches.

- [ ] **Step 4: Typecheck and unit-test**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\web"
pnpm check
pnpm test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add plus/apps/web/src/routes/liveActivity.tsx plus/apps/web/src/hooks/useLiveEvents.ts
git commit -m "feat(web): move Live invalidation to the realtime core"
```

---

## Task 4: Remove the SSE route and rewrite the stream test

**Files:**
- Modify: `plus/apps/api/src/app.ts`
- Rename: `plus/apps/api/test/sse.test.ts` → `plus/apps/api/test/events.test.ts`

- [ ] **Step 1: Delete the SSE route**

In `plus/apps/api/src/app.ts`, remove the entire block:

```ts
  app.get(
    "/api/activities/:id/stream",
    ...
  );
```

Keep the `GET /api/activities/:id/events` route and `requireOperationsReader`.
Remove any now-unused imports or locals left behind by the deletion (run `pnpm check`
to find them).

- [ ] **Step 2: Rewrite the test as an events test**

Rename the file:

```powershell
git mv plus/apps/api/test/sse.test.ts plus/apps/api/test/events.test.ts
```

Replace the first test body with a cursor test (keep the setup, `releasedActivity`,
`post`, and the real `listen`/`baseUrl`):

```ts
dbIt("serves events through the HTTP cursor", async () => {
  const activityId = await releasedActivity();
  const started = await post(`/api/activities/${activityId}/executions`, {
    scope: "stage",
    mode: "formal",
  });
  expect(started.status).toBe(201);

  const first = await fetch(
    `${baseUrl}/api/activities/${activityId}/events?mode=formal&after=0`,
  );
  const feed = (await first.json()) as {
    events: { sequence: number; type: string }[];
    headCursor: number;
  };
  const startedEvent = feed.events.find((event) => event.type === "ExecutionSessionStarted");
  expect(startedEvent).toBeDefined();
  expect(startedEvent?.sequence ?? 0).toBeGreaterThan(0);

  const after = await fetch(
    `${baseUrl}/api/activities/${activityId}/events?mode=formal&after=${startedEvent?.sequence ?? 0}`,
  );
  const tail = (await after.json()) as {
    events: { sequence: number }[];
    headCursor: number;
  };
  expect(tail.events.every((event) => event.sequence > (startedEvent?.sequence ?? 0))).toBe(true);
});
```

Replace the second test:

```ts
dbIt("requires an operations session for the event feed", async () => {
  const activityId = await releasedActivity();
  const events = await anonymousApp.inject({
    method: "GET",
    url: `/api/activities/${activityId}/events`,
  });
  expect(events.statusCode).toBe(401);
});
```

- [ ] **Step 3: Run the events test and check for stale imports**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\api"
pnpm check
pnpm exec vitest run test/events.test.ts
```
Expected: PASS (2 tests); `pnpm check` has no unused-symbol or type errors.

- [ ] **Step 4: Confirm the SSE surface is gone**

Use the Grep tool with pattern `/stream|text/event-stream` under `plus/apps` and
`plus/packages` (excluding `node_modules`/`dist`). Expected: no matches.

- [ ] **Step 5: Commit**

```powershell
git add plus/apps/api/src/app.ts plus/apps/api/test/events.test.ts
git commit -m "refactor(api): retire the SSE stream route"
```

---

## Task 5: Documentation and full gates

**Files:**
- Create: `docs/architecture/adr/0029-live-realtime-invalidation.md`
- Modify: `docs/architecture/adr/0027-realtime-core.md`
- Modify: `docs/artflow-plus/roadmap.md`

- [ ] **Step 1: Write ADR-0029**

```md
# ADR-0029: Live invalidation over the realtime core

- **Status**: accepted
- **Date**: 2026-10-27

## Context

M11 added `@artflow-plus/realtime` for the voting card, but the Live console still
used SSE (`/stream` + `useLiveEvents`). Two realtime transports in one repository
contradicted the "one protected core" decision.

## Decision

- Add `activity:<activityId>`: the snapshot is the activity's newest outbox id
  (`max(id)`), and the socket carries only that invalidation cursor.
- Live subscribes and refetches its authoritative state over HTTP; the socket never
  carries Live state.
- Delete the SSE route and `useLiveEvents`; keep `/events` as the recovery
  authority.
- Authorization matches the old operations reader: studio/competition/judge manage,
  or the admin role.

## Consequences

- Live updates have up to the realtime poll interval (~1s) of latency instead of
  SSE's immediate push. Acceptable for the control console.
- One socket serves every realtime surface in the app; topics remain independent.
- The outbox `(activity_id, id)` index makes the head read cheap.
```

- [ ] **Step 2: Update ADR-0027 and the roadmap**

In `docs/architecture/adr/0027-realtime-core.md`, replace the consequence:

```md
- The Live console keeps SSE until a separate migration.
```

with:

```md
- The Live console now uses the `activity:<id>` invalidation topic; SSE has been
  retired (ADR-0029).
```

In `docs/artflow-plus/roadmap.md`, append before `## Definition of Done`:

```md
## M13 — Live on the Realtime Core（已完成，2026-10-27）

- `activity:<activityId>` 失效主题（outbox head），Live 页面改用实时模块。
- 删除 SSE `/stream` 与 `useLiveEvents`；保留 `/events` 作为恢复权威。
- 出口：topic 测试、`/events` 测试、Live E2E、全量门禁全绿。
```

- [ ] **Step 3: Run docs and gates**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow"
pwsh -NoProfile -File scripts/check_docs.ps1
$env:PYTHONIOENCODING="utf-8"
uv run pytest tests/gates -q
```
Expected: PASS.

- [ ] **Step 4: Run the full Plus gates and the Live E2E**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
Set-Location "C:\Users\16275\Desktop\ArtFlow"
pnpm -C plus run check
pnpm -C plus run test
```
Expected: PASS.

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\web"
pnpm test:e2e -- e2e/live-judge.spec.ts
```
Expected: PASS (1 test). If a wait times out at the 5s default, raise that assertion's
timeout to 10s (1s poll + REST refetch).

- [ ] **Step 5: Commit and integrate**

```powershell
git add docs/architecture/adr/0029-live-realtime-invalidation.md docs/architecture/adr/0027-realtime-core.md docs/artflow-plus/roadmap.md
git commit -m "docs: record the Live realtime migration"
git checkout artflow-plus
git merge --no-ff feat/plus-live-realtime -m "merge: Live on the realtime core"
git push origin artflow-plus
```

---

## Self-review checklist

- Spec coverage: outbox head (Task 1), topic (Task 2), Live client (Task 3), SSE
  removal/test rewrite (Task 4), docs/gates (Task 5).
- No placeholders: every step names files, commands, and expected results.
- The socket carries only `{ lastSequence }`; Live state stays on HTTP.
- `/events` and `requireOperationsReader` remain; all `/stream` and `useLiveEvents`
  references are removed and verified by grep.
- The outbox head is `Number(...)` because the bigserial column is returned as a
  string.
