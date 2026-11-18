# 现场观众伴侣实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/e/$publicCode` 变成现场观众扫码即用的活动伴侣：首屏显示现在/下一个节目，按状态给出唯一主行动，现场公告可关闭且更新后重现，投票候选显示姓名，并在活动结束、日程重发、赛果撤销、投票关闭时正确降级。

**Architecture:** 复用现有公开读，不新增聚合接口。前端按活动状态渲染三种形态（active + current、active + current 为空、closed）；`current` 15 秒轮询并以最新状态为准，活动站 60 秒轮询限定赛果撤销的可见延迟；纯函数负责行动优先级、节目匹配和候选展示名。后端只增加一个可选契约字段 `candidateName`，姓名解析与 publishing 共用同一个 DB 查询。

**Tech Stack:** Node 24、TypeScript、React 19、TanStack Query、TanStack Router、Vitest、Testing Library、Playwright、Fastify 5、Kysely、PostgreSQL 18、TypeBox。

**设计来源：** `docs/artflow-plus/specs/2026-11-18-onsite-audience-companion-design.md`

## Test architecture

本轮涉及的契约是 `PublicVoteSession` 的可选 `candidateName`，能力是 `voting` 的公开读与 `publishing` 的姓名查询复用。消费者包括公开活动站、节目单、分享、投票页，以及 `PublicEventSite`、`PublicCurrentProgram`、`PublicVoteEntry`、`PublicVoteSession` 四个读模型；不新增 route 或 event edge。生命周期覆盖 activity 的 active/closed/draft/archived、vote session 的 draft/open/closed、result release 的 active/revoked/stale、schedule release 的 active/revoked、roster final 与 formal mode 隔离。适配器不新增也不修改；姓名查询用真实 PostgreSQL 验证，组件用可控 fetch 验证降级。故障用例覆盖 current/voting 轮询拒绝、current 404、活动站刷新失败、投票关闭竞态、赛果撤销、姓名缺失，断言故障中行为与恢复后状态，不使用任意 sleep。防臃肿的做法是扩展现有活动站与节目单、删除被替代的 `EventLive`、只新增一个纯函数模块与三个展示组件，不新增路由、聚合接口、表、事件或 topic。聚焦门禁是 `check`、web/runtime/api/contracts/db 测试、`graph:check`、`audit:check`、`build:prod`、结构门禁、`check_docs` 与 Playwright 的 chromium/mobile project。

---

## 文件结构

创建：

- `plus/packages/db/src/participant-names.ts`：`participantName()` 与 `selectParticipantNames()`，供 publishing 与 voting 共用。
- `plus/apps/web/src/components/portal/onsiteActions.ts`：行动优先级、节目匹配、候选展示名、刷新文案的纯函数。
- `plus/apps/web/src/components/portal/onsiteActions.test.ts`：纯函数矩阵测试。
- `plus/apps/web/src/components/portal/NowNextCard.tsx`：现在/下一个卡片。
- `plus/apps/web/src/components/portal/NowNextCard.test.tsx`。
- `plus/apps/web/src/components/portal/OnsiteActionPanel.tsx`：主行动与次级入口。
- `plus/apps/web/src/components/portal/AnnouncementBanner.tsx`：可关闭公告。
- `plus/apps/web/src/components/portal/AnnouncementBanner.test.tsx`。
- `plus/apps/web/src/components/portal/EventProgram.test.tsx`。
- `plus/apps/web/src/components/portal/EventShare.test.tsx`。
- `plus/apps/web/src/hooks/useOnlineStatus.ts` 与 `.test.tsx`。
- `plus/apps/api/scripts/seed-onsite-audience.ts`：E2E 幂等种子。
- `plus/apps/web/e2e/onsite-audience.spec.ts`。

修改：

- `plus/packages/contracts/src/voting.ts`：公开候选增加可选 `candidateName`。
- `plus/packages/db/src/index.ts`：导出 `participant-names.js`。
- `plus/packages/db/src/publishing-repository.ts`：改用共享姓名查询。
- `plus/packages/runtime/src/voting-read-service.ts`：补 `candidateName`。
- `plus/apps/api/test/public-vote.test.ts`：姓名解析失败/成功用例。
- `plus/apps/api/package.json`：`seed:e2e` 追加新种子。
- `plus/apps/web/src/routes/vote.tsx`：候选展示名。
- `plus/apps/web/src/routes/publicEvent.tsx`：三态编排、轮询、降级。
- `plus/apps/web/src/routes/publicEvent.test.tsx`：新状态矩阵。
- `plus/apps/web/src/components/portal/EventProgram.tsx`：当前项高亮与「回到现在」。
- `plus/apps/web/src/components/portal/EventHero.tsx`：`compact` 变体。
- `plus/apps/web/src/components/portal/EventShare.tsx`：规范 URL 与二维码。
- `plus/apps/web/src/styles/portal-event.css`：新组件样式与移动端 44px。
- `plus/apps/web/e2e/mobile.spec.ts`：加入 `/e/E2E-ONSITE`。
- `plus/apps/web/e2e/a11y.spec.ts`：加入 `/e/E2E-ONSITE`。

删除：

- `plus/apps/web/src/components/portal/EventLive.tsx`。

---

### Task 1: 投票候选显示名（契约 + DB + 运行时）

**Files:**
- Modify: `plus/packages/contracts/src/voting.ts:109-137`
- Create: `plus/packages/db/src/participant-names.ts`
- Modify: `plus/packages/db/src/index.ts:9`
- Modify: `plus/packages/db/src/publishing-repository.ts:24-35, 475-490`
- Modify: `plus/packages/runtime/src/voting-read-service.ts:13-15, 80-94, 118-136`
- Test: `plus/apps/api/test/public-vote.test.ts`

- [ ] **Step 1: 写失败测试**

在 `plus/apps/api/test/public-vote.test.ts` 的 `describe.skipIf(!connectionString)` 内、`it("returns activity, candidates, rules, and no counts", ...)` 之后加入：

```ts
  it("resolves candidate display names from registrations without inventing one", async () => {
    const { activityId, sessionId } = await seed();
    await db.insertInto("registration").values({
      id: "registration-alice",
      activity_id: activityId,
      participant_id: "alice",
      questionnaire_version: "v1",
      questionnaire_hash: "hash",
      status: "approved",
      answers: JSON.stringify({ name: "林晓" }),
      revision: 1,
      reviewed_by: null,
    }).execute();

    const response = await app.inject({
      method: "GET",
      url: `/api/public/vote/${sessionId}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { candidates: readonly Record<string, unknown>[] };
    expect(body.candidates[0]).toMatchObject({ candidateId: "alice", candidateName: "林晓" });
    expect(body.candidates[1]).not.toHaveProperty("candidateName");
  });
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus --filter @artflow-plus/api exec vitest run test/public-vote.test.ts
```

Expected: FAIL；`candidates[0]` 只有 `candidateId`，没有 `candidateName`。

- [ ] **Step 3: 增加契约字段**

在 `plus/packages/contracts/src/voting.ts` 的 `PublicVoteSessionSchema` 里，把候选对象改成：

```ts
    candidates: Type.Array(
      Type.Object(
        {
          optionId: Type.String({ minLength: 1, maxLength: 100 }),
          candidateId: Type.String({ minLength: 1, maxLength: 100 }),
          candidateName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        },
        { additionalProperties: false },
      ),
    ),
```

- [ ] **Step 4: 创建共享姓名查询**

创建 `plus/packages/db/src/participant-names.ts`：

```ts
import type { Kysely } from "kysely";

import type { Database } from "./types.js";

