# Studio 引导向导实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/studio/new` 改成六步创建向导，并在 Studio 活动页增加“上线就绪度”清单；同时关闭 `definition.compile` 对 closed/archived 活动的生命周期缺口。

**Architecture:** 向导复用现有 `previewPack` / `createStudioActivity`；就绪清单是 `StudioState` 的纯函数投影 `deriveReadiness`，编译/发布仍由现有 `DefinitionEditor` / `ReleasePanel` 执行；唯一的后端改动是 `compileDefinition` 的 `draft|active` 守卫。

**Tech Stack:** TypeScript、React 19、TanStack Query、Fastify/Kysely（仅 compile 守卫）、Vitest、Playwright。

**Spec:** [`2026-11-18-studio-guided-wizard-design.md`](../specs/2026-11-18-studio-guided-wizard-design.md)

---

## Test architecture

按 spec §6 执行：**契约**（不新增 capability/命令/路由/表；仅给既有 `definition.compile` 加守卫）；
**消费者**（`/studio/new`、`/studio/$activityId` 页面；复用 pack instantiate、activity create、studio state）；
**生命周期**（definition draft/compiled/release；活动 draft/active/closed/archived；发布 stale 用 contentHash；closed/archived 只读）；
**适配器**（无 capability adapter；组件测试 + 现有真实后端 E2E）；
**故障**（预览 422、创建冲突、旧 release、运行中会话、归档、同内容重编译、切换 Pack）；
**防膨胀 / anti-bloat**（两个组件测试 + 扩展 `studio.spec.ts` + 一条 runtime 守卫用例；不新建框架）；
**门禁**（下方命令）。

---

## Task 1: `definition.compile` 生命周期守卫

**Files:**
- Modify: `plus/packages/runtime/src/definition-service.ts`
- Test: `plus/packages/runtime/test/activity-service.test.ts`

- [ ] **Step 1: 写失败测试**

在 `activity-service.test.ts` 增加（沿用现有 db/deps/seed helper）：

```ts
it("rejects compiling a definition on closed or archived activities", async () => {
  const registry = createDefaultCapabilityRegistry();
  const pkg = {
    schemaVersion: 1,
    manifest: { key: "closed", title: "closed" },
    capabilities: {},
    bindings: [],
  };
  const closed = await seed("closed");
  await expect(compileDefinition(db, registry, deps(), {
    commandId: randomUUID(),
    activityId: closed,
    package: pkg,
  })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

  const archived = await seed("archived");
  await expect(compileDefinition(db, registry, deps(), {
    commandId: randomUUID(),
    activityId: archived,
    package: pkg,
  })).rejects.toMatchObject({ code: "ACTIVITY_ARCHIVED" });
});
```

导入 `compileDefinition` 与 `createDefaultCapabilityRegistry`。

- [ ] **Step 2: 运行确认失败**

```powershell
Set-Location plus
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm --filter @artflow-plus/runtime test -- activity-service
```

Expected：FAIL，closed/archived 仍可编译。

- [ ] **Step 3: 加守卫**

在 `compileDefinition` 的 handler 中，`getActivityForUpdate` 之后、`compileActivityDefinitionPackage` 之前：

```ts
if (activity.status === "archived") {
  throw new DomainError("ACTIVITY_ARCHIVED", "An archived activity cannot change its definition.");
}
if (activity.status !== "draft" && activity.status !== "active") {
  throw new DomainError("INVALID_TRANSITION", "A closed activity cannot change its definition.");
}
```

`DomainError` 已导入。

- [ ] **Step 4: 运行测试与类型检查**

```powershell
pnpm --filter @artflow-plus/runtime test -- activity-service
pnpm --filter @artflow-plus/runtime run check
```

Expected：PASS。

- [ ] **Step 5: 提交**

```bash
git add plus/packages/runtime
git commit -m "fix(studio): reject definition edits on closed or archived activities"
```

---

## Task 2: `deriveReadiness` 与就绪清单

**Files:**
- Create: `plus/apps/web/src/components/studio/studioReadiness.ts`
- Create: `plus/apps/web/src/components/studio/StudioReadiness.tsx`
- Modify: `plus/apps/web/src/components/studio/DefinitionEditor.tsx`
- Modify: `plus/apps/web/src/components/studio/ReleasePanel.tsx`
- Modify: `plus/apps/web/src/components/studio/SessionPanel.tsx`
- Test: `plus/apps/web/src/components/studio/StudioReadiness.test.tsx`

- [ ] **Step 1: 写只读纯函数**

`studioReadiness.ts`：

```ts
import type { StudioState } from "../../api/studio.js";

export type ReadinessStatus = "done" | "current" | "pending" | "stale" | "blocked";

export interface ReadinessStep {
  readonly id: "definition" | "activate" | "compile" | "release" | "profile" | "ops";
  readonly title: string;
  readonly status: ReadinessStatus;
  readonly detail: string;
  readonly href?: string;
}

export interface ReadinessView {
  readonly steps: readonly ReadinessStep[];
  readonly completed: number;
  readonly total: 4;
  readonly ready: boolean;
  readonly terminal: "closed" | "archived" | null;
}

export function deriveReadiness(state: StudioState): ReadinessView {
  const status = state.activity.status;
  const terminal = status === "closed" || status === "archived" ? status : null;
  const editable = status === "draft" || status === "active";
  const activeRelease = state.releases.find((release) => release.active);
  const compiledHash = state.compiled?.contentHash;
  const releasedCurrent = activeRelease !== undefined &&
    compiledHash !== undefined &&
    activeRelease.contentHash === compiledHash;

  const definitionDone = state.draft !== null;
  const activatedDone = status !== "draft";
  const compiledDone = state.compiled !== null;
  const profileDone =
    state.publicProfile.tagline.trim() !== "" || state.publicProfile.description.trim() !== "";

  const steps: ReadinessStep[] = [
    {
      id: "definition",
      title: "定义已保存",
      status: definitionDone ? "done" : "current",
      detail: definitionDone ? `draft revision ${state.draft?.revision ?? "—"}` : "在下方 Definition Package 保存草稿。",
      href: "#definition-editor",
    },
    {
      id: "activate",
      title: "活动已激活",
      status: activatedDone ? "done" : "current",
      detail: activatedDone ? "活动已进入 active/closed/archived。" : "激活后才可以发布定义。",
    },
    {
      id: "compile",
      title: "当前草稿已编译",
      status: compiledDone ? "done" : terminal !== null ? "blocked" : "current",
      detail: compiledDone
        ? `compiled ${state.compiled?.contentHash.slice(0, 12) ?? ""}…`
        : terminal !== null
          ? "活动已结束/归档，不能重新编译。"
          : "点击“编译定义”生成可发布的版本。",
      href: "#definition-editor",
    },
    {
      id: "release",
      title: "已发布当前定义",
      status: releasedCurrent
        ? "done"
        : terminal !== null
          ? activeRelease !== undefined ? "stale" : "blocked"
          : activeRelease !== undefined && compiledHash !== undefined ? "stale" : "current",
      detail: releasedCurrent
        ? `active release v${activeRelease?.version ?? "—"}`
        : terminal !== null
          ? "活动已结束/归档，不能重新发布。"
          : activeRelease !== undefined
            ? "有新改动未发布；重新编译并发布。"
            : "编译后发布当前定义。",
      href: terminal === null ? "#release-panel" : undefined,
    },
    {
      id: "profile",
      title: "公开主页资料",
      status: profileDone ? "done" : "pending",
      detail: profileDone ? "已填写标语或介绍。" : "建议补全标语/介绍，方便分享。",
    },
    {
      id: "ops",
      title: "去 Ops 准备",
      status: state.activity.status === "active" && releasedCurrent ? "done" : "pending",
      detail: "报名审核、名单、签到、现场任务在 Ops 完成。",
    },
  ];

  const required = steps.slice(0, 4);
  const completed = required.filter((step) => step.status === "done").length;
  return {
    steps,
    completed,
    total: 4,
    ready: status === "active" && completed === 4,
    terminal,
  };
}
```

注意：发布是否当前用 `activeRelease.contentHash === compiledHash`；`state.compiled` 为 null 时 release 步骤为 stale/blocked，不会误判为 done。

- [ ] **Step 2: 写组件**

`StudioReadiness.tsx`：