function json(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

/** Names are presentation data; the id is always a safe fallback. */
export function participantName(answers: unknown, fallback: string): string {
  const parsed = json(answers);
  if (parsed === null || typeof parsed !== "object") return fallback;
  for (const key of ["name", "displayName", "title", "program"]) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return fallback;
}

export async function selectParticipantNames(
  db: Kysely<Database>,
  activityId: string,
  participantIds: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (participantIds.length === 0) return names;
  const rows = await db
    .selectFrom("registration")
    .select(["participant_id", "answers"])
    .where("activity_id", "=", activityId)
    .where("participant_id", "in", [...participantIds])
    .execute();
  for (const row of rows) {
    names.set(row.participant_id, participantName(row.answers, row.participant_id));
  }
  return names;
}
```

在 `plus/packages/db/src/index.ts` 的 `export * from "./publishing-repository.js";` 之前加入：

```ts
export * from "./participant-names.js";
```

- [ ] **Step 5: 让 publishing 复用共享查询**

在 `plus/packages/db/src/publishing-repository.ts` 顶部加入：

```ts
import { selectParticipantNames } from "./participant-names.js";
```

删除文件内的私有 `participantName` 函数（`function participantName(...) { ... }`）。把 `selectPublicResults` 里的姓名查询块：

```ts
  const names = new Map<string, string>();
  if (contestantIds.size > 0) {
    const registrations = await db.selectFrom("registration")
      .select(["participant_id", "answers"])
      .where("activity_id", "=", activity.id)
      .where("participant_id", "in", [...contestantIds])
      .execute();
    for (const registration of registrations) {
      names.set(registration.participant_id, participantName(registration.answers, registration.participant_id));
    }
  }
```

替换为：

```ts
  const names = await selectParticipantNames(db, activity.id, [...contestantIds]);
```

- [ ] **Step 6: 运行时补 `candidateName`**

在 `plus/packages/runtime/src/voting-read-service.ts` 的 import 中加入：

```ts
  selectParticipantNames,
```

把 `PublicVoteSessionState` 的候选类型改成：

```ts
  readonly candidates: readonly {
    readonly optionId: string;
    readonly candidateId: string;
    readonly candidateName?: string;
  }[];
```

在 `const options = await listVoteOptions(db, sessionId);` 之后加入：

```ts
  const candidateNames = await selectParticipantNames(
    db,
    activity.id,
    options.map((option) => option.candidateId),
  );
```

把 `candidates:` 映射改成：

```ts
    candidates: options.map((option) => {
      const name = candidateNames.get(option.candidateId);
      return {
        optionId: option.id,
        candidateId: option.candidateId,
        ...(name === undefined || name === option.candidateId ? {} : { candidateName: name }),
      };
    }),
```

- [ ] **Step 7: 运行聚焦测试**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus --filter @artflow-plus/api exec vitest run test/public-vote.test.ts
pnpm -C plus --filter @artflow-plus/db test
pnpm -C plus --filter @artflow-plus/contracts test
```

Expected: 全部 PASS。

- [ ] **Step 8: 提交**

```bash
git add plus/packages/contracts/src/voting.ts plus/packages/db/src/participant-names.ts plus/packages/db/src/index.ts plus/packages/db/src/publishing-repository.ts plus/packages/runtime/src/voting-read-service.ts plus/apps/api/test/public-vote.test.ts
git commit -m "feat(voting): resolve public candidate display names"
```

---

### Task 2: Web 纯函数

**Files:**
- Create: `plus/apps/web/src/components/portal/onsiteActions.ts`
- Test: `plus/apps/web/src/components/portal/onsiteActions.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `plus/apps/web/src/components/portal/onsiteActions.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import {
  deriveOnsiteActions,
  displayCandidateName,
  formatFreshness,
  looksOpaqueId,
  matchCurrentProgramOrder,
} from "./onsiteActions.js";

const base = {
  siteStatus: "active" as const,
  hasCurrent: true,
  voteOpen: false,
  hasResults: false,
  registrationOpen: false,
};

describe("deriveOnsiteActions", () => {
  it("prioritizes an open vote over results and registration", () => {
    expect(deriveOnsiteActions({ ...base, voteOpen: true, hasResults: true, registrationOpen: true }))
      .toEqual({ live: true, primary: "vote" });
  });

  it("falls back to results when the vote is closed", () => {
    expect(deriveOnsiteActions({ ...base, hasResults: true, registrationOpen: true }))
      .toEqual({ live: true, primary: "results" });
  });

  it("offers registration only while active", () => {
    expect(deriveOnsiteActions({ ...base, registrationOpen: true }))
      .toEqual({ live: true, primary: "join" });
  });

  it("never shows vote or registration on a closed activity", () => {
    expect(deriveOnsiteActions({
      ...base,
      siteStatus: "closed",
      voteOpen: true,
      registrationOpen: true,
      hasResults: true,
    })).toEqual({ live: false, primary: "results" });
  });

  it("does not claim live without a current entry", () => {
    expect(deriveOnsiteActions({ ...base, hasCurrent: false, voteOpen: true }))
      .toEqual({ live: false, primary: "vote" });
  });

  it("lets the fresher current status close both the live view and the vote", () => {
    expect(deriveOnsiteActions({
      ...base,
      currentStatus: "closed",
      voteOpen: true,
      registrationOpen: true,
    })).toEqual({ live: false, primary: null });
  });
});

describe("matchCurrentProgramOrder", () => {
  const entries = [
    { order: 1, name: "林晓", song: "《后来》" },
    { order: 2, name: "周然", song: "《起风了》" },
  ];

  it("matches by order first", () => {
    expect(matchCurrentProgramOrder(entries, { order: 2, title: "别的名字", slotLabel: "别的歌" })).toBe(2);
  });

  it("falls back to name and song after a schedule re-release", () => {
    expect(matchCurrentProgramOrder(
      [{ order: 9, name: "周然", song: "《起风了》" }],
      { order: 2, title: "周然", slotLabel: "《起风了》" },
    )).toBe(9);
  });

  it("returns null instead of guessing", () => {
    expect(matchCurrentProgramOrder(entries, { order: 7, title: "无", slotLabel: "" })).toBeNull();
    expect(matchCurrentProgramOrder(entries, null)).toBeNull();
  });
});

describe("displayCandidateName", () => {
  it("prefers the resolved name", () => {
    expect(displayCandidateName({ candidateId: "alice", candidateName: "林晓" }, 1)).toBe("林晓");
  });

  it("keeps readable organizer text", () => {
    expect(displayCandidateName({ candidateId: "alice" }, 2)).toBe("alice");
  });

  it("never prints an opaque internal id", () => {
    expect(displayCandidateName({ candidateId: "acct_0123456789abcdef01234567" }, 3)).toBe("候选 3");
    expect(displayCandidateName({ candidateId: "550e8400-e29b-41d4-a716-446655440000" }, 4)).toBe("候选 4");
  });
});

describe("looksOpaqueId", () => {
  it("recognizes prefixed hashes and UUIDs", () => {
    expect(looksOpaqueId("part_0123456789abcdef01234567")).toBe(true);
    expect(looksOpaqueId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(looksOpaqueId("alice")).toBe(false);
    expect(looksOpaqueId("张三")).toBe(false);
  });
});

describe("formatFreshness", () => {
  it("describes relative freshness without the client clock", () => {
    expect(formatFreshness(undefined, 0)).toBe("");
    expect(formatFreshness(1_000, 5_000)).toBe("刚刚更新");
    expect(formatFreshness(1_000, 31_000)).toBe("30 秒前更新");
    expect(formatFreshness(0, 125_000)).toBe("2 分钟前更新");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/portal/onsiteActions.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纯函数**

创建 `plus/apps/web/src/components/portal/onsiteActions.ts`：

```ts
export interface OnsiteActionInput {
  readonly siteStatus: "active" | "closed";
  readonly currentStatus?: "active" | "closed";
  readonly hasCurrent: boolean;
  readonly voteOpen: boolean;
  readonly hasResults: boolean;
  readonly registrationOpen: boolean;
}

export type OnsitePrimary = "vote" | "results" | "join" | null;

export interface OnsiteActionsState {
  readonly live: boolean;
  readonly primary: OnsitePrimary;
}

export function deriveOnsiteActions(input: OnsiteActionInput): OnsiteActionsState {
  const status = input.currentStatus ?? input.siteStatus;
  const live = status === "active" && input.hasCurrent;
  if (status === "active" && input.voteOpen) return { live, primary: "vote" };
  if (input.hasResults) return { live, primary: "results" };
  if (status === "active" && input.registrationOpen) return { live, primary: "join" };
  return { live, primary: null };
}

export interface ProgramMatchEntry {
  readonly order: number;
  readonly name: string;
  readonly song: string;
}

export interface CurrentProgramMatch {
  readonly order: number;
  readonly title: string;
  readonly slotLabel: string;
}

export function matchCurrentProgramOrder(
  entries: readonly ProgramMatchEntry[],
  current: CurrentProgramMatch | null,
): number | null {
  if (current === null) return null;
  const byOrder = entries.find((entry) => entry.order === current.order);
  if (byOrder !== undefined) return byOrder.order;
  const byName = entries.find(
    (entry) => entry.name === current.title && entry.song === current.slotLabel,
  );
  return byName?.order ?? null;
}

export interface CandidateDisplay {
  readonly candidateId: string;
  readonly candidateName?: string;
}

const opaquePrefixed = /^[a-z][a-z0-9]*_[0-9a-f]{16,}$/i;
const opaqueUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function looksOpaqueId(value: string): boolean {
  return opaquePrefixed.test(value) || opaqueUuid.test(value);
}

export function displayCandidateName(candidate: CandidateDisplay, ordinal: number): string {
  const resolved = candidate.candidateName?.trim() ?? "";
  if (resolved !== "") return resolved;
  return looksOpaqueId(candidate.candidateId) ? `候选 ${ordinal}` : candidate.candidateId;
}

export function formatFreshness(updatedAt: number | undefined, now: number): string {
  if (updatedAt === undefined || !Number.isFinite(updatedAt)) return "";
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1_000));
  if (seconds < 10) return "刚刚更新";
  if (seconds < 60) return `${seconds} 秒前更新`;
  return `${Math.floor(seconds / 60)} 分钟前更新`;
}
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/portal/onsiteActions.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add plus/apps/web/src/components/portal/onsiteActions.ts plus/apps/web/src/components/portal/onsiteActions.test.ts
git commit -m "feat(portal): derive on-site audience actions"
```

---

### Task 3: 投票页候选展示名

**Files:**
- Modify: `plus/apps/web/src/routes/vote.tsx:1-12, 205-235`

- [ ] **Step 1: 接入纯函数**

在 `plus/apps/web/src/routes/vote.tsx` 的组件 import 区加入：

```ts
import { displayCandidateName } from "../components/portal/onsiteActions.js";
```

把候选渲染：

```tsx
                  {session.candidates.map((candidate) => (
                    <li key={candidate.optionId}>
                      <label className="vote-candidate">
                        <input
                          type={session.selectionType === "single" ? "radio" : "checkbox"}
                          name="candidate"
                          checked={selected.includes(candidate.optionId)}
                          onChange={() => toggle(candidate.optionId)}
                        />
                        <span>{candidate.candidateId}</span>
                      </label>
                    </li>
                  ))}
```

替换为：

```tsx
                  {session.candidates.map((candidate, index) => (
                    <li key={candidate.optionId}>
                      <label className="vote-candidate">
                        <input
                          type={session.selectionType === "single" ? "radio" : "checkbox"}
                          name="candidate"
                          checked={selected.includes(candidate.optionId)}
                          onChange={() => toggle(candidate.optionId)}
                        />
                        <span>{displayCandidateName(candidate, index + 1)}</span>
                      </label>
                    </li>
                  ))}
```

- [ ] **Step 2: 类型检查**

```powershell
pnpm -C plus --filter @artflow-plus/web run check
```

Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add plus/apps/web/src/routes/vote.tsx
git commit -m "feat(portal): show vote candidate names"
```

---

### Task 4: 现场卡片、行动卡与公告条

**Files:**
- Create: `plus/apps/web/src/components/portal/NowNextCard.tsx`
- Create: `plus/apps/web/src/components/portal/NowNextCard.test.tsx`
- Create: `plus/apps/web/src/components/portal/OnsiteActionPanel.tsx`
- Create: `plus/apps/web/src/components/portal/AnnouncementBanner.tsx`
- Create: `plus/apps/web/src/components/portal/AnnouncementBanner.test.tsx`
- Modify: `plus/apps/web/src/styles/portal-event.css`

- [ ] **Step 1: 写 NowNextCard 失败测试**

创建 `plus/apps/web/src/components/portal/NowNextCard.test.tsx`：

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NowNextCard } from "./NowNextCard.js";

describe("NowNextCard", () => {
  it("renders the current performance, next entries and freshness", () => {
    render(
      <NowNextCard
        current={{ order: 2, slotLabel: "《起风了》", title: "周然", note: "", startsAt: null }}
        next={[{ order: 3, slotLabel: "《晴天》", title: "陈默", note: "", startsAt: null }]}
        total={3}
        updatedAt={Date.now()}
        onRefresh={() => undefined}
        refreshing={false}
      />,
    );

    expect(screen.getByText("周然")).toBeInTheDocument();
    expect(screen.getByText("《起风了》")).toBeInTheDocument();
    expect(screen.getByText("下一个：陈默")).toBeInTheDocument();
    expect(screen.getByText("刚刚更新")).toBeInTheDocument();
    expect(screen.getByText(/NOW · 02 \/ 3/)).toBeInTheDocument();
  });

  it("asks for a refresh without pretending the data is fresh", () => {
    const onRefresh = vi.fn();
    render(
      <NowNextCard
        current={{ order: 1, slotLabel: "", title: "林晓", note: "", startsAt: null }}
        next={[]}
        total={null}
        updatedAt={undefined}
        onRefresh={onRefresh}
        refreshing={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/更新/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/portal/NowNextCard.test.tsx
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 NowNextCard**

创建 `plus/apps/web/src/components/portal/NowNextCard.tsx`：

```tsx
import { useEffect, useState } from "react";

import type { PublicScheduleEntry } from "../../api/tickets-public.js";
import { formatFreshness } from "./onsiteActions.js";

export interface NowNextCardProps {
  readonly current: PublicScheduleEntry;
  readonly next: readonly PublicScheduleEntry[];
  readonly total: number | null;
  readonly updatedAt: number | undefined;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}

export function NowNextCard(props: NowNextCardProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const position = String(props.current.order).padStart(2, "0");
  const total = props.total !== null && props.total > 0 ? ` / ${props.total}` : "";
  const freshness = formatFreshness(props.updatedAt, now);
  const upcoming = props.next.slice(0, 2);
  return (
    <section className="event-now" id="live" aria-labelledby="event-now-label">
      <div className="event-now__head">
        <p className="eyebrow" id="event-now-label">NOW · 现场</p>
        {freshness === "" ? null : <span className="event-now__freshness">{freshness}</span>}
      </div>
      <p className="event-now__position">NOW · {position}{total}</p>
      <p className="event-now__name" aria-live="polite">{props.current.title}</p>
      {props.current.slotLabel === "" ? null : (
        <p className="event-now__song">{props.current.slotLabel}</p>
      )}
      {upcoming.length === 0 ? null : (
        <p className="event-now__next">
          下一个：{upcoming.map((entry) => entry.title).join(" · ")}
        </p>
      )}
      <button
        type="button"
        className="event-button event-button--ghost event-now__refresh"
        onClick={props.onRefresh}
        disabled={props.refreshing}
      >
        {props.refreshing ? "刷新中…" : "刷新"}
      </button>
    </section>
  );
}
```

- [ ] **Step 4: 运行 NowNextCard 测试**

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/portal/NowNextCard.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 写公告条失败测试**

创建 `plus/apps/web/src/components/portal/AnnouncementBanner.test.tsx`：

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { AnnouncementBanner } from "./AnnouncementBanner.js";

describe("AnnouncementBanner", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("dismisses until the announcement text changes", () => {
    const { rerender } = render(
      <AnnouncementBanner publicCode="SPRING-1" announcement="第 8 位选手请到后台候场" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭公告" }));
    expect(screen.queryByText("第 8 位选手请到后台候场")).not.toBeInTheDocument();

    rerender(<AnnouncementBanner publicCode="SPRING-1" announcement="第 8 位选手请到后台候场" />);
    expect(screen.queryByText("第 8 位选手请到后台候场")).not.toBeInTheDocument();

    rerender(<AnnouncementBanner publicCode="SPRING-1" announcement="决赛结果将在 20:30 公布" />);
    expect(screen.getByText("决赛结果将在 20:30 公布")).toBeInTheDocument();
  });

  it("renders nothing for an empty announcement", () => {
    const { container } = render(<AnnouncementBanner publicCode="SPRING-1" announcement="  " />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 6: 运行公告失败测试**

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/portal/AnnouncementBanner.test.tsx
```

Expected: FAIL，模块不存在。

- [ ] **Step 7: 实现公告条**

创建 `plus/apps/web/src/components/portal/AnnouncementBanner.tsx`：

```tsx
import { useEffect, useState } from "react";

export interface AnnouncementBannerProps {
  readonly publicCode: string;
  readonly announcement: string;
}

function storageKey(publicCode: string): string {
  return `artflow.announcement.${publicCode}`;
}

function dismissedText(publicCode: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(publicCode));
  } catch {
    return null;
  }
}

function rememberDismissed(publicCode: string, text: string): void {
  try {
    window.sessionStorage.setItem(storageKey(publicCode), text);
  } catch {
    // Private mode: showing the announcement again is the safe fallback.
  }
}

export function AnnouncementBanner({ publicCode, announcement }: AnnouncementBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(dismissedText(publicCode) === announcement);
  }, [publicCode, announcement]);
  if (announcement.trim() === "" || dismissed) return null;
  return (
    <aside className="event-announcement event-announcement--banner" role="note" aria-label="现场公告">
      <p className="event-announcement__text">{announcement}</p>
      <button
        type="button"
        className="event-announcement__close"
        aria-label="关闭公告"
        onClick={() => {
          rememberDismissed(publicCode, announcement);
          setDismissed(true);
        }}
      >
        ×
      </button>
    </aside>
  );
}
```

- [ ] **Step 8: 实现行动卡**

创建 `plus/apps/web/src/components/portal/OnsiteActionPanel.tsx`：

```tsx
import { Link } from "@tanstack/react-router";

import { EventShare } from "./EventShare.js";

export interface OnsiteActionsProps {
  readonly primary: "vote" | "results" | "join" | null;
  readonly publicCode: string;
  readonly eventTitle: string;
  readonly voteSessionId: string | null;
  readonly hasProgram: boolean;
}

export function OnsiteActions(props: OnsiteActionsProps) {
  return (
    <section className="event-onsite-actions" aria-label="现场操作">
      {props.primary === "vote" && props.voteSessionId !== null ? (
        <a
          className="event-button event-button--primary"
          href={`/vote/${encodeURIComponent(props.voteSessionId)}`}
        >
          投票进行中 · 去投票
        </a>
      ) : null}
      {props.primary === "results" ? (
        <Link
          className="event-button event-button--primary"
          to="/results/$publicCode"
          params={{ publicCode: props.publicCode }}
        >
          查看赛果
        </Link>
      ) : null}
      {props.primary === "join" ? (
        <Link
          className="event-button event-button--primary"
          to="/join/$publicCode"
          params={{ publicCode: props.publicCode }}
        >
          立即报名
        </Link>
      ) : null}
      {props.hasProgram ? (
        <a className="event-button event-button--ghost" href="#program">节目单</a>
      ) : null}
      <EventShare title={props.eventTitle} publicCode={props.publicCode} />
    </section>
  );
}
```

- [ ] **Step 9: 加入样式**

在 `plus/apps/web/src/styles/portal-event.css` 的 `.event-announcement` 规则之后加入：

```css
.event-now {
  margin: 20px 0 0;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 12px;
}

.event-now--idle {
  border-style: dashed;
}

.event-now__head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: baseline;
}

.event-now__freshness,
.event-now__position {
  color: var(--bone-subtle);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
}

.event-now__position {
  margin: 8px 0 0;
  color: var(--gold);
}

.event-now__name {
  margin: 6px 0 0;
  font-family: var(--display);
  font-size: clamp(1.8rem, 6vw, 2.8rem);
  line-height: 1.1;
}

.event-now__song,
.event-now__next {
  margin: 6px 0 0;
  color: var(--bone-dim);
}

.event-now__refresh {
  margin-top: 12px;
}

.event-now__error {
  margin: 10px 0 0;
  color: var(--bone-dim);
  font-size: 0.85rem;
}

.event-onsite-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin: 20px 0 0;
}

.event-network {
  margin: 12px 0 0;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--bone-dim);
  font-size: 0.85rem;
}

.event-announcement--banner {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.event-announcement__text {
  margin: 0;
}

.event-announcement__close {
  flex: none;
  min-width: 40px;
  min-height: 40px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 1.2rem;
  cursor: pointer;
}

.event-program__row--current {
  background: var(--gold-soft);
}

.event-program__now {
  margin-left: 8px;
  color: var(--gold);
  font-size: 0.75rem;
  letter-spacing: 0.12em;
}

@media (max-width: 767px) {
  .event-button,
  .event-now__refresh,
  .event-announcement__close {
    min-height: 44px;
  }

  .event-anchor-nav a,
  .event-link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }
}
```

- [ ] **Step 10: 运行组件测试**

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/portal/NowNextCard.test.tsx src/components/portal/AnnouncementBanner.test.tsx
```

Expected: PASS。

- [ ] **Step 11: 提交**

```bash
git add plus/apps/web/src/components/portal/NowNextCard.tsx plus/apps/web/src/components/portal/NowNextCard.test.tsx plus/apps/web/src/components/portal/OnsiteActionPanel.tsx plus/apps/web/src/components/portal/AnnouncementBanner.tsx plus/apps/web/src/components/portal/AnnouncementBanner.test.tsx plus/apps/web/src/styles/portal-event.css
git commit -m "feat(portal): add the on-site now card, actions and announcement"
```

---

### Task 5: 节目单高亮与紧凑 Hero

**Files:**
- Modify: `plus/apps/web/src/components/portal/EventProgram.tsx`
- Test: `plus/apps/web/src/components/portal/EventProgram.test.tsx`
- Modify: `plus/apps/web/src/components/portal/EventHero.tsx`

- [ ] **Step 1: 写节目单失败测试**

创建 `plus/apps/web/src/components/portal/EventProgram.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PublicEventSite } from "../../api/publicEvent.js";
import { EventProgram } from "./EventProgram.js";

const site: PublicEventSite = {
  activity: {
    publicCode: "SPRING-1",
    title: "春日声场",
    status: "active",
    registrationEnabled: false,
    registrationOpen: false,
  },
  profile: {
    tagline: "",
    description: "",
    venue: "",
    startsAt: null,
    endsAt: null,
    organizer: "",
    contact: "",
    announcement: "",
  },
  schedule: {
    entries: [
      { order: 1, slotLabel: "开场", title: "开场舞", note: "", startsAt: null },
      { order: 2, slotLabel: "第一首", title: "林晓", note: "", startsAt: null },
    ],
  },
  program: null,
  results: null,
};

describe("EventProgram", () => {
  it("marks the current entry and offers a return anchor", () => {
    const { container } = render(<EventProgram site={site} currentOrder={2} />);
    const current = container.querySelector('[aria-current="true"]');
    expect(current).not.toBeNull();
    expect(current).toHaveTextContent("林晓");
    expect(current).toHaveTextContent("现在");
    expect(screen.getByRole("button", { name: "回到现在" })).toBeInTheDocument();
  });

  it("does not guess when the current entry is missing", () => {
    const { container } = render(<EventProgram site={site} currentOrder={null} />);
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "回到现在" })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/portal/EventProgram.test.tsx
```

Expected: FAIL，`currentOrder` 未生效。

- [ ] **Step 3: 实现节目单高亮**

把 `plus/apps/web/src/components/portal/EventProgram.tsx` 改成：

```tsx
import { useRef, useState } from "react";

import type { PublicEventSite } from "../../api/publicEvent.js";

function formatEntryTime(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function EventProgram({
  site,
  currentOrder = null,
}: {
  readonly site: PublicEventSite;
  readonly currentOrder?: number | null;
}) {
  const [hostMode, setHostMode] = useState(false);
  const currentRow = useRef<HTMLLIElement>(null);
  const schedule = site.schedule;
  const program = site.program;
  if (schedule === null && (program === null || program.entries.length === 0)) return null;
  const entries = schedule !== null ? schedule.entries : program?.entries ?? [];
  const hasCurrent = currentOrder !== null && entries.some((entry) => entry.order === currentOrder);

  function scrollToCurrent(): void {
    const row = currentRow.current;
    if (row !== null && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  return (
    <section className="event-section" id="program" aria-labelledby="event-program-title">
      <div className="event-section__head">
        <h2 className="event-section__title" id="event-program-title">
          节目单
        </h2>
        <div className="event-section__actions">
          {hasCurrent ? (
            <button type="button" className="event-button event-button--ghost" onClick={scrollToCurrent}>
              回到现在
            </button>
          ) : null}
          <label className="event-toggle">
            <input
              type="checkbox"
              checked={hostMode}
              onChange={(event) => setHostMode(event.target.checked)}
            />
            主持大字
          </label>
          <button
            type="button"
            className="event-button event-button--ghost"
            onClick={() => window.print()}
          >
            打印
          </button>
        </div>
      </div>
      <ol className={hostMode ? "event-program event-program--host" : "event-program"}>
        {schedule !== null
          ? schedule.entries.map((entry) => {
              const current = entry.order === currentOrder;
              return (
                <li
                  className={current ? "event-program__row event-program__row--current" : "event-program__row"}
                  aria-current={current ? "true" : undefined}
                  ref={current ? currentRow : undefined}
                  key={`${entry.order}-${entry.title}`}
                >
                  <span className="event-program__time">
                    {formatEntryTime(entry.startsAt) || entry.slotLabel}
                  </span>
                  <span className="event-program__title">
                    {entry.title}
                    {current ? <span className="event-program__now">现在</span> : null}
                  </span>
                  {entry.note === "" ? null : (
                    <span className="event-program__note">{entry.note}</span>
                  )}
                </li>
              );
            })
          : program?.entries.map((entry) => {
              const current = entry.order === currentOrder;
              return (
                <li
                  className={current ? "event-program__row event-program__row--current" : "event-program__row"}
                  aria-current={current ? "true" : undefined}
                  ref={current ? currentRow : undefined}
                  key={`${entry.order}-${entry.name}`}
                >
                  <span className="event-program__time">{formatEntryTime(entry.startsAt)}</span>
                  <span className="event-program__title">
                    {entry.name}
                    {current ? <span className="event-program__now">现在</span> : null}
                  </span>
                  {entry.song === "" ? null : (
                    <span className="event-program__note">{entry.song}</span>
                  )}
                  {entry.note === "" ? null : (
                    <span className="event-program__note">{entry.note}</span>
                  )}
                </li>
              );
            })}
      </ol>
    </section>
  );
}
```

- [ ] **Step 4: 运行节目单测试**

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/portal/EventProgram.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 增加紧凑 Hero**

在 `plus/apps/web/src/components/portal/EventHero.tsx` 的 `EventHeroProps` 中加入：

```ts
  readonly compact?: boolean;
```

在 `EventHero` 函数体开头、`const time = ...` 之前加入：

```tsx
  if (props.compact === true) {
    return (
      <header className="event-hero event-hero--compact">
        <p className="eyebrow">LIVE · 进行中</p>
        <h1 className="event-hero__title">{props.title}</h1>
        {meta.length === 0 ? null : <p className="event-hero__meta">{meta.join(" · ")}</p>}
      </header>
    );
  }
```

注意：`meta` 在 `time` 之后计算，因此把这条 `if` 放在 `const meta = ...` 之后、`const showResults = ...` 之前。

在 `plus/apps/web/src/styles/portal-event.css` 的 `.event-hero` 之后加入：

```css
.event-hero--compact {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 16px;
  padding: 20px 0 16px;
}

.event-hero--compact .event-hero__title {
  font-size: clamp(1.4rem, 4vw, 2rem);
  letter-spacing: -0.01em;
}

.event-hero--compact .event-hero__meta {
  margin: 0;
  font-size: 0.8rem;
}
```

- [ ] **Step 6: 类型检查**

```powershell
pnpm -C plus --filter @artflow-plus/web run check
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add plus/apps/web/src/components/portal/EventProgram.tsx plus/apps/web/src/components/portal/EventProgram.test.tsx plus/apps/web/src/components/portal/EventHero.tsx plus/apps/web/src/styles/portal-event.css
git commit -m "feat(portal): highlight the current program entry"
```

---

### Task 6: 分享与现场二维码

**Files:**
- Modify: `plus/apps/web/src/components/portal/EventShare.tsx`
- Test: `plus/apps/web/src/components/portal/EventShare.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `plus/apps/web/src/components/portal/EventShare.test.tsx`：

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("qrcode", () => ({
  toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,QR"),
}));

import { EventShare } from "./EventShare.js";

describe("EventShare", () => {
  it("opens a QR code for the canonical event URL", async () => {
    render(<EventShare title="春日声场" publicCode="SPRING-1" />);
    fireEvent.click(screen.getByRole("button", { name: "二维码" }));
    const image = await screen.findByAltText("春日声场 活动二维码");
    expect(image).toHaveAttribute("src", "data:image/png;base64,QR");
    expect(screen.getByText("http://localhost:3000/e/SPRING-1")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/portal/EventShare.test.tsx
```

Expected: FAIL，没有「二维码」按钮。

- [ ] **Step 3: 实现规范 URL 与二维码**

把 `plus/apps/web/src/components/portal/EventShare.tsx` 改成：

```tsx
import * as QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";

type ShareState = "idle" | "copied" | "error";

function canonicalUrl(publicCode: string): string {
  return new URL(`/e/${encodeURIComponent(publicCode)}`, window.location.origin).toString();
}

export function EventShare({ title, publicCode }: { readonly title: string; readonly publicCode: string }) {
  const [status, setStatus] = useState<ShareState>("idle");
  const [qrOpen, setQrOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || typeof dialog.showModal !== "function") return;
    if (qrOpen && !dialog.open) dialog.showModal();
    if (!qrOpen && dialog.open) dialog.close();
  }, [qrOpen]);

  useEffect(() => {
    if (!qrOpen) return;
    let cancelled = false;
    void QRCode.toDataURL(canonicalUrl(publicCode), { margin: 1, width: 240 })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [qrOpen, publicCode]);

  async function share(): Promise<void> {
    const url = canonicalUrl(publicCode);
    const nativeShare = navigator.share as
      | ((data: { readonly title: string; readonly url: string }) => Promise<void>)
      | undefined;
    try {
      if (typeof nativeShare === "function") {
        await nativeShare({ title, url });
        return;
      }
      if (navigator.clipboard === undefined) {
        setStatus("error");
        window.setTimeout(() => setStatus("idle"), 2000);
        return;
      }
      await navigator.clipboard.writeText(url);
      setStatus("copied");
      window.setTimeout(() => setStatus("idle"), 2000);
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
      <button type="button" className="event-button event-button--ghost" onClick={() => setQrOpen(true)}>
        二维码
      </button>
      <span className="event-share-status" role="status">
        {status === "copied" ? "链接已复制" : status === "error" ? "复制失败，请手动复制地址" : ""}
      </span>
      <dialog
        ref={dialogRef}
        className="event-qr-dialog"
        aria-labelledby="event-qr-title"
        onClose={() => setQrOpen(false)}
      >
        <h2 className="event-qr-dialog__title" id="event-qr-title">现场二维码</h2>
        {qr === null ? (
          <p>正在生成…</p>
        ) : (
          <img src={qr} alt={`${title} 活动二维码`} width={240} height={240} />
        )}
        <p className="event-qr-dialog__url">{canonicalUrl(publicCode)}</p>
        <button type="button" className="event-button" onClick={() => dialogRef.current?.close()}>
          关闭
        </button>
      </dialog>
    </>
  );
}
```

在 `plus/apps/web/src/styles/portal-event.css` 末尾加入：

```css
.event-qr-dialog {
  max-width: min(92vw, 360px);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 24px;
  background: var(--bone);
  color: var(--accent-ink);
  text-align: center;
}

.event-qr-dialog__title {
  margin: 0 0 12px;
  font-size: 1.1rem;
}

.event-qr-dialog__url {
  margin: 12px 0;
  font-size: 0.75rem;
  word-break: break-all;
}
```

- [ ] **Step 4: 运行测试**

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/portal/EventShare.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add plus/apps/web/src/components/portal/EventShare.tsx plus/apps/web/src/components/portal/EventShare.test.tsx plus/apps/web/src/styles/portal-event.css
git commit -m "feat(portal): share the canonical event URL and QR code"
```

---

### Task 7: 活动站三态编排与降级

**Files:**
- Create: `plus/apps/web/src/hooks/useOnlineStatus.ts`
- Create: `plus/apps/web/src/hooks/useOnlineStatus.test.tsx`
- Modify: `plus/apps/web/src/routes/publicEvent.tsx`
- Modify: `plus/apps/web/src/routes/publicEvent.test.tsx`
- Delete: `plus/apps/web/src/components/portal/EventLive.tsx`

- [ ] **Step 1: 写在线状态失败测试**

创建 `plus/apps/web/src/hooks/useOnlineStatus.test.tsx`：

```tsx
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useOnlineStatus } from "./useOnlineStatus.js";

describe("useOnlineStatus", () => {
  afterEach(() => {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  it("tracks online and offline events", () => {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);

    act(() => {
      Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current).toBe(false);

    act(() => {
      Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/hooks/useOnlineStatus.test.tsx
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现在线状态**

创建 `plus/apps/web/src/hooks/useOnlineStatus.ts`：

```ts
import { useEffect, useState } from "react";

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}
```

- [ ] **Step 4: 重写活动站页面**

把 `plus/apps/web/src/routes/publicEvent.tsx` 改成：

```tsx
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ApiError } from "../api/client.js";
import { fetchPublicEvent, PublicEventNotFound } from "../api/publicEvent.js";
import { fetchPublicCurrent, fetchPublicVoteEntry } from "../api/tickets-public.js";
import { AnnouncementBanner } from "../components/portal/AnnouncementBanner.js";
import { EventAbout } from "../components/portal/EventAbout.js";
import { EventHero } from "../components/portal/EventHero.js";
import { EventProgram } from "../components/portal/EventProgram.js";
import { EventResults } from "../components/portal/EventResults.js";
import { NowNextCard } from "../components/portal/NowNextCard.js";
import { OnsiteActions } from "../components/portal/OnsiteActionPanel.js";
import { deriveOnsiteActions, matchCurrentProgramOrder } from "../components/portal/onsiteActions.js";
import { useOnlineStatus } from "../hooks/useOnlineStatus.js";

export function PublicEventPage() {
  const { publicCode } = useParams({ from: "/e/$publicCode" });
  const online = useOnlineStatus();
  const [refreshing, setRefreshing] = useState(false);

  const siteQuery = useQuery({
    queryKey: ["public-event", publicCode],
    queryFn: ({ signal }) => fetchPublicEvent(publicCode, signal),
    retry: false,
    staleTime: 60_000,
    refetchInterval: (query) =>
      query.state.error instanceof PublicEventNotFound ? false : 60_000,
  });
  const siteStatus = siteQuery.data?.activity.status;
  const currentQuery = useQuery({
    queryKey: ["public-current", publicCode],
    queryFn: ({ signal }) => fetchPublicCurrent(publicCode, signal),
    enabled: siteStatus === "active",
    refetchInterval: (query) =>
      query.state.error instanceof ApiError && query.state.error.status === 404 ? false : 15_000,
    staleTime: 10_000,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 2,
  });
  const voteQuery = useQuery({
    queryKey: ["public-vote-entry", publicCode],
    queryFn: ({ signal }) => fetchPublicVoteEntry(publicCode, signal),
    enabled: siteStatus === "active",
    refetchInterval: 15_000,
    retry: 1,
  });

  useEffect(() => {
    document.title =
      siteQuery.data === undefined ? `活动 · ${publicCode}` : `${siteQuery.data.activity.title} · 活动主页`;
    if (siteQuery.data === undefined) return;
    const meta = document.querySelector('meta[name="description"]')
      ?? (() => {
        const element = document.createElement("meta");
        element.setAttribute("name", "description");
        document.head.appendChild(element);
        return element;
      })();
    meta.setAttribute("content", siteQuery.data.profile.description.slice(0, 160));
  }, [publicCode, siteQuery.data]);

  if (siteQuery.isPending) return <p className="event-state">正在加载活动…</p>;
  if (siteQuery.error instanceof PublicEventNotFound) {
    return (
      <section className="event-state">
        <p className="eyebrow">EVENT</p>
        <h1 className="event-state__title">活动不存在或尚未公开</h1>
        <p className="event-state__copy">请确认公开码，或联系活动主办方。</p>
      </section>
    );
  }
  if (siteQuery.error !== null && siteQuery.data === undefined) {
    return (
      <section className="event-state">
        <h1 className="event-state__title">活动暂时无法加载</h1>
        <button
          type="button"
          className="event-button event-button--primary"
          onClick={() => void siteQuery.refetch()}
        >
          重试
        </button>
      </section>
    );
  }
  const site = siteQuery.data;
  if (site === undefined) return null;

  const hasAbout = site.profile.description.trim() !== "";
  const hasProgram = site.schedule !== null
    || (site.program !== null && site.program.entries.length > 0);
  const hasResults = site.results !== null && site.results.results.length > 0;
  const currentGone = currentQuery.error instanceof ApiError && currentQuery.error.status === 404;
  const liveStatus = currentQuery.data?.activity.status ?? site.activity.status;
  const current = currentGone ? null : currentQuery.data?.current ?? null;
  const next = currentGone ? [] : currentQuery.data?.next ?? [];
  const voteOpen = !voteQuery.isError && voteQuery.data?.status === "open";
  const actions = deriveOnsiteActions({
    siteStatus: site.activity.status,
    currentStatus: liveStatus,
    hasCurrent: current !== null,
    voteOpen,
    hasResults,
    registrationOpen: site.activity.registrationOpen,
  });
  const isActive = liveStatus === "active";
  const total = site.schedule?.entries.length ?? site.program?.entries.length ?? null;
  const programEntries = site.schedule !== null
    ? site.schedule.entries.map((entry) => ({ order: entry.order, name: entry.title, song: entry.slotLabel }))
    : site.program?.entries.map((entry) => ({ order: entry.order, name: entry.name, song: entry.song })) ?? [];
  const currentOrder = current === null ? null : matchCurrentProgramOrder(programEntries, current);
  const voteSessionId = voteQuery.data?.sessionId ?? null;

  function refresh(): void {
    setRefreshing(true);
    void Promise.all([currentQuery.refetch(), voteQuery.refetch()])
      .finally(() => setRefreshing(false));
  }

  return (
    <article className="event-page">
      {online ? null : (
        <p className="event-network" role="status">网络不稳定，展示的是最近一次数据。</p>
      )}
      {siteQuery.isError ? (
        <p className="event-network" role="status">更新失败，展示的是最近一次数据。</p>
      ) : null}
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
        compact={isActive}
      />
      {isActive ? (
        current === null ? (
          <section className="event-now event-now--idle" id="live" aria-labelledby="event-live-title">
            <h2 className="event-section__title" id="event-live-title">现场</h2>
            <p className="event-now__next">暂无进行中的节目。</p>
            {hasProgram ? <a className="event-link" href="#program">查看节目单 →</a> : null}
          </section>
        ) : (
          <NowNextCard
            current={current}
            next={next}
            total={total}
            updatedAt={currentQuery.dataUpdatedAt === 0 ? undefined : currentQuery.dataUpdatedAt}
            onRefresh={refresh}
            refreshing={refreshing}
          />
        )
      ) : null}
      {isActive && currentQuery.isError && !currentGone ? (
        <p className="event-now__error" role="status">
          更新失败，展示的是最近一次数据。
          <button type="button" className="event-link" onClick={refresh}>重试</button>
        </p>
      ) : null}
      <AnnouncementBanner
        publicCode={site.activity.publicCode}
        announcement={site.profile.announcement}
      />
      <nav className="event-anchor-nav" aria-label="活动导航">
        {hasAbout ? <a href="#about">概览</a> : null}
        {current !== null ? <a href="#live">现场</a> : null}
        {hasProgram ? <a href="#program">节目单</a> : null}
        {hasResults ? <a href="#results">赛果</a> : null}
      </nav>
      <OnsiteActions
        primary={actions.primary}
        publicCode={site.activity.publicCode}
        eventTitle={site.activity.title}
        voteSessionId={voteSessionId}
        hasProgram={hasProgram}
      />
      <EventAbout description={site.profile.description} />
      <EventProgram site={site} currentOrder={currentOrder} />
      <EventResults site={site} />
      <footer className="event-footer">
        <span>{site.profile.organizer || "主办方"}</span>
        {site.profile.contact === "" ? null : <span>{site.profile.contact}</span>}
        <span>公开码 {site.activity.publicCode}</span>
      </footer>
    </article>
  );
}
```

- [ ] **Step 5: 更新页面测试**

把 `plus/apps/web/src/routes/publicEvent.test.tsx` 改成：

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({
  useParams: useParamsMock,
  Link: ({ to, params, children }: {
    readonly to: string;
    readonly params?: Readonly<Record<string, string>>;
    readonly children: ReactNode;
  }) => (
    <a href={to.replace(/\$publicCode/g, params?.publicCode ?? "")}>{children}</a>
  ),
}));
vi.mock("../api/publicEvent.js", () => ({
  fetchPublicEvent: vi.fn(),
  PublicEventNotFound: class PublicEventNotFound extends Error {},
}));
vi.mock("qrcode", () => ({ toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,QR") }));

import { ApiError } from "../api/client.js";
import { PublicEventNotFound } from "../api/publicEvent.js";
import { PublicEventPage } from "./publicEvent.js";

const site = {
  activity: {
    publicCode: "SPRING-1",
    title: "春日声场",
    status: "active" as const,
    registrationEnabled: true,
    registrationOpen: true,
  },
  profile: {
    tagline: "春日",
    description: "介绍",
    venue: "剧场",
    startsAt: "2026-04-18T11:00:00.000Z",
    endsAt: null,
    organizer: "学生会",
    contact: "联系",
    announcement: "公告",
  },
  schedule: {
    entries: [{
      order: 1,
      slotLabel: "开场",
      title: "开场舞",
      note: "",
      startsAt: "2026-04-18T11:00:00.000Z",
    }],
  },
  program: null,
  results: {
    activityTitle: "春日声场",
    results: [{
      stageKey: "final",
      publicTitle: "正式赛果",
      releasedAt: "2026-04-18T13:00:00.000Z",
      decisions: [{ rank: 1, contestantName: "林晓", score: "98.30" }],
      awards: [],
    }],
  },
};

function mockQueries(options: {
  readonly site: unknown;
  readonly siteError?: unknown;
  readonly isPending?: boolean;
  readonly current?: unknown;
  readonly currentError?: unknown;
  readonly vote?: unknown;
  readonly voteError?: unknown;
}): void {
  useQueryMock.mockImplementation(({ queryKey }: { readonly queryKey: readonly unknown[] }) => {
    const base = { isFetching: false, dataUpdatedAt: Date.now(), refetch: vi.fn() };
    if (queryKey[0] === "public-current") {
      return {
        ...base,
        data: options.current,
        error: options.currentError ?? null,
        isPending: false,
        isError: options.currentError != null,
      };
    }
    if (queryKey[0] === "public-vote-entry") {
      return {
        ...base,
        data: options.vote,
        error: options.voteError ?? null,
        isPending: false,
        isError: options.voteError != null,
      };
    }
    return {
      ...base,
      data: options.site,
      error: options.siteError ?? null,
      isPending: options.isPending ?? false,
      isError: options.siteError != null,
    };
  });
}

const liveCurrent = {
  activity: { publicCode: "SPRING-1", title: "春日声场", status: "active" as const },
  current: { order: 2, slotLabel: "第一轮", title: "第一首", note: "", startsAt: null },
  next: [{ order: 3, slotLabel: "第一轮", title: "第二首", note: "", startsAt: null }],
};

describe("PublicEventPage", () => {
  beforeEach(() => {
    useParamsMock.mockReturnValue({ publicCode: "SPRING-1" });
    window.sessionStorage.clear();
  });

  it("renders the compact event home with the event content", () => {
    mockQueries({ site });
    render(<PublicEventPage />);
    expect(screen.getByRole("heading", { name: "春日声场" })).toBeInTheDocument();
    expect(document.querySelector(".event-hero--compact")).not.toBeNull();
    expect(screen.getByText("关于本次活动")).toBeInTheDocument();
    expect(screen.getByText("开场舞")).toBeInTheDocument();
    expect(screen.getByText("林晓")).toBeInTheDocument();
  });

  it("shows the not-found state", () => {
    mockQueries({ site: undefined, siteError: new PublicEventNotFound("SPRING-1") });
    render(<PublicEventPage />);
    expect(screen.getByText("活动不存在或尚未公开")).toBeInTheDocument();
  });

  it("renders the live current program and the vote action", () => {
    mockQueries({
      site,
      current: liveCurrent,
      vote: { sessionId: "vote-1", status: "open" },
    });
    render(<PublicEventPage />);
    expect(screen.getByText("第一首")).toBeInTheDocument();
    expect(screen.getByText("下一个：第二首")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /去投票/ })).toHaveAttribute("href", "/vote/vote-1");
    expect(screen.getByRole("link", { name: "现场" })).toHaveAttribute("href", "#live");
  });

  it("does not claim a next program without a current entry", () => {
    mockQueries({
      site,
      current: { ...liveCurrent, current: null, next: liveCurrent.next },
      vote: { sessionId: "vote-1", status: "open" },
    });
    render(<PublicEventPage />);
    expect(screen.getByText("暂无进行中的节目。")).toBeInTheDocument();
    expect(screen.queryByText(/下一个/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /去投票/ })).toBeInTheDocument();
  });

  it("closes the live state on a closed activity even with schedule data", () => {
    const closed = {
      ...site,
      activity: { ...site.activity, status: "closed" as const, registrationOpen: false },
    };
    mockQueries({ site: closed });
    render(<PublicEventPage />);
    expect(document.querySelector(".event-hero--compact")).toBeNull();
    expect(document.querySelector(".event-now")).toBeNull();
    expect(screen.queryByRole("link", { name: /去投票/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "查看赛果" }).length).toBeGreaterThan(0);
  });

  it("hides the current card on a 404 without retaining stale data", () => {
    mockQueries({ site, current: liveCurrent, currentError: new ApiError(404, "NOT_FOUND", "gone") });
    render(<PublicEventPage />);
    expect(document.querySelector(".event-now")).toBeNull();
    expect(screen.getByText("暂无进行中的节目。")).toBeInTheDocument();
  });

  it("keeps the last card and shows a retry on a network failure", () => {
    mockQueries({ site, current: liveCurrent, currentError: new Error("offline") });
    render(<PublicEventPage />);
    expect(screen.getByText("第一首")).toBeInTheDocument();
    expect(screen.getByText(/更新失败，展示的是最近一次数据/)).toBeInTheDocument();
  });

  it("hides the vote action when the vote entry cannot be read", () => {
    mockQueries({ site, current: liveCurrent, voteError: new Error("nope") });
    render(<PublicEventPage />);
    expect(screen.queryByRole("link", { name: /去投票/ })).not.toBeInTheDocument();
  });

  it("keeps the page readable when the activity refresh fails", () => {
    mockQueries({ site, siteError: new Error("offline") });
    render(<PublicEventPage />);
    expect(screen.getByText(/更新失败，展示的是最近一次数据/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "春日声场" })).toBeInTheDocument();
  });

  it("re-shows a dismissed announcement when the text changes", () => {
    mockQueries({ site });
    const { rerender } = render(<PublicEventPage />);
    fireEvent.click(screen.getByRole("button", { name: "关闭公告" }));
    expect(screen.queryByText("公告")).not.toBeInTheDocument();

    mockQueries({ site: { ...site, profile: { ...site.profile, announcement: "新公告" } } });
    rerender(<PublicEventPage />);
    expect(screen.getByText("新公告")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: 删除被替代的 EventLive**

```bash
git rm plus/apps/web/src/components/portal/EventLive.tsx
```

- [ ] **Step 7: 运行页面测试与类型检查**

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/routes/publicEvent.test.tsx src/hooks/useOnlineStatus.test.tsx
pnpm -C plus --filter @artflow-plus/web run check
```

Expected: 全部 PASS。

- [ ] **Step 8: 提交**

```bash
git add plus/apps/web/src/routes/publicEvent.tsx plus/apps/web/src/routes/publicEvent.test.tsx plus/apps/web/src/hooks/useOnlineStatus.ts plus/apps/web/src/hooks/useOnlineStatus.test.tsx
git commit -m "feat(portal): wire the on-site audience companion"
```

---

### Task 8: E2E 种子与观众旅程

**Files:**
- Create: `plus/apps/api/scripts/seed-onsite-audience.ts`
- Modify: `plus/apps/api/package.json`（`seed:e2e`）
- Create: `plus/apps/web/e2e/onsite-audience.spec.ts`
- Modify: `plus/apps/web/e2e/mobile.spec.ts`
- Modify: `plus/apps/web/e2e/a11y.spec.ts`

- [ ] **Step 1: 写幂等种子**

创建 `plus/apps/api/scripts/seed-onsite-audience.ts`：

```ts
import {
  closeDb,
  createDb,
  getActivity,
  insertResultPublication,
  insertResultRelease,
  insertStageResult,
  migrate,
} from "@artflow-plus/db";
import { Client } from "pg";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (connectionString === undefined || connectionString.trim() === "") {
  throw new Error("ARTFLOW_PLUS_DATABASE_URL is required.");
}
const schema = process.env.ARTFLOW_PLUS_DB_SCHEMA;
if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
  throw new Error(`Unsafe ARTFLOW_PLUS_DB_SCHEMA: ${schema}`);
}
if (schema !== undefined) {
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await admin.end();
}

const db = createDb({ connectionString, ...(schema === undefined ? {} : { schema }) });
await migrate(db);

const participants = [
  ["onsite-p1", "林晓", "《后来》"],
  ["onsite-p2", "周然", "《起风了》"],
  ["onsite-p3", "陈默", "《晴天》"],
] as const;

async function clearActivity(activityId: string): Promise<void> {
  await db.deleteFrom("schedule_current").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("schedule_release").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("schedule_entry").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("schedule_state").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("result_release").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("result_publication").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("stage_result").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("ballot").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("vote_option").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("vote_session").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("registration").where("activity_id", "=", activityId).execute();
}

async function seedActivity(
  activityId: string,
  publicCode: string,
  title: string,
  status: "active" | "closed",
  voteStatus: "open" | null,
): Promise<void> {
  await clearActivity(activityId);
  if ((await getActivity(db, activityId)) === null) {
    await db.insertInto("activity").values({
      id: activityId,
      public_code: publicCode,
      title,
      status,
      revision: 1,
      enabled_capabilities: JSON.stringify(["voting", "publishing"]),
      active_definition_version: 1,
    }).execute();
  } else {
    await db.updateTable("activity").set({ title, status }).where("id", "=", activityId).execute();
  }

  for (const [participantId, name] of participants) {
    await db.insertInto("registration").values({
      id: `${activityId}-reg-${participantId}`,
      activity_id: activityId,
      participant_id: participantId,
      questionnaire_version: "onsite-v1",
      questionnaire_hash: "onsite-seed",
      status: "approved",
      answers: JSON.stringify({ name }),
      revision: 1,
      reviewed_by: null,
    }).execute();
  }

  await db.insertInto("schedule_entry").values(
    participants.map(([participantId, name], index) => ({
      id: `${activityId}-e${index + 1}`,
      activity_id: activityId,
      mode: "formal",
      position: index,
      slot_key: `slot-${index + 1}`,
      participant_id: participantId,
      title: name,
      note: "",
      revision: 1,
    })),
  ).execute();
  await db.insertInto("schedule_release").values({
    id: `${activityId}-schedule`,
    activity_id: activityId,
    mode: "formal",
    version: 1,
    snapshot: JSON.stringify({
      version: 1,
      schemaVersion: 1,
      entries: participants.map(([participantId, name, song], index) => ({
        entryId: `${activityId}-e${index + 1}`,
        order: index + 1,
        slotKey: `slot-${index + 1}`,
        slotLabel: song,
        participantId,
        title: name,
        note: "",
        startsAt: null,
      })),
      releasedAt: "2026-11-18T10:00:00.000Z",
    }),
    note: "onsite seed",
    released_at: "2026-11-18T10:00:00.000Z",
    revoked_at: null,
  }).execute();
  await db.insertInto("schedule_current").values({
    activity_id: activityId,
    mode: "formal",
    entry_id: `${activityId}-e2`,
  }).execute();

  await db.insertInto("activity_public_profile").values({
    activity_id: activityId,
    tagline: status === "closed" ? "已结束" : "正在演出",
    description: `${title} 公开活动介绍。`,
    venue: "大学生活动中心剧场",
    starts_at: new Date("2026-11-18T10:00:00.000Z"),
    ends_at: new Date("2026-11-18T13:00:00.000Z"),
    organizer: "校学生会文艺部",
    contact: "学生会办公室",
    announcement: status === "closed" ? "赛果已公布。" : "第 8 位选手请到后台候场",
    revision: 1,
    updated_by: "seed",
    updated_at: new Date("2026-11-18T09:30:00.000Z"),
  }).onConflict((conflict) => conflict.column("activity_id").doUpdateSet({
    tagline: status === "closed" ? "已结束" : "正在演出",
    description: `${title} 公开活动介绍。`,
    venue: "大学生活动中心剧场",
    starts_at: new Date("2026-11-18T10:00:00.000Z"),
    ends_at: new Date("2026-11-18T13:00:00.000Z"),
    organizer: "校学生会文艺部",
    contact: "学生会办公室",
    announcement: status === "closed" ? "赛果已公布。" : "第 8 位选手请到后台候场",
    updated_by: "seed",
    updated_at: new Date("2026-11-18T09:30:00.000Z"),
  })).execute();

  if (voteStatus !== null) {
    const sessionId = `${activityId}-vote`;
    await db.insertInto("vote_session").values({
      id: sessionId,
      activity_id: activityId,
      definition_version: 1,
      mode: "formal",
      purpose: "popularity",
      selection_type: "single",
      max_selections: 1,
      identity_policy: "anonymous",
      scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
      status: voteStatus,
      revision: 0,
      opened_at: "2026-11-18T10:05:00.000Z",
      closed_at: null,
    }).execute();
    await db.insertInto("vote_option").values(
      participants.map(([participantId], index) => ({
        id: `${sessionId}-option-${index}`,
        activity_id: activityId,
        session_id: sessionId,
        candidate_id: participantId,
        ordinal: index,
      })),
    ).execute();
  }

  if (status === "closed") {
    const decisions = participants.map(([participantId], index) => ({
      rank: index + 1,
      contestantId: participantId,
      score: ["98.30", "97.80", "96.40"][index] ?? "0",
    }));
    const awards = [{ award: "冠军", contestantId: "onsite-p1" }];
    await db.transaction().execute(async (trx) => {
      await insertStageResult(trx, {
        id: `${activityId}-stage`,
        activityId,
        stageKey: "final",
        status: "confirmed",
        candidateRevision: 1,
        sourceCandidateRevision: 1,
        inputFingerprint: "onsite-seed",
        source: {
          kind: "podium_candidate",
          aggregateId: `${activityId}-stage`,
          definitionVersion: 1,
          releaseHash: "onsite-seed",
          mode: "formal",
          sourceRevision: 1,
          inputFingerprint: "onsite-seed",
        },
        decisions,
        awards,
        note: "",
        revision: 1,
        confirmedAt: "2026-11-18T12:00:00.000Z",
        staleReason: "",
      });
      await insertResultPublication(trx, {
        id: `${activityId}-publication`,
        activityId,
        stageKey: "final",
        title: "正式赛果",
        content: "",
        version: 1,
        revision: 0,
      });
      await insertResultRelease(trx, {
        id: `${activityId}-release`,
        activityId,
        publicationId: `${activityId}-publication`,
        stageResultId: `${activityId}-stage`,
        stageKey: "final",
        status: "active",
        snapshot: {
          activityTitle: title,
          publicTitle: `${title} · 正式赛果`,
          stageKey: "final",
          decisions,
          awards,
        },
        snapshotCandidateRevision: 1,
        resultVersion: 1,
        postVersion: 1,
        inputFingerprint: "onsite-seed",
        note: "e2e seed",
        releasedAt: "2026-11-18T12:10:00.000Z",
        revision: 0,
      });
    });
  }
}

await seedActivity("act_e2e_onsite", "E2E-ONSITE", "E2E 现场十佳", "active", "open");
await seedActivity("act_e2e_onsite_closed", "E2E-ONSITE-CLOSED", "E2E 现场十佳（已结束）", "closed", null);

await closeDb(db);
console.log("Seeded on-site audience activities act_e2e_onsite and act_e2e_onsite_closed.");
```

- [ ] **Step 2: 把种子接入 E2E**

在 `plus/apps/api/package.json` 的 `seed:e2e` 末尾追加：

```text
 && tsx scripts/seed-onsite-audience.ts
```

- [ ] **Step 3: 写观众旅程**

创建 `plus/apps/web/e2e/onsite-audience.spec.ts`：

```ts
import { expect, test } from "@playwright/test";

test("on-site audience sees now/next, the announcement and named vote candidates", async ({ page }) => {
  await page.goto("/e/E2E-ONSITE");
  await expect(page.getByRole("heading", { name: "E2E 现场十佳" })).toBeVisible();
  await expect(page.getByText("周然").first()).toBeVisible();
  await expect(page.getByText("下一个：陈默")).toBeVisible();
  await expect(page.getByText("第 8 位选手请到后台候场")).toBeVisible();
  await expect(page.getByRole("link", { name: /投票进行中/ })).toBeVisible();

  await page.getByRole("link", { name: /投票进行中/ }).click();
  await expect(page).toHaveURL(/\/vote\/act_e2e_onsite-vote$/);
  await expect(page.getByText("林晓")).toBeVisible();
  await expect(page.getByText("周然")).toBeVisible();
  await expect(page.getByText("陈默")).toBeVisible();
});

test("a closed event hides the live card and the vote action", async ({ page }) => {
  await page.goto("/e/E2E-ONSITE-CLOSED");
  await expect(page.getByRole("heading", { name: "E2E 现场十佳（已结束）" })).toBeVisible();
  await expect(page.locator(".event-now")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /去投票/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "查看赛果" }).first()).toBeVisible();
});
```

- [ ] **Step 4: 加入移动端断言**

在 `plus/apps/web/e2e/mobile.spec.ts` 的 `mobile portal surfaces avoid horizontal scroll and 44px violations` 测试里，`await page.goto("/"); ...` 之后加入：

```ts
  await page.goto("/e/E2E-ONSITE");
  await expect(page.locator(".event-page")).toBeVisible();
  result = await measure(page, touchTargetFloor);
  expect(result.horizontalOverflow, "/e/E2E-ONSITE scrolls horizontally").toBe(false);
  expect(result.undersized, "/e/E2E-ONSITE has controls shorter than 44px").toEqual([]);
  await assertHeaderDoesNotCoverContent(page, ".site-header", ".site-main");
```

- [ ] **Step 5: 加入无障碍断言**

在 `plus/apps/web/e2e/a11y.spec.ts` 的 `/e/E2E-DEMO` 断言之后加入：

```ts
  await page.goto("/e/E2E-ONSITE");
  await expect(page.locator(".event-now")).toBeVisible();
  await assertNoBlockingViolations(page, "/e/E2E-ONSITE");
```

- [ ] **Step 6: 运行 E2E**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/onsite-audience.spec.ts --project=chromium
pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/mobile.spec.ts --project=mobile
pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/a11y.spec.ts --project=chromium
```

Expected: 全部 PASS。若本机 `artflow_e2e` schema 有旧状态导致失败，先清空该 schema 再重跑。

- [ ] **Step 7: 提交**

```bash
git add plus/apps/api/scripts/seed-onsite-audience.ts plus/apps/api/package.json plus/apps/web/e2e/onsite-audience.spec.ts plus/apps/web/e2e/mobile.spec.ts plus/apps/web/e2e/a11y.spec.ts
git commit -m "test(e2e): cover the on-site audience companion"
```

---

### Task 9: 全量门禁与收尾

**Files:** 无新增；只验证与修正。

- [ ] **Step 1: 运行全工作区类型检查与测试**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus run check
pnpm -C plus run test
```

Expected: 全部 PASS。`test` 使用 `--workspace-concurrency=1`，不要并行跑多个包。

- [ ] **Step 2: 运行结构、消费者图与缺口门禁**

```powershell
pnpm -C plus --filter @artflow-plus/contract-tools run graph:check
pnpm -C plus --filter @artflow-plus/contract-tools run audit:check
pnpm -C plus run schema:check
pnpm -C plus run build:prod
uv run pytest tests/gates -q
pwsh -NoProfile -File scripts/check_docs.ps1
```

Expected: `graph:check` unresolved 0 且 `uiGaps` 不增加；`audit:check` baseline 不增加；其余全绿。

- [ ] **Step 3: 运行完整 Playwright**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus --filter @artflow-plus/web exec playwright test --project=chromium
pnpm -C plus --filter @artflow-plus/web exec playwright test --project=mobile
```

Expected: 全部 PASS。

- [ ] **Step 4: 修正后提交**

如果门禁发现问题，按失败项修正后重新运行对应门禁，再提交：

```bash
git add -A
git commit -m "chore: close the on-site audience companion gates"
```

- [ ] **Step 5: 合并**

按项目 Git 流程，在聚焦门禁全绿后：

```bash
git switch main
git pull --ff-only
git merge --no-ff feat/onsite-audience-companion
git -c http.proxy= -c https.proxy= push origin main
```

---

## 验收证据

- 投票候选显示姓名；缺失姓名时显示「候选 N」，不裸露内部 ID。
- 活动进行中：首屏出现 NOW 卡、下一个、公告与唯一主行动。
- `current` 为空：显示「暂无进行中的节目」，不出现"下一个"。
- `current` 404：隐藏 NOW，不保留已下线数据。
- 活动结束：不显示 NOW 与投票，主行动切到赛果。
- 赛果撤销：活动站刷新后赛果与主行动消失（≤60s 可见延迟）。
- 网络失败：保留最近数据；`current` 失败显示重试；`voting` 失败隐藏投票动作。
- 公告关闭后同一文本不再出现，文本更新后重新出现。
- 移动端 `/e/E2E-ONSITE`：无横向滚动，所有可见控件 ≥44px。
- 无障碍：`/e/E2E-ONSITE` 无 serious/critical 违规。