```tsx
import { Link } from "@tanstack/react-router";

import type { StudioState } from "../../api/studio.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { deriveReadiness, type ReadinessStatus } from "./studioReadiness.js";

const TONES: Readonly<Record<ReadinessStatus, BadgeTone>> = {
  done: "success",
  current: "warning",
  pending: "neutral",
  stale: "danger",
  blocked: "neutral",
};

const LABELS: Readonly<Record<ReadinessStatus, string>> = {
  done: "已完成",
  current: "现在处理",
  pending: "未开始",
  stale: "需重新发布",
  blocked: "只读",
};

export function StudioReadiness({
  state,
  onActivate,
}: {
  readonly state: StudioState;
  readonly onActivate: () => void;
}) {
  const view = deriveReadiness(state);
  const activityId = state.activity.id;
  return (
    <Card className="studio-readiness" aria-labelledby="studio-readiness-title">
      <div className="studio-readiness__head">
        <div>
          <h2 className="ui-card__title" id="studio-readiness-title">上线就绪度</h2>
          <p className="ui-card__description">
            {view.terminal === "archived"
              ? "活动已归档，配置只读。"
              : view.terminal === "closed"
                ? "活动已结束；不能重新发布。"
                : view.ready
                  ? "活动已就绪，可以去 Ops 准备报名、名单和现场。"
                  : `${view.completed}/${view.total} 步完成`}
          </p>
        </div>
        <Badge tone={view.ready ? "success" : view.terminal === null ? "warning" : "neutral"}>
          {view.ready ? "READY" : view.terminal === "archived" ? "ARCHIVED" : view.terminal === "closed" ? "CLOSED" : "SETUP"}
        </Badge>
      </div>
      <ol className="studio-readiness__steps">
        {view.steps.map((step, index) => (
          <li key={step.id} className={`studio-readiness__step is-${step.status}`}>
            <span className="studio-readiness__index" aria-hidden="true">{index + 1}</span>
            <div className="studio-readiness__body">
              <span className="studio-readiness__title">{step.title}</span>
              <span className="studio-readiness__detail">{step.detail}</span>
            </div>
            <Badge tone={TONES[step.status]}>{LABELS[step.status]}</Badge>
            {step.id === "activate" && state.activity.status === "draft" ? (
              <Button variant="secondary" size="sm" onClick={onActivate}>激活活动</Button>
            ) : null}
            {step.id === "profile" && view.terminal === null ? (
              <Link
                className="table-link"
                to="/studio/$activityId/public"
                params={{ activityId }}
              >
                编辑公开主页
              </Link>
            ) : null}
            {step.id === "ops" && view.ready ? (
              <Link className="table-link" to="/ops/$activityId" params={{ activityId }}>打开 Ops</Link>
            ) : null}
            {step.href === undefined || view.terminal !== null ? null : (
              <a className="table-link" href={step.href}>去处理</a>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
```

- [ ] **Step 3: 加锚点与只读**

- `DefinitionEditor`：`<Card className="studio-editor" id="definition-editor">`；增加 `readOnly?: boolean` prop；编译按钮 `disabled={busy || readOnly}`；底部提示 `readOnly ? "活动已结束或归档，定义只读。" : null`。`studioActivity` 传 `readOnly={state.activity.status === "closed" || state.activity.status === "archived"}`。
- `ReleasePanel`：`<Card id="release-panel">`。
- `SessionPanel`：`<Card id="session-panel">`（若其 Card 有 className，保留）。

- [ ] **Step 4: 写组件测试**

`StudioReadiness.test.tsx`：

```tsx
import { describe, expect, it } from "vitest";

import type { StudioState } from "../../api/studio.js";
import { deriveReadiness } from "./studioReadiness.js";

function state(overrides: Partial<StudioState> = {}): StudioState {
  return {
    activity: {
      id: "act-1", publicCode: "AF-1", title: "春季赛", status: "active", revision: 2,
      enabledCapabilities: ["competition"], activeDefinitionVersion: 1,
    },
    draft: { revision: 2, package: {} },
    compiled: { draftRevision: 2, contentHash: "hash-a", capabilities: [] },
    releases: [{
      version: 1, contentHash: "hash-a", releasedAt: "2026-11-18T00:00:00.000Z",
      sourceDraftRevision: 2, declaredScopes: [], capabilityVersions: { competition: "1" }, active: true,
    }],
    sessions: [],
    publicProfile: {
      activityId: "act-1", tagline: "校园歌手赛", description: "", venue: "礼堂",
      startsAt: null, endsAt: null, organizer: "学生会", contact: "", announcement: "",
      revision: 1, updatedBy: "ops-1", updatedAt: "2026-11-18T00:00:00.000Z",
    },
    ...overrides,
  };
}

function step(view: ReturnType<typeof deriveReadiness>, id: string) {
  return view.steps.find((candidate) => candidate.id === id);
}

describe("deriveReadiness", () => {
  it("is ready when the active release matches the compiled hash", () => {
    expect(deriveReadiness(state()).ready).toBe(true);
  });

  it("marks the release stale when the compiled hash differs", () => {
    const view = deriveReadiness(state({
      compiled: { draftRevision: 3, contentHash: "hash-b", capabilities: [] },
    }));
    expect(view.ready).toBe(false);
    expect(step(view, "release")?.status).toBe("stale");
  });

  it("does not treat a no-op recompile as stale", () => {
    const view = deriveReadiness(state({
      draft: { revision: 3, package: {} },
      compiled: { draftRevision: 3, contentHash: "hash-a", capabilities: [] },
    }));
    expect(view.ready).toBe(true);
    expect(step(view, "release")?.status).toBe("done");
  });

  it("blocks compile and release on archived activities", () => {
    const view = deriveReadiness(state({
      activity: { ...state().activity, status: "archived" },
    }));
    expect(view.terminal).toBe("archived");
    expect(view.ready).toBe(false);
    expect(step(view, "compile")?.status).toBe("blocked");
    expect(step(view, "release")?.href).toBeUndefined();
  });

  it("does not offer a release action on a closed activity", () => {
    const view = deriveReadiness(state({
      activity: { ...state().activity, status: "closed" },
      compiled: { draftRevision: 3, contentHash: "hash-b", capabilities: [] },
    }));
    expect(view.terminal).toBe("closed");
    expect(step(view, "release")?.status).toBe("stale");
    expect(step(view, "release")?.href).toBeUndefined();
  });

  it("keeps the public profile optional", () => {
    const view = deriveReadiness(state({
      publicProfile: { ...state().publicProfile, tagline: "", description: "" },
    }));
    expect(view.ready).toBe(true);
    expect(step(view, "profile")?.status).toBe("pending");
  });
});
```

- [ ] **Step 5: 运行**

```powershell
pnpm --filter @artflow-plus/web test -- StudioReadiness
pnpm --filter @artflow-plus/web run check
```

Expected：PASS。

- [ ] **Step 6: 提交**

```bash
git add plus/apps/web/src
git commit -m "feat(studio): add the launch readiness checklist"
```

---

## Task 3: 六步创建向导

**Files:**
- Create: `plus/apps/web/src/components/studio/studioWizardData.ts`
- Create: `plus/apps/web/src/components/studio/StudioWizard.tsx`
- Test: `plus/apps/web/src/components/studio/StudioWizard.test.tsx`

- [ ] **Step 1: 写步骤数据 helper**

`studioWizardData.ts`：

```ts
import type { ActivityPackSummary, PackQuestion } from "../../api/studio.js";

export const PACK_COPY: Readonly<Record<string, { title: string; description: string }>> = {
  "singer-competition": { title: "歌手比赛", description: "报名、问卷、音频材料、分组、评委评分、结果发布与归档。" },
  "stage-show": { title: "舞台演出 / 节目征集", description: "节目报名、作品材料、审核、任务与归档，不含比赛排名。" },
  "review-awards": { title: "作品评审 / 评奖", description: "报名、作品材料、评委评审、奖项候选与结果发布。" },
  "vote-poll": { title: "人气投票", description: "单个或多个候选的观众投票，结果确认后公开发布。" },
};

export function packCopy(pack: { readonly identity: string; readonly title: string }) {
  return PACK_COPY[pack.identity] ?? { title: pack.title, description: "" };
}

export const WIZARD_STEPS = [
  { id: "pack", label: "选择模板" },
  { id: "basics", label: "基本信息" },
  { id: "registration", label: "报名与材料" },
  { id: "evaluation", label: "评审与现场" },
  { id: "operations", label: "运营与发布" },
  { id: "review", label: "检查与创建" },
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number]["id"];

const REGISTRATION = new Set(["registration", "questionnaire", "materials"]);
const EVALUATION = new Set(["competition", "grouping", "voting", "ticketing"]);

export function questionsForStep(pack: ActivityPackSummary, step: WizardStep): readonly PackQuestion[] {
  return pack.questions.filter((question) => {
    if (step === "registration") return REGISTRATION.has(question.capability);
    if (step === "evaluation") return EVALUATION.has(question.capability);
    if (step === "operations") return !REGISTRATION.has(question.capability) && !EVALUATION.has(question.capability);
    return false;
  });
}

export function defaultsFor(pack: ActivityPackSummary): Record<string, boolean> {
  return Object.fromEntries(pack.questions.map((question) => [question.id, question.default]));
}
```

- [ ] **Step 2: 写向导测试**

`StudioWizard.test.tsx`：

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const createMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));
vi.mock("../../api/studio.js", () => ({
  createStudioActivity: createMock,
  previewPack: vi.fn(),
}));

import { ApiError } from "../../api/client.js";
import { StudioWizard } from "./StudioWizard.js";

const packs = [
  {
    identity: "singer-competition", version: "1", title: "Singer",
    baselineCapabilities: ["competition"],
    questions: [
      { id: "registration-required", prompt: "需要报名", capability: "registration", default: true },
      { id: "judge-entry", prompt: "需要评委入口", capability: "ticketing", default: true },
    ],
  },
  {
    identity: "stage-show", version: "1", title: "Stage",
    baselineCapabilities: ["schedule"], questions: [],
  },
];

function previewData() {
  return {
    data: {
      pack: { identity: "singer-competition", version: "1" },
      enabledCapabilities: ["competition", "registration"],
      definition: {},
    },
    error: null,
    isPending: false,
  };
}

function next(): void {
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
}

describe("StudioWizard", () => {
  beforeEach(() => {
    useQueryMock.mockReturnValue(previewData());
    createMock.mockResolvedValue({ id: "act-1" });
    navigateMock.mockReset();
  });

  it("moves through the steps and creates with the current answers", async () => {
    render(<StudioWizard packs={packs} />);
    next();
    fireEvent.change(screen.getByLabelText("活动标题"), { target: { value: "春季赛" } });
    next();
    next();
    next();
    next();
    expect(screen.getByRole("heading", { name: "检查与创建" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建活动" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ title: "春季赛", packId: "singer-competition" }),
    ));
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/studio/$activityId", params: { activityId: "act-1" },
    });
  });

  it("resets answers when the pack changes", async () => {
    render(<StudioWizard packs={packs} />);
    fireEvent.click(screen.getByRole("button", { name: /Stage/ }));
    await waitFor(() => {
      const lastCall = useQueryMock.mock.calls.at(-1);
      expect(lastCall?.[0]).toMatchObject({
        queryKey: ["pack-preview", "stage-show", "", {}],
      });
    });
  });

  it("disables create on a preview error", async () => {
    useQueryMock.mockReturnValue({
      data: undefined,
      error: new ApiError(422, "PACK_COMPOSITION_INVALID", "invalid", [
        { code: "X", message: "bad", path: "p" },
      ]),
      isPending: false,
    });
    render(<StudioWizard packs={packs} />);
    next();
    fireEvent.change(screen.getByLabelText("活动标题"), { target: { value: "春季赛" } });
    next();
    next();
    next();
    next();
    expect(screen.getByText("bad")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建活动" })).toBeDisabled();
  });
});
```

- [ ] **Step 3: 写向导**

`StudioWizard.tsx` 的核心：

```tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { ApiError } from "../../api/client.js";
import { createStudioActivity, previewPack, type ActivityPackSummary } from "../../api/studio.js";
import { summarizeDefinition } from "./definitionSummary.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";
import { capabilityLabels } from "../format/labels.js";
import {
  defaultsFor, packCopy, questionsForStep, WIZARD_STEPS, type WizardStep,
} from "./studioWizardData.js";

function SummarySection({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <section className="definition-summary-section">
      <h3>{title}</h3>
      <ul>
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export function StudioWizard({ packs }: { readonly packs: readonly ActivityPackSummary[] }) {
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>("pack");
  const [packId, setPackId] = useState(packs[0]?.identity ?? "");
  const pack = packs.find((candidate) => candidate.identity === packId) ?? packs[0];
  const [title, setTitle] = useState("");
  const [answers, setAnswers] = useState<Record<string, boolean>>(() => pack === undefined ? {} : defaultsFor(pack));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pack === undefined) return;
    setAnswers(defaultsFor(pack));
  }, [pack?.identity]);

  const preview = useQuery({
    queryKey: ["pack-preview", pack?.identity, title, answers],
    queryFn: () => previewPack(pack?.identity ?? "", { title: title || packCopy(pack ?? { identity: "", title: "" }).title, answers }),
    enabled: pack !== undefined,
    retry: false,
  });
  const summary = summarizeDefinition(preview.data?.definition, preview.data?.enabledCapabilities ?? []);
  const stepIndex = WIZARD_STEPS.findIndex((item) => item.id === step);
  const stepDef = WIZARD_STEPS[stepIndex] ?? WIZARD_STEPS[0];
  const nextStep = WIZARD_STEPS[stepIndex + 1];
  const canNext = step === "basics" ? title.trim() !== "" : true;
  const previewError = preview.error instanceof ApiError ? preview.error : null;

  async function create(): Promise<void> {
    if (pack === undefined || title.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const activity = await createStudioActivity(crypto.randomUUID(), {
        title: title.trim(), packId: pack.identity, answers,
      });
      await navigate({ to: "/studio/$activityId", params: { activityId: activity.id } });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "创建失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  if (pack === undefined) return <p className="ui-card__description">没有可用的活动模板。</p>;

  return (
    <section className="studio-wizard">
      <ol className="studio-wizard__steps" aria-label="创建步骤">
        {WIZARD_STEPS.map((item, index) => (
          <li key={item.id} className={item.id === step ? "is-current" : index < stepIndex ? "is-done" : ""}>
            <button type="button" disabled={index > stepIndex} onClick={() => setStep(item.id)}>
              <span>{index + 1}</span>{item.label}
            </button>
          </li>
        ))}
      </ol>
      <div className="studio-wizard__grid">
        <Card className="studio-wizard__main">
          <h2 className="ui-card__title">{stepDef.label}</h2>
          {step === "pack" ? (
            <div className="wizard-pack-grid">
              {packs.map((candidate) => (
                <button
                  type="button"
                  key={candidate.identity}
                  className={candidate.identity === pack.identity ? "wizard-pack is-selected" : "wizard-pack"}
                  onClick={() => setPackId(candidate.identity)}
                >
                  <strong>{packCopy(candidate).title}</strong>
                  <span>{packCopy(candidate).description}</span>
                  <span>{capabilityLabels(candidate.baselineCapabilities)}</span>
                </button>
              ))}
            </div>
          ) : null}
          {step === "basics" ? (
            <>
              <Input label="活动标题" value={title} onChange={(event) => setTitle(event.target.value)} />
              <p className="ui-card__description">公开码会在创建后生成；创建后可补全公开主页。</p>
            </>
          ) : null}
          {step === "registration" || step === "evaluation" || step === "operations" ? (
            <div className="wizard-questions">
              <p className="ui-card__description">已包含：{capabilityLabels(pack.baselineCapabilities)}</p>
              {questionsForStep(pack, step).map((question) => (
                <label key={question.id} className="pack-question">
                  <input
                    type="checkbox"
                    checked={answers[question.id] ?? question.default}
                    onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.checked }))}
                  />
                  <span>{question.prompt}</span>
                </label>
              ))}
              {questionsForStep(pack, step).length === 0 ? (
                <p className="ui-card__description">这个模板在此步骤没有额外选项。</p>
              ) : null}
            </div>
          ) : null}
          {step === "review" ? (
            <div className="definition-summary">
              <p className="ui-card__description">已启用：{capabilityLabels(preview.data?.enabledCapabilities ?? [])}</p>
              {previewError === null ? null : (
                <div className="ui-field__error" role="alert">
                  <p>{previewError.message}</p>
                  {Array.isArray(previewError.details) ? (
                    <ul>
                      {(previewError.details as { code: string; message: string; path: string }[]).map((issue) => (
                        <li key={`${issue.path}-${issue.code}`}>{issue.path}: {issue.message}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )}
              <SummarySection title="报名字段" items={summary.registration} />
              <SummarySection title="回合与评委" items={summary.rounds} />
              <SummarySection title="评分方式" items={summary.scoring} />
              <SummarySection title="材料限制" items={summary.materials} />
              <SummarySection title="发布阶段" items={summary.publishing} />
              <SummarySection title="投票" items={summary.voting} />
            </div>
          ) : null}
          {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}
          <div className="studio-toolbar">
            <Button variant="secondary" disabled={stepIndex === 0} onClick={() => setStep(WIZARD_STEPS[stepIndex - 1]?.id ?? "pack")}>
              上一步
            </Button>
            {nextStep === undefined ? (
              <Button variant="primary" disabled={busy || previewError !== null || preview.isPending || title.trim() === ""} onClick={() => void create()}>
                {busy ? "正在创建…" : "创建活动"}
              </Button>
            ) : (
              <Button variant="primary" disabled={!canNext} onClick={() => setStep(nextStep.id)}>下一步</Button>
            )}
          </div>
        </Card>
        <Card className="studio-wizard__rail">
          <h2 className="ui-card__title">将创建</h2>
          {preview.isPending ? <p className="ui-card__description">正在生成预览…</p> : null}
          {preview.data === undefined ? null : (
            <>
              <p className="ui-card__description">已启用：{capabilityLabels(preview.data.enabledCapabilities)}</p>
              <div className="definition-summary">
                <SummarySection title="报名字段" items={summary.registration} />
                <SummarySection title="回合与评委" items={summary.rounds} />
                <SummarySection title="评分方式" items={summary.scoring} />
                <SummarySection title="材料限制" items={summary.materials} />
                <SummarySection title="发布阶段" items={summary.publishing} />
                <SummarySection title="投票" items={summary.voting} />
              </div>
              <details className="definition-raw">
                <summary>高级：原始 JSON</summary>
                <pre className="preview-json">{JSON.stringify(preview.data.definition, null, 2)}</pre>
              </details>
            </>
          )}
        </Card>
      </div>
    </section>
  );
}
```

`SummarySection` 从现有 `studioNew.tsx` 提取到 `StudioWizard.tsx` 或 `studioWizardData.ts`；保持现有实现。

- [ ] **Step 4: 运行测试**

```powershell
pnpm --filter @artflow-plus/web test -- StudioWizard
pnpm --filter @artflow-plus/web run check
```

Expected：PASS。

- [ ] **Step 5: 提交**

```bash
git add plus/apps/web/src
git commit -m "feat(studio): add the guided creation wizard"
```

---

## Task 4: 页面接入

**Files:**
- Modify: `plus/apps/web/src/routes/studioNew.tsx`
- Modify: `plus/apps/web/src/routes/studioActivity.tsx`
- Modify: `plus/apps/web/src/styles/studio.css` / create `studio-wizard.css`
- Modify: `plus/apps/web/src/styles/global.css`
- Test: `plus/apps/web/src/routes/studioNew.test.tsx`
- Test: `plus/apps/web/src/routes/studioActivity.test.tsx`

- [ ] **Step 1: 重写 studioNew**

```tsx
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { fetchPacks } from "../api/studio.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasStudioAccess, useSession } from "../auth/SessionProvider.js";
import { StudioWizard } from "../components/studio/StudioWizard.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";

export function StudioNewPage() {
  return <RequireSession><StudioNewContent /></RequireSession>;
}

function StudioNewContent() {
  const { session } = useSession();
  const allowed = hasStudioAccess(session);
  const query = useQuery({ queryKey: ["packs"], queryFn: fetchPacks, enabled: allowed, retry: false });
  if (!allowed) return <EmptyState title="没有 Studio 权限" description="当前账号缺少 studio.manage。" />;
  if (query.isPending) return <p className="auth-loading">正在加载活动模板…</p>;
  if (query.error !== null) return <ErrorState description="活动模板暂时无法加载。" onRetry={() => void query.refetch()} />;
  return <StudioWizard packs={query.data} />;
}
```

删除旧的 preview/create/summary 逻辑（已移入向导）。

- [ ] **Step 2: 活动页接入就绪清单**

`studioActivity.tsx`：

- import `StudioReadiness`。
- header 之后、错误提示之后渲染：

```tsx
<StudioReadiness state={state} onActivate={() => void activate()} />
```

（在 `state` 可用之后；`activate` 是现有函数。）
- `DefinitionEditor` 传 `readOnly={state.activity.status === "closed" || state.activity.status === "archived"}`。

- [ ] **Step 3: 样式**

新增 `styles/studio-wizard.css`：

```css
.studio-wizard { max-width: 1180px; margin: 0 auto; padding: 48px 24px 72px; }
.studio-wizard__steps { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; margin: 0 0 20px; padding: 0; }
.studio-wizard__steps button { display: inline-flex; gap: 6px; align-items: center; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--bone-dim); cursor: pointer; }
.studio-wizard__steps .is-current button { border-color: var(--gold); color: var(--gold); }
.studio-wizard__steps .is-done button { color: var(--bone); }
.studio-wizard__steps button:disabled { opacity: 0.5; cursor: default; }
.studio-wizard__grid { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 24px; }
.studio-wizard__rail { align-self: start; }
.wizard-pack-grid { display: grid; gap: 12px; }
.wizard-pack { display: grid; gap: 4px; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.wizard-pack.is-selected { border-color: var(--gold); }
.wizard-questions { display: grid; gap: 8px; margin-top: 12px; }
.studio-readiness { margin-bottom: 20px; }
.studio-readiness__head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.studio-readiness__steps { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; list-style: none; margin: 16px 0 0; padding: 0; }
.studio-readiness__step { display: grid; gap: 6px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
.studio-readiness__step.is-current { border-color: var(--gold); }
.studio-readiness__step.is-stale { border-color: var(--ember); }
.studio-readiness__index { color: var(--bone-subtle); font-size: 0.75rem; }
.studio-readiness__title { font-weight: 700; }
.studio-readiness__detail { color: var(--bone-subtle); font-size: 0.8rem; }
@media (max-width: 1024px) { .studio-wizard__grid { grid-template-columns: 1fr; } }
@media (max-width: 900px) { .studio-readiness__steps { grid-template-columns: 1fr; } }
@media (max-width: 720px) {
  .studio-wizard__steps { overflow-x: auto; flex-wrap: nowrap; }
  .studio-wizard { padding: 24px 16px 56px; }
}
```

在 `global.css` 的 `studio.css` 后导入 `studio-wizard.css`。锚点 `scroll-margin-top: 24px` 加到 `#definition-editor, #release-panel, #session-panel`。

- [ ] **Step 4: 更新页面测试**

- `studioNew.test.tsx`：mock `fetchPacks`；断言向导首步/模板卡/下一步；创建由 `StudioWizard.test` 覆盖。
- `studioActivity.test.tsx`：state 含 draft/compiled/releases；断言就绪卡和激活按钮；archived 断言只读/无发布锚点。

- [ ] **Step 5: 运行**

```powershell
pnpm --filter @artflow-plus/web test -- studioNew studioActivity
pnpm --filter @artflow-plus/web run check
```

Expected：PASS。

- [ ] **Step 6: 提交**

```bash
git add plus/apps/web/src
git commit -m "feat(studio): wire the wizard and readiness checklist"
```

---

## Task 5: a11y、E2E 与最终门禁

**Files:**
- Modify: `plus/apps/web/e2e/studio.spec.ts`
- Modify: `plus/apps/web/e2e/a11y.spec.ts`

- [ ] **Step 1: 更新 Studio E2E**

`/studio/new` 改为 6 步：

```ts
await page.getByRole("button", { name: "下一步" }).click(); // pack 默认第一个
await page.getByLabel("活动标题").fill(title);
await page.getByRole("button", { name: "下一步" }).click();
await page.getByRole("button", { name: "下一步" }).click();
await page.getByRole("button", { name: "下一步" }).click();
await page.getByRole("button", { name: "下一步" }).click();
await expect(page.getByRole("heading", { name: "检查与创建" })).toBeVisible();
await page.getByRole("button", { name: "创建活动" }).click();
await expect(page).toHaveURL(/\/studio\/act/);
```

创建后就绪清单：

```ts
await expect(page.getByText("定义已保存")).toBeVisible();
await page.getByRole("button", { name: "激活活动" }).first().click();
await page.getByRole("button", { name: "编译定义" }).click();
await expect(page.getByText(/编译成功/)).toBeVisible();
await page.getByRole("button", { name: "发布当前编译" }).click();
await expect(page.getByText("活动已就绪")).toBeVisible();
```

保留现有 DefinitionEditor/ReleasePanel/会话断言；激活按钮现在可能同时出现在 header 和 readiness，使用 `.first()` 或 role 精确匹配。

- [ ] **Step 2: a11y 加 `/studio/new`**

`authenticatedSurfaces` 增加：

```ts
{ path: "/studio/new", ready: (page) => page.locator(".studio-wizard") },
```

- [ ] **Step 3: 跑 E2E**

```powershell
Set-Location plus
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:NO_PROXY = "127.0.0.1,localhost,::1"
$env:no_proxy = "127.0.0.1,localhost,::1"
pnpm --filter @artflow-plus/web test:e2e -- studio.spec.ts a11y.spec.ts
```

Expected：PASS。

- [ ] **Step 4: 全量门禁**

```powershell
pnpm run check
$env:REQUIRE_DB = "1"
pnpm run test
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
git commit -m "test: cover the Studio guided wizard"
```

按仓库规则合并 `feat/studio-guided-wizard` 到 `main`，推送后盯 Gates / Security / Workflow lint 全绿。
