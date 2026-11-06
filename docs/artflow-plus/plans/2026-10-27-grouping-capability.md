# Grouping Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `grouping` capability that owns group-chorus stages (groups, members, lifecycle, roster source, material window), with strict backend rules and a simple Ops flow.

**Architecture:** A new capability in `packages/domain` (definition + pure partition rules), persisted through a new Kysely migration and repository, driven by a runtime service that follows the registration command pattern (activity lock + revision CAS + command receipt + audit + outbox), exposed through Fastify routes and one Ops card.

**Tech Stack:** TypeScript 7, Kysely/PostgreSQL 18, Fastify 5 + TypeBox, Vitest, React 19 + TanStack Query/Router, Playwright.

**Spec:** `docs/artflow-plus/specs/2026-10-27-grouping-capability-design.md`

---

## File map

| File | Responsibility |
|---|---|
| `plus/packages/domain/src/capabilities/grouping.ts` | New: definition, compiler, partition validation, manifest |
| `plus/packages/domain/src/errors.ts` | Add grouping error codes |
| `plus/packages/domain/src/index.ts` | Export grouping module |
| `plus/packages/domain/src/defaults.ts` | Register grouping in default registry |
| `plus/packages/domain/src/activity-packs.ts` | Singer pack guided question + default definition |
| `plus/packages/domain/test/registry-packs.test.ts` | Update exact capability lists |
| `plus/packages/domain/test/grouping.test.ts` | New: compiler + partition tests |
| `plus/packages/db/src/types.ts` | Rows for the three tables |
| `plus/packages/db/src/migrations.ts` | Migration `0016_grouping` |
| `plus/packages/db/src/grouping-repository.ts` | New: CRUD + source reads |
| `plus/packages/db/src/index.ts` | Export repository |
| `plus/packages/db/test/grouping-repository.test.ts` | New: DB tests |
| `plus/packages/runtime/src/grouping-service.ts` | New: commands |
| `plus/packages/runtime/src/grouping-read-service.ts` | New: `getGroupingState` |
| `plus/packages/runtime/src/index.ts` | Export services |
| `plus/packages/runtime/test/grouping.test.ts` | New: lifecycle/concurrency tests |
| `plus/packages/runtime/src/archive-service.ts` | Add closure check |
| `plus/packages/runtime/src/archive-package.ts` | Add `grouping.json`/CSV |
| `plus/apps/api/src/app.ts` | Routes + TypeBox schemas |
| `plus/apps/api/test/grouping.test.ts` | New: API tests |
| `plus/apps/web/src/api/grouping.ts` | New: client |
| `plus/apps/web/src/components/ops/GroupingCard.tsx` | New: three-step card |
| `plus/apps/web/src/routes/opsActivity.tsx` | Render card |
| `plus/apps/web/src/styles/global.css` | Card styles |
| `plus/apps/web/e2e/grouping.spec.ts` | New: main journey |
| `plus/apps/api/scripts/seed-grouping.ts` | New: E2E seed |
| `plus/apps/api/scripts/seed-registration.ts` | Add `grouping.manage` permission |
| `plus/apps/api/package.json` | Add seed script to `seed:e2e` |
| `common/management/commands/export_plus_bundle.py` | Emit `grouping` section |
| `plus/packages/runtime/src/legacy-bundle.ts` | Optional `grouping` section |
| `plus/packages/runtime/src/legacy-import-service.ts` | Import grouping |
| `docs/architecture/adr/0025-grouping-capability.md` | New ADR |
| `docs/invariants/lifecycle.md` | GRP invariants |
| `docs/artflow-plus/roadmap.md` | Milestone note |
| `docs/artflow-plus/shape-validation.md` | Gap table update |

---

## Task 0: Repair the time-dependent judge session test

**Files:**
- Modify: `plus/packages/runtime/test/judge-entry-reuse.test.ts:189,208`

- [ ] **Step 1: Reproduce the failure**

Run:
```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/judge-entry-reuse.test.ts
```
Expected: FAIL with `DomainError: The judge session has expired.`

- [ ] **Step 2: Pass the same fake clock into the authenticator**

Replace both `authenticateJudgeSession(db, firstToken)` calls with a fixed timestamp inside the fake clock window:

```ts
const authenticationTime = new Date("2026-10-26T14:00:10Z");
await expect(authenticateJudgeSession(db, firstToken, authenticationTime)).resolves.toMatchObject({
  activityId,
  seatId: claimed.body.seatId,
});
```

```ts
await expect(authenticateJudgeSession(db, firstToken, authenticationTime)).rejects.toMatchObject({
  code: "UNAUTHENTICATED",
});
```

- [ ] **Step 3: Verify the test passes**

Run the command from Step 1. Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```powershell
git add plus/packages/runtime/test/judge-entry-reuse.test.ts
git commit -m "test(runtime): pin the judge session authenticator clock"
```

---

## Task 1: Domain capability and partition rules

**Files:**
- Create: `plus/packages/domain/src/capabilities/grouping.ts`
- Modify: `plus/packages/domain/src/errors.ts` (append codes before the closing `;`)
- Create: `plus/packages/domain/test/grouping.test.ts`

- [ ] **Step 1: Write the failing domain test**

Create `plus/packages/domain/test/grouping.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  compileGroupingDefinition,
  createGroupingDefinition,
  groupingCapability,
  normalizeGroupingGroups,
} from "../src/index.js";

describe("grouping definition", () => {
  it("compiles an unconstrained definition", () => {
    const compiled = compileGroupingDefinition(createGroupingDefinition());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact).toEqual({ schemaVersion: 1 });
  });

  it("compiles a groupCount constraint", () => {
    const compiled = compileGroupingDefinition(createGroupingDefinition(5));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact).toEqual({ schemaVersion: 1, groupCount: 5 });
  });

  it("rejects a non-positive groupCount", () => {
    const compiled = compileGroupingDefinition({
      schemaVersion: 1,
      payload: { schemaVersion: 1, groupCount: 0 },
    });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.issues.map((item) => item.code)).toContain("GROUP_COUNT_INVALID");
  });

  it("registers dependencies, commands, and the ops surface", () => {
    expect(groupingCapability.manifest.dependencies).toEqual(["registration", "competition"]);
    expect(groupingCapability.manifest.surfaces).toEqual(["ops"]);
    expect(groupingCapability.manifest.permissions).toEqual(["grouping.manage"]);
    expect(groupingCapability.manifest.scopes).toEqual([]);
    expect(groupingCapability.manifest.commands).toContain("grouping.stage.freeze");
  });
});

describe("grouping partition rules", () => {
  const allowed = new Set(["p1", "p2", "p3"]);

  it("defaults names by position and accepts unequal sizes", () => {
    const groups = normalizeGroupingGroups(
      [
        { participantIds: ["p1", "p2"] },
        { name: "B 组", participantIds: ["p3"] },
      ],
      allowed,
      { complete: true, groupCount: 2 },
    );
    expect(groups).toEqual([
      { name: "第 1 组", participantIds: ["p1", "p2"] },
      { name: "B 组", participantIds: ["p3"] },
    ]);
  });

  it("rejects an incomplete partition when completeness is required", () => {
    expect(() =>
      normalizeGroupingGroups([{ participantIds: ["p1"] }], allowed, { complete: true }),
    ).toThrowError(/missing participants/);
  });

  it("allows an incomplete draft", () => {
    const groups = normalizeGroupingGroups([{ participantIds: ["p1"] }], allowed, {
      complete: false,
    });
    expect(groups).toHaveLength(1);
  });

  it("rejects a participant outside the source roster", () => {
    expect(() =>
      normalizeGroupingGroups([{ participantIds: ["p9"] }], allowed, { complete: false }),
    ).toThrowError(/not in the source roster/);
  });

  it("rejects a participant in two groups", () => {
    expect(() =>
      normalizeGroupingGroups(
        [{ participantIds: ["p1"] }, { participantIds: ["p1"] }],
        allowed,
        { complete: false },
      ),
    ).toThrowError(/cannot belong to two groups/);
  });

  it("rejects a group-count mismatch", () => {
    expect(() =>
      normalizeGroupingGroups(
        [{ participantIds: ["p1", "p2", "p3"] }],
        allowed,
        { complete: true, groupCount: 2 },
      ),
    ).toThrowError(/needs exactly 2 groups/);
  });

  it("rejects duplicate group names", () => {
    expect(() =>
      normalizeGroupingGroups(
        [{ name: "A", participantIds: ["p1"] }, { name: "A", participantIds: ["p2"] }],
        allowed,
        { complete: false },
      ),
    ).toThrowError(/is duplicated/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
pnpm -C plus --filter @artflow-plus/domain exec vitest run test/grouping.test.ts
```
Expected: FAIL — cannot resolve `../src/index.js` exports for grouping.

- [ ] **Step 3: Add the error codes**

In `plus/packages/domain/src/errors.ts`, append to the `DomainErrorCode` union before `"RATE_LIMITED"`:

```ts
  | "GROUPING_STAGE_EXISTS"
  | "GROUPING_NOT_DRAFT"
  | "GROUPING_SOURCE_UNKNOWN"
  | "GROUPING_INCOMPLETE"
  | "GROUPING_SOURCE_CHANGED"
  | "GROUPING_GROUP_COUNT"
  | "GROUPING_CONSUMED"
  | "GROUPING_WINDOW_INVALID"
  | "ARCHIVE_GROUPING_NOT_FROZEN"
```

- [ ] **Step 4: Create the capability module**

Create `plus/packages/domain/src/capabilities/grouping.ts`:

```ts
import { capabilityDefinitionHash } from "../compiler.js";
import { fail } from "../errors.js";
import type {
  CapabilityCompileResult,
  CapabilityCompiler,
  CapabilityDefinition,
  CompileIssue,
  CompiledCapabilityPlan,
} from "../model.js";
import { deepFreeze } from "../model.js";
import type { CapabilityRegistration } from "../registry.js";

export type GroupingRosterSource = "all_approved" | "round_advanced";
export type GroupingStageStatus = "draft" | "confirmed" | "frozen" | "cancelled";
export type GroupingMaterialWindow = "closed" | "open" | "supplement_only";

export interface GroupingDefinition {
  readonly schemaVersion: 1;
  readonly groupCount?: number;
}

export interface CompiledGroupingArtifact {
  readonly schemaVersion: 1;
  readonly groupCount?: number;
}

export interface GroupingGroupSpec {
  readonly name?: string;
  readonly participantIds: readonly string[];
}

export interface NormalizedGroupingGroup {
  readonly name: string;
  readonly participantIds: readonly string[];
}

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

export function createGroupingDefinition(groupCount?: number): CapabilityDefinition {
  const payload: GroupingDefinition =
    groupCount === undefined ? { schemaVersion: 1 } : { schemaVersion: 1, groupCount };
  return { schemaVersion: 1, payload };
}

export function createEmptyGroupingDefinition(): CapabilityDefinition {
  return createGroupingDefinition();
}

export function compileGroupingDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const payload = definition.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return deepFreeze({
      ok: false,
      issues: [issue("PAYLOAD_INVALID", "Not a grouping definition.", "payload")],
    });
  }
  const candidate = payload as Partial<GroupingDefinition>;
  const issues: CompileIssue[] = [];
  if (candidate.schemaVersion !== 1) {
    issues.push(issue("SCHEMA_VERSION", "Only schemaVersion 1 is supported.", "schemaVersion"));
  }
  if (
    candidate.groupCount !== undefined &&
    (!Number.isInteger(candidate.groupCount) || candidate.groupCount < 1)
  ) {
    issues.push(issue("GROUP_COUNT_INVALID", "groupCount must be a positive integer.", "groupCount"));
  }
  if (issues.length > 0) return deepFreeze({ ok: false, issues });

  const artifact: CompiledGroupingArtifact =
    candidate.groupCount === undefined
      ? { schemaVersion: 1 }
      : { schemaVersion: 1, groupCount: candidate.groupCount };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "grouping",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export const groupingCompiler: CapabilityCompiler = {
  capabilityKey: "grouping",
  compile: compileGroupingDefinition,
};

/**
 * The single authority for turning external group specs into a stage partition.
 * Drafts may be incomplete; confirm/freeze/correct must cover the source roster.
 */
export function normalizeGroupingGroups(
  specs: readonly GroupingGroupSpec[],
  allowedParticipantIds: ReadonlySet<string>,
  options: { readonly complete: boolean; readonly groupCount?: number },
): readonly NormalizedGroupingGroup[] {
  if (!Array.isArray(specs) || specs.length === 0) {
    fail("INVALID_INPUT", "A grouping stage needs at least one group.");
  }
  const names = new Set<string>();
  const seen = new Set<string>();
  const normalized: NormalizedGroupingGroup[] = [];

  specs.forEach((spec, index) => {
    const name = (spec.name ?? "").trim() || `第 ${index + 1} 组`;
    if (names.has(name)) fail("INVALID_INPUT", `Group name ${name} is duplicated.`);
    names.add(name);
    if (!Array.isArray(spec.participantIds) || spec.participantIds.length === 0) {
      fail("INVALID_INPUT", `Group ${name} must contain at least one participant.`);
    }
    const members: string[] = [];
    for (const rawId of spec.participantIds) {
      const participantId = String(rawId).trim();
      if (!allowedParticipantIds.has(participantId)) {
        fail("GROUPING_SOURCE_UNKNOWN", "A group member is not in the source roster.");
      }
      if (seen.has(participantId)) {
        fail("INVALID_INPUT", "A participant cannot belong to two groups.");
      }
      seen.add(participantId);
      members.push(participantId);
    }
    normalized.push({ name, participantIds: members });
  });

  if (options.complete) {
    const missing = [...allowedParticipantIds].filter((id) => !seen.has(id)).sort();
    if (missing.length > 0) {
      fail("GROUPING_INCOMPLETE", `The partition is missing participants: ${missing.join(",")}.`);
    }
    if (seen.size !== allowedParticipantIds.size) {
      fail("GROUPING_INCOMPLETE", "The partition does not exactly cover the source roster.");
    }
  }
  if (options.groupCount !== undefined && normalized.length !== options.groupCount) {
    fail(
      "GROUPING_GROUP_COUNT",
      `The stage needs exactly ${options.groupCount} groups, received ${normalized.length}.`,
    );
  }
  return deepFreeze(normalized);
}

export const groupingCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "grouping",
    version: "1",
    dependencies: ["registration", "competition"],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "grouping.stage.create",
      "grouping.groups.record",
      "grouping.stage.confirm",
      "grouping.stage.freeze",
      "grouping.stage.correct",
      "grouping.stage.cancel",
      "grouping.window.set",
    ],
    queries: ["grouping.describe"],
    events: [
      "GroupingStageCreated",
      "GroupingGroupsRecorded",
      "GroupingStageConfirmed",
      "GroupingStageFrozen",
      "GroupingStageCorrected",
      "GroupingStageCancelled",
      "GroupingMaterialWindowChanged",
    ],
    permissions: ["grouping.manage"],
    surfaces: ["ops"],
    scopes: [],
  },
  compiler: groupingCompiler,
  emptyDefinition: createEmptyGroupingDefinition,
});
```

- [ ] **Step 5: Export it**

Add to `plus/packages/domain/src/index.ts` after the archive line:

```ts
export * from "./capabilities/grouping.js";
```

- [ ] **Step 6: Run the tests**

```powershell
pnpm -C plus --filter @artflow-plus/domain exec vitest run test/grouping.test.ts
```
Expected: PASS (11 tests).

- [ ] **Step 7: Commit**

```powershell
git add plus/packages/domain/src/capabilities/grouping.ts plus/packages/domain/src/errors.ts plus/packages/domain/src/index.ts plus/packages/domain/test/grouping.test.ts
git commit -m "feat(domain): add the grouping capability and partition rules"
```

---

## Task 2: Register the capability and the Singer Pack question

**Files:**
- Modify: `plus/packages/domain/src/defaults.ts`
- Modify: `plus/packages/domain/src/activity-packs.ts`
- Modify: `plus/packages/domain/test/registry-packs.test.ts`

- [ ] **Step 1: Update the pack test first**

In `plus/packages/domain/test/registry-packs.test.ts`:

Add to `SINGER_CAPABILITIES`:

```ts
  stubCapability("grouping", { dependencies: ["registration", "competition"] }),
```

Change the default registry expectation at line ~278 to:

```ts
  expect(defaultCapabilityRegistry.list().map((item) => item.manifest.identity)).toEqual([
    "archive",
    "competition",
    "grouping",
    "materials",
    "publishing",
    "questionnaire",
    "registration",
    "ticketing",
    "voting",
  ]);
```

Change the singer pack's exact list at line ~231 to:

```ts
  expect(result.instantiation.enabledCapabilities).toEqual([
    "archive",
    "competition",
    "grouping",
    "materials",
    "publishing",
    "questionnaire",
    "registration",
  ]);
```

Also update the two API test fixtures that build a custom registry:

In `plus/apps/api/test/skeleton.test.ts`, add to `skeletonRegistry()`:

```ts
    stubCapability("grouping"),
```

In `plus/apps/api/test/http.test.ts`:

- The `/api/capabilities` assertion changes from 8 to 9:

```ts
  expect(body.capabilities).toHaveLength(9);
```

- Its identity list gains `"grouping"` between `"competition"` and `"materials"`.
- The `identities` array in "instantiates a pack once every capability is registered"
  gains `"grouping"` between `"competition"` and `"registration"`.

In `plus/packages/domain/test/registration-capabilities.test.ts`, the "default Singer
Pack instantiates with all M4 capabilities" expectation gains `"grouping"` between
`"competition"` and `"materials"`.

- [ ] **Step 2: Run it and confirm it fails**

```powershell
pnpm -C plus --filter @artflow-plus/domain exec vitest run test/registry-packs.test.ts
```
Expected: FAIL — the registry list has no grouping.

- [ ] **Step 3: Register the default capability**

In `plus/packages/domain/src/defaults.ts`, import and add:

```ts
import { groupingCapability } from "./capabilities/grouping.js";
```

```ts
    publishingCapability,
    archiveCapability,
    groupingCapability,
```

- [ ] **Step 4: Add the guided question and default definition**

In `plus/packages/domain/src/activity-packs.ts`, import:

```ts
import { createGroupingDefinition } from "./capabilities/grouping.js";
```

Add a question after `collect-materials`:

```ts
    {
      id: "grouping",
      prompt: "需要第一轮分组/合唱吗？",
      capability: "grouping",
      default: true,
    },
```

Add to `definitions`:

```ts
    grouping: createGroupingDefinition(5),
```

- [ ] **Step 5: Run the pack tests**

```powershell
pnpm -C plus --filter @artflow-plus/domain test
```
Expected: PASS (all domain tests).

- [ ] **Step 6: Commit**

```powershell
git add plus/packages/domain/src/defaults.ts plus/packages/domain/src/activity-packs.ts plus/packages/domain/test/registry-packs.test.ts
git commit -m "feat(packs): enable grouping in the Singer Pack"
```

---

## Task 3: Persistence (migration, types, repository)

**Files:**
- Modify: `plus/packages/db/src/types.ts`
- Modify: `plus/packages/db/src/migrations.ts`
- Create: `plus/packages/db/src/grouping-repository.ts`
- Modify: `plus/packages/db/src/index.ts`
- Create: `plus/packages/db/test/grouping-repository.test.ts`

- [ ] **Step 1: Write the failing repository test**

Create `plus/packages/db/test/grouping-repository.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { Kysely } from "kysely";

import {
  closeDb,
  createDb,
  getGroupingStageByKey,
  insertGroupingGroup,
  insertGroupingMembership,
  insertGroupingStage,
  listCurrentGroupingMemberships,
  listGroupingGroups,
  listGroupingStages,
  migrate,
  updateGroupingStage,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_grouping_repo_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const stage = {
  id: "grouping_stage_test",
  activityId: "activity-test",
  stageKey: "chorus",
  name: "分组合唱",
  status: "draft" as const,
  rosterSource: "all_approved" as const,
  sourceFingerprint: "",
  materialWindow: "closed" as const,
  cancelReason: "",
  revision: 1,
};

describe.skipIf(!connectionString)("grouping repository", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await db.insertInto("activity").values({
      id: "activity-test",
      public_code: "activity-test",
      title: "Grouping",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["grouping"]),
      active_definition_version: 1,
    }).execute();
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("stores a stage, groups, and current memberships", async () => {
    await insertGroupingStage(db, stage, "2026-10-27T10:00:00Z");
    await insertGroupingGroup(db, {
      id: "grouping_group_a",
      stageId: stage.id,
      groupOrder: 1,
      name: "A 组",
      isActive: true,
    }, "2026-10-27T10:00:01Z");
    await insertGroupingMembership(db, {
      id: "grouping_member_p1",
      stageId: stage.id,
      groupId: "grouping_group_a",
      participantId: "p1",
      isCurrent: true,
      joinedAt: "2026-10-27T10:00:02Z",
      reason: "",
    });

    const found = await getGroupingStageByKey(db, "activity-test", "chorus");
    expect(found?.status).toBe("draft");
    const groups = await listGroupingGroups(db, [stage.id]);
    expect(groups).toHaveLength(1);
    const members = await listCurrentGroupingMemberships(db, stage.id);
    expect(members.map((item) => item.participantId)).toEqual(["p1"]);
    expect((await listGroupingStages(db, "activity-test"))).toHaveLength(1);
  });

  it("enforces one current membership per participant per stage", async () => {
    await expect(
      insertGroupingMembership(db, {
        id: "grouping_member_duplicate",
        stageId: stage.id,
        groupId: "grouping_group_a",
        participantId: "p1",
        isCurrent: true,
        joinedAt: "2026-10-27T10:00:03Z",
        reason: "",
      }),
    ).rejects.toThrow();
  });

  it("updates a stage only at the expected revision", async () => {
    const current = await getGroupingStageByKey(db, "activity-test", "chorus");
    expect(current).not.toBeNull();
    if (current === null) return;
    const saved = await updateGroupingStage(
      db,
      { ...current, status: "confirmed", confirmedAt: "2026-10-27T10:01:00Z", confirmedBy: "staff", revision: 2 },
      current.revision,
    );
    expect(saved).toBe(true);
    const stale = await updateGroupingStage(
      db,
      { ...current, status: "frozen", revision: 3 },
      current.revision,
    );
    expect(stale).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus --filter @artflow-plus/db exec vitest run test/grouping-repository.test.ts
```
Expected: FAIL — `getGroupingStageByKey` is not exported.

- [ ] **Step 3: Add row types**

In `plus/packages/db/src/types.ts`, add before the `Database` interface:

```ts
export interface GroupingStageRow {
  id: string;
  activity_id: string;
  stage_key: string;
  name: string;
  status: string;
  roster_source: string;
  source_round_id: string | null;
  source_fingerprint: string;
  material_window: string;
  cancel_reason: string;
  confirmed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  confirmed_by: string | null;
  frozen_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  frozen_by: string | null;
  cancelled_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  cancelled_by: string | null;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface GroupingGroupRow {
  id: string;
  stage_id: string;
  group_order: number;
  name: string;
  is_active: boolean;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface GroupingMembershipRow {
  id: string;
  stage_id: string;
  group_id: string;
  participant_id: string;
  is_current: boolean;
  joined_at: ColumnType<Date, Date | string, Date | string>;
  left_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  removed_by: string | null;
  reason: string;
}
```

Add to the `Database` interface:

```ts
  grouping_stage: GroupingStageRow;
  grouping_group: GroupingGroupRow;
  grouping_membership: GroupingMembershipRow;
```

- [ ] **Step 4: Add migration `0016_grouping`**

In `plus/packages/db/src/migrations.ts`, append after the `0015_mode_isolation` entry:

```ts
  "0016_grouping": {
    async up(db: Kysely<Database>): Promise<void> {
      await sql`
        create table grouping_stage (
          id varchar(100) primary key,
          activity_id varchar(100) not null references activity(id) on delete cascade,
          stage_key varchar(100) not null,
          name varchar(200) not null,
          status varchar(20) not null default 'draft'
            check (status in ('draft', 'confirmed', 'frozen', 'cancelled')),
          roster_source varchar(20) not null default 'all_approved'
            check (roster_source in ('all_approved', 'round_advanced')),
          source_round_id varchar(100) references competition_round(id),
          source_fingerprint varchar(128) not null default '',
          material_window varchar(20) not null default 'closed'
            check (material_window in ('closed', 'open', 'supplement_only')),
          cancel_reason text not null default '',
          confirmed_at timestamptz,
          confirmed_by varchar(100),
          frozen_at timestamptz,
          frozen_by varchar(100),
          cancelled_at timestamptz,
          cancelled_by varchar(100),
          revision integer not null default 1,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique (activity_id, stage_key),
          check (
            (roster_source = 'round_advanced' and source_round_id is not null) or
            (roster_source = 'all_approved' and source_round_id is null)
          )
        );
        create index grouping_stage_activity_idx on grouping_stage(activity_id, revision);

        create table grouping_group (
          id varchar(100) primary key,
          stage_id varchar(100) not null references grouping_stage(id) on delete cascade,
          group_order integer not null check (group_order >= 1),
          name varchar(200) not null,
          is_active boolean not null default true,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
        create unique index grouping_group_active_order_key
          on grouping_group(stage_id, group_order) where is_active = true;
        -- Group names are unique by the domain rule, not a unique index: a
        -- correction that swaps two names would otherwise collide mid-update.

        create table grouping_membership (
          id varchar(100) primary key,
          stage_id varchar(100) not null references grouping_stage(id) on delete cascade,
          group_id varchar(100) not null references grouping_group(id) on delete cascade,
          participant_id varchar(100) not null,
          is_current boolean not null default true,
          joined_at timestamptz not null default now(),
          left_at timestamptz,
          removed_by varchar(100),
          reason text not null default ''
        );
        create unique index grouping_membership_current_key
          on grouping_membership(stage_id, participant_id) where is_current = true;
        create index grouping_membership_group_idx
          on grouping_membership(group_id) where is_current = true;
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`
        drop table if exists grouping_membership;
        drop table if exists grouping_group;
        drop table if exists grouping_stage;
      `.execute(db);
    },
  },
```

- [ ] **Step 5: Create the repository**

Create `plus/packages/db/src/grouping-repository.ts`:

```ts
import type { GroupingMaterialWindow, GroupingRosterSource, GroupingStageStatus } from "@artflow-plus/domain";
import type { Kysely, Selectable } from "kysely";

import type {
  Database,
  GroupingGroupRow,
  GroupingMembershipRow,
  GroupingStageRow,
} from "./types.js";

export interface StoredGroupingStage {
  readonly id: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly name: string;
  readonly status: GroupingStageStatus;
  readonly rosterSource: GroupingRosterSource;
  readonly sourceRoundId?: string;
  readonly sourceFingerprint: string;
  readonly materialWindow: GroupingMaterialWindow;
  readonly cancelReason: string;
  readonly confirmedAt?: string;
  readonly confirmedBy?: string;
  readonly frozenAt?: string;
  readonly frozenBy?: string;
  readonly cancelledAt?: string;
  readonly cancelledBy?: string;
  readonly revision: number;
}

export interface StoredGroupingGroup {
  readonly id: string;
  readonly stageId: string;
  readonly groupOrder: number;
  readonly name: string;
  readonly isActive: boolean;
}

export interface StoredGroupingMembership {
  readonly id: string;
  readonly stageId: string;
  readonly groupId: string;
  readonly participantId: string;
  readonly isCurrent: boolean;
  readonly joinedAt: string;
  readonly leftAt?: string;
  readonly removedBy?: string;
  readonly reason: string;
}

function iso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stage(row: Selectable<GroupingStageRow>): StoredGroupingStage {
  return {
    id: row.id,
    activityId: row.activity_id,
    stageKey: row.stage_key,
    name: row.name,
    status: row.status as GroupingStageStatus,
    rosterSource: row.roster_source as GroupingRosterSource,
    ...(row.source_round_id === null ? {} : { sourceRoundId: row.source_round_id }),
    sourceFingerprint: row.source_fingerprint,
    materialWindow: row.material_window as GroupingMaterialWindow,
    cancelReason: row.cancel_reason,
    ...(iso(row.confirmed_at) === undefined ? {} : { confirmedAt: iso(row.confirmed_at) }),
    ...(row.confirmed_by === null ? {} : { confirmedBy: row.confirmed_by }),
    ...(iso(row.frozen_at) === undefined ? {} : { frozenAt: iso(row.frozen_at) }),
    ...(row.frozen_by === null ? {} : { frozenBy: row.frozen_by }),
    ...(iso(row.cancelled_at) === undefined ? {} : { cancelledAt: iso(row.cancelled_at) }),
    ...(row.cancelled_by === null ? {} : { cancelledBy: row.cancelled_by }),
    revision: row.revision,
  };
}

function group(row: Selectable<GroupingGroupRow>): StoredGroupingGroup {
  return {
    id: row.id,
    stageId: row.stage_id,
    groupOrder: row.group_order,
    name: row.name,
    isActive: row.is_active,
  };
}

function membership(row: Selectable<GroupingMembershipRow>): StoredGroupingMembership {
  return {
    id: row.id,
    stageId: row.stage_id,
    groupId: row.group_id,
    participantId: row.participant_id,
    isCurrent: row.is_current,
    joinedAt: iso(row.joined_at) ?? new Date().toISOString(),
    ...(iso(row.left_at) === undefined ? {} : { leftAt: iso(row.left_at) }),
    ...(row.removed_by === null ? {} : { removedBy: row.removed_by }),
    reason: row.reason,
  };
}

export async function insertGroupingStage(
  db: Kysely<Database>,
  value: StoredGroupingStage,
  createdAt: string,
): Promise<void> {
  await db.insertInto("grouping_stage").values({
    id: value.id,
    activity_id: value.activityId,
    stage_key: value.stageKey,
    name: value.name,
    status: value.status,
    roster_source: value.rosterSource,
    source_round_id: value.sourceRoundId ?? null,
    source_fingerprint: value.sourceFingerprint,
    material_window: value.materialWindow,
    cancel_reason: value.cancelReason,
    confirmed_at: value.confirmedAt ?? null,
    confirmed_by: value.confirmedBy ?? null,
    frozen_at: value.frozenAt ?? null,
    frozen_by: value.frozenBy ?? null,
    cancelled_at: value.cancelledAt ?? null,
    cancelled_by: value.cancelledBy ?? null,
    revision: value.revision,
    created_at: new Date(createdAt),
    updated_at: createdAt,
  }).execute();
}

export async function getGroupingStageForUpdate(
  db: Kysely<Database>,
  activityId: string,
  stageId: string,
): Promise<StoredGroupingStage | null> {
  const row = await db.selectFrom("grouping_stage").selectAll()
    .where("id", "=", stageId).where("activity_id", "=", activityId)
    .forUpdate().executeTakeFirst();
  return row === undefined ? null : stage(row);
}

export async function getGroupingStageByKey(
  db: Kysely<Database>,
  activityId: string,
  stageKey: string,
): Promise<StoredGroupingStage | null> {
  const row = await db.selectFrom("grouping_stage").selectAll()
    .where("activity_id", "=", activityId).where("stage_key", "=", stageKey)
    .executeTakeFirst();
  return row === undefined ? null : stage(row);
}

export async function listGroupingStages(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredGroupingStage[]> {
  const rows = await db.selectFrom("grouping_stage").selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("stage_key", "asc").execute();
  return rows.map(stage);
}

export async function updateGroupingStage(
  db: Kysely<Database>,
  value: StoredGroupingStage,
  expectedRevision: number,
): Promise<boolean> {
  const result = await db.updateTable("grouping_stage").set({
    name: value.name,
    status: value.status,
    roster_source: value.rosterSource,
    source_round_id: value.sourceRoundId ?? null,
    source_fingerprint: value.sourceFingerprint,
    material_window: value.materialWindow,
    cancel_reason: value.cancelReason,
    confirmed_at: value.confirmedAt ?? null,
    confirmed_by: value.confirmedBy ?? null,
    frozen_at: value.frozenAt ?? null,
    frozen_by: value.frozenBy ?? null,
    cancelled_at: value.cancelledAt ?? null,
    cancelled_by: value.cancelledBy ?? null,
    revision: value.revision,
    updated_at: new Date().toISOString(),
  })
    .where("id", "=", value.id)
    .where("activity_id", "=", value.activityId)
    .where("revision", "=", expectedRevision)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

export async function insertGroupingGroup(
  db: Kysely<Database>,
  value: StoredGroupingGroup,
  createdAt: string,
): Promise<void> {
  await db.insertInto("grouping_group").values({
    id: value.id,
    stage_id: value.stageId,
    group_order: value.groupOrder,
    name: value.name,
    is_active: value.isActive,
    created_at: new Date(createdAt),
    updated_at: createdAt,
  }).execute();
}

export async function updateGroupingGroup(
  db: Kysely<Database>,
  value: StoredGroupingGroup,
): Promise<void> {
  await db.updateTable("grouping_group")
    .set({
      group_order: value.groupOrder,
      name: value.name,
      is_active: value.isActive,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", value.id).execute();
}

export async function deactivateGroupingGroups(
  db: Kysely<Database>,
  stageId: string,
  exceptGroupIds: readonly string[],
): Promise<void> {
  const active = await db.selectFrom("grouping_group").select("id")
    .where("stage_id", "=", stageId).where("is_active", "=", true).execute();
  const keep = new Set(exceptGroupIds);
  const toDeactivate = active.map((row) => row.id).filter((id) => !keep.has(id));
  if (toDeactivate.length === 0) return;
  await db.updateTable("grouping_group")
    .set({ is_active: false, updated_at: new Date().toISOString() })
    .where("id", "in", toDeactivate)
    .execute();
}

export async function deleteGroupingGroups(
  db: Kysely<Database>,
  stageId: string,
): Promise<void> {
  await db.deleteFrom("grouping_group").where("stage_id", "=", stageId).execute();
}

export async function listGroupingGroups(
  db: Kysely<Database>,
  stageIds: readonly string[],
): Promise<readonly StoredGroupingGroup[]> {
  if (stageIds.length === 0) return [];
  const rows = await db.selectFrom("grouping_group").selectAll()
    .where("stage_id", "in", [...stageIds])
    .orderBy("stage_id", "asc").orderBy("group_order", "asc").execute();
  return rows.map(group);
}

export async function insertGroupingMembership(
  db: Kysely<Database>,
  value: StoredGroupingMembership,
): Promise<void> {
  await db.insertInto("grouping_membership").values({
    id: value.id,
    stage_id: value.stageId,
    group_id: value.groupId,
    participant_id: value.participantId,
    is_current: value.isCurrent,
    joined_at: value.joinedAt,
    left_at: value.leftAt ?? null,
    removed_by: value.removedBy ?? null,
    reason: value.reason,
  }).execute();
}

export async function closeCurrentGroupingMemberships(
  db: Kysely<Database>,
  stageId: string,
  leftAt: string,
  removedBy: string,
  reason: string,
): Promise<void> {
  await db.updateTable("grouping_membership")
    .set({ is_current: false, left_at: leftAt, removed_by: removedBy, reason })
    .where("stage_id", "=", stageId)
    .where("is_current", "=", true)
    .execute();
}

export async function listCurrentGroupingMemberships(
  db: Kysely<Database>,
  stageId: string,
): Promise<readonly StoredGroupingMembership[]> {
  const rows = await db.selectFrom("grouping_membership").selectAll()
    .where("stage_id", "=", stageId).where("is_current", "=", true)
    .orderBy("group_id", "asc").orderBy("participant_id", "asc").execute();
  return rows.map(membership);
}

export async function listGroupingMembershipsForStages(
  db: Kysely<Database>,
  stageIds: readonly string[],
): Promise<readonly StoredGroupingMembership[]> {
  if (stageIds.length === 0) return [];
  const rows = await db.selectFrom("grouping_membership").selectAll()
    .where("stage_id", "in", [...stageIds]).where("is_current", "=", true)
    .orderBy("stage_id", "asc").orderBy("group_id", "asc").orderBy("participant_id", "asc").execute();
  return rows.map(membership);
}

export async function listParticipantLabels(
  db: Kysely<Database>,
  activityId: string,
): Promise<ReadonlyMap<string, string>> {
  const registrations = await db.selectFrom("registration")
    .select(["participant_id", "answers"])
    .where("activity_id", "=", activityId).execute();
  const accounts = await db.selectFrom("local_account")
    .select(["actor_id", "username"]).execute();
  const usernames = new Map(accounts.map((row) => [row.actor_id, row.username]));
  const labels = new Map<string, string>();
  for (const row of registrations) {
    let name = "";
    try {
      const answers = typeof row.answers === "string" ? JSON.parse(row.answers) : row.answers;
      if (answers !== null && typeof answers === "object") {
        const value = (answers as Record<string, unknown>).name;
        if (typeof value === "string") name = value.trim();
      }
    } catch {
      name = "";
    }
    labels.set(row.participant_id, name || usernames.get(row.participant_id) || row.participant_id);
  }
  return labels;
}
```

- [ ] **Step 6: Export the repository**

Add to `plus/packages/db/src/index.ts`:

```ts
export * from "./grouping-repository.js";
```

- [ ] **Step 7: Run the repository tests**

```powershell
pnpm -C plus --filter @artflow-plus/db exec vitest run test/grouping-repository.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```powershell
git add plus/packages/db/src/types.ts plus/packages/db/src/migrations.ts plus/packages/db/src/grouping-repository.ts plus/packages/db/src/index.ts plus/packages/db/test/grouping-repository.test.ts
git commit -m "feat(db): persist grouping stages, groups, and memberships"
```

---

## Task 4: Runtime — source resolution, create, record, confirm, freeze

**Files:**
- Create: `plus/packages/runtime/src/grouping-service.ts`
- Create: `plus/packages/runtime/test/grouping.test.ts`
- Modify: `plus/packages/runtime/src/index.ts`

- [ ] **Step 1: Write the failing runtime test**

Create `plus/packages/runtime/test/grouping.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  insertRelease,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";

import {
  confirmGroupingStage,
  createGroupingStage,
  freezeGroupingStage,
  recordGroupingGroups,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_grouping_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let dbB: Kysely<Database>;
let admin: Client;

const staff: ActorContext = {
  actorId: "grouping-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["grouping.manage"],
};

function deps(): RuntimeDeps {
  return {
    actor: staff,
    now: () => new Date().toISOString(),
    newEventId: () => randomUUID(),
  };
}

async function seedActivity(participants: readonly string[]): Promise<string> {
  const activityId = `grouping-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "Grouping test",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "competition", "grouping"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "grouping-release",
    capabilities: {
      grouping: {
        ok: true,
        capabilityKey: "grouping",
        contentHash: "grouping-artifact",
        artifact: { schemaVersion: 1, groupCount: 2 },
      },
    },
    executionPolicy: { declaredScopes: [], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { grouping: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
  await db.insertInto("roster").values({
    activity_id: activityId,
    status: "final",
    approved_count: participants.length,
    revision: 1,
    finalized_at: "2026-10-27T09:30:00Z",
    updated_at: new Date(),
  }).execute();
  for (const participantId of participants) {
    await db.insertInto("registration").values({
      id: `registration-${activityId}-${participantId}`,
      activity_id: activityId,
      participant_id: participantId,
      questionnaire_version: "v1",
      questionnaire_hash: "hash",
      status: "approved",
      answers: JSON.stringify({ name: participantId.toUpperCase() }),
      revision: 1,
      review_note: "",
      reviewed_by: "staff",
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
  }
  return activityId;
}

describe.skipIf(!connectionString)("grouping lifecycle", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    dbB = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await closeDb(dbB);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("runs draft → confirmed → frozen and rejects a changed source", async () => {
    const activityId = await seedActivity(["p1", "p2", "p3"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-1",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    expect(created.body.status).toBe("draft");

    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "record-1",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [
        { name: "A", participantIds: ["p1", "p2"] },
        { name: "B", participantIds: ["p3"] },
      ],
    });
    expect(recorded.body.revision).toBe(2);

    await expect(
      recordGroupingGroups(db, deps(), {
        commandId: "record-partial",
        activityId,
        stageId: created.body.id,
        expectedRevision: recorded.body.revision,
        groups: [{ name: "A", participantIds: ["p1"] }],
      }),
    ).resolves.toBeTruthy();

    const recordedAgain = await recordGroupingGroups(db, deps(), {
      commandId: "record-2",
      activityId,
      stageId: created.body.id,
      expectedRevision: recorded.body.revision + 1,
      groups: [
        { name: "A", participantIds: ["p1", "p2"] },
        { name: "B", participantIds: ["p3"] },
      ],
    });

    const confirmed = await confirmGroupingStage(db, deps(), {
      commandId: "confirm-1",
      activityId,
      stageId: created.body.id,
      expectedRevision: recordedAgain.body.revision,
    });
    expect(confirmed.body.status).toBe("confirmed");
    expect(confirmed.body.sourceFingerprint).not.toBe("");

    const frozen = await freezeGroupingStage(db, deps(), {
      commandId: "freeze-1",
      activityId,
      stageId: created.body.id,
      expectedRevision: confirmed.body.revision,
    });
    expect(frozen.body.status).toBe("frozen");
  });

  it("rejects a confirmation that does not cover the roster", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-2",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "record-3",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1"] }],
    });
    await expect(
      confirmGroupingStage(db, deps(), {
        commandId: "confirm-2",
        activityId,
        stageId: created.body.id,
        expectedRevision: recorded.body.revision,
      }),
    ).rejects.toMatchObject({ code: "GROUPING_INCOMPLETE" });
  });

  it("rejects a group count that disagrees with the release", async () => {
    const activityId = await seedActivity(["p1", "p2", "p3"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-3",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "record-4",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1", "p2", "p3"] }],
    });
    await expect(
      confirmGroupingStage(db, deps(), {
        commandId: "confirm-3",
        activityId,
        stageId: created.body.id,
        expectedRevision: recorded.body.revision,
      }),
    ).rejects.toMatchObject({ code: "GROUPING_GROUP_COUNT" });
  });

  it("rejects a frozen stage when the roster changes after confirmation", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-4",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "record-5",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1"] }, { name: "B", participantIds: ["p2"] }],
    });
    const confirmed = await confirmGroupingStage(db, deps(), {
      commandId: "confirm-4",
      activityId,
      stageId: created.body.id,
      expectedRevision: recorded.body.revision,
    });
    await db.updateTable("roster").set({ approved_count: 3, revision: 2 })
      .where("activity_id", "=", activityId).execute();
    await expect(
      freezeGroupingStage(db, deps(), {
        commandId: "freeze-2",
        activityId,
        stageId: created.body.id,
        expectedRevision: confirmed.body.revision,
      }),
    ).rejects.toMatchObject({ code: "GROUPING_SOURCE_CHANGED" });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/grouping.test.ts
```
Expected: FAIL — `createGroupingStage` is not exported.

- [ ] **Step 3: Implement the service**

Create `plus/packages/runtime/src/grouping-service.ts`:

```ts
import type {
  CompiledGroupingArtifact,
  GroupingMaterialWindow,
  GroupingRosterSource,
} from "@artflow-plus/domain";
import {
  DomainError,
  normalizeGroupingGroups,
  requirePermission,
} from "@artflow-plus/domain";
import type { Database } from "@artflow-plus/db";
import {
  deleteGroupingGroups,
  getActivityForUpdate,
  getGroupingStageByKey,
  getGroupingStageForUpdate,
  getLatestAdvancementDecision,
  getRelease,
  getRoster,
  getRound,
  insertGroupingGroup,
  insertGroupingMembership,
  insertGroupingStage,
  listApprovedParticipantIds,
  listCurrentGroupingMemberships,
  listGroupingGroups,
  listStageResults,
  updateGroupingStage,
  updateGroupingGroup,
  closeCurrentGroupingMemberships,
  deactivateGroupingGroups,
} from "@artflow-plus/db";
import type { StoredGroupingStage } from "@artflow-plus/db";
import type { Kysely, Transaction } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";

const ROSTER_SOURCES: ReadonlySet<string> = new Set(["all_approved", "round_advanced"]);
const WINDOWS: ReadonlySet<string> = new Set(["closed", "open", "supplement_only"]);

function requireGroupingPermission(actor: Parameters<typeof requirePermission>[0]): void {
  requirePermission(actor, "grouping.manage");
}

function requireCapability(activity: { readonly enabledCapabilities: readonly string[] }): void {
  if (!activity.enabledCapabilities.includes("grouping")) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", "Capability grouping is not enabled on this activity.");
  }
}

function requireNotArchived(activity: { readonly status: string }): void {
  if (activity.status === "archived") {
    throw new DomainError("ACTIVITY_ARCHIVED", "An archived activity cannot change its grouping.");
  }
}

function requireRevision(
  current: { readonly revision: number },
  expectedRevision: number,
): void {
  if (current.revision !== expectedRevision) {
    throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
  }
}

function requireDraft(stage: StoredGroupingStage): void {
  if (stage.status !== "draft") {
    throw new DomainError("GROUPING_NOT_DRAFT", "Only a draft grouping stage can record groups.");
  }
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === "") {
    throw new DomainError("INVALID_INPUT", "A reason is required.");
  }
  return trimmed;
}

interface ResolvedGroupingSource {
  readonly participantIds: readonly string[];
  readonly fingerprint: string;
}

function advancementParticipantIds(decisions: readonly unknown[]): readonly string[] {
  const ids: string[] = [];
  for (const item of decisions) {
    if (item === null || typeof item !== "object") {
      throw new DomainError("GROUPING_SOURCE_UNKNOWN", "The advancement decision is malformed.");
    }
    const row = item as { contestantId?: unknown; advanced?: unknown };
    if (typeof row.contestantId !== "string") {
      throw new DomainError("GROUPING_SOURCE_UNKNOWN", "The advancement decision is malformed.");
    }
    if (row.advanced === true) ids.push(row.contestantId);
  }
  return ids.sort();
}

async function resolveGroupingSource(
  trx: Kysely<Database>,
  activityId: string,
  stage: Pick<StoredGroupingStage, "rosterSource" | "sourceRoundId">,
): Promise<ResolvedGroupingSource> {
  if (stage.rosterSource === "all_approved") {
    const roster = await getRoster(trx, activityId);
    if (roster.status !== "final") {
      throw new DomainError("GROUPING_SOURCE_UNKNOWN", "The participant roster is not final.");
    }
    const participantIds = await listApprovedParticipantIds(trx, activityId);
    if (participantIds.length !== roster.approvedCount) {
      throw new DomainError("GROUPING_SOURCE_CHANGED", "The approved roster changed since it was finalized.");
    }
    return {
      participantIds,
      fingerprint: stableHash({
        source: "all_approved",
        rosterRevision: roster.revision,
        finalizedAt: roster.finalizedAt,
        participantIds,
      }),
    };
  }
  if (stage.sourceRoundId === undefined) {
    throw new DomainError("GROUPING_SOURCE_UNKNOWN", "A round-sourced stage must name its round.");
  }
  const round = await getRound(trx, stage.sourceRoundId);
  if (round === null || round.activityId !== activityId) {
    throw new DomainError("NOT_FOUND", "The source round was not found in this activity.");
  }
  const decision = await getLatestAdvancementDecision(trx, round.id);
  if (decision === null || decision.status !== "auto") {
    throw new DomainError("GROUPING_SOURCE_UNKNOWN", "The source round has no final advancement decision.");
  }
  const participantIds = advancementParticipantIds(decision.decisions);
  return {
    participantIds,
    fingerprint: stableHash({
      source: "round_advanced",
      roundId: round.id,
      decisionId: decision.id,
      decisionRevision: decision.revision,
      inputFingerprint: decision.inputFingerprint,
      participantIds,
    }),
  };
}

async function compiledGroupCount(
  trx: Kysely<Database>,
  activity: { readonly id: string; readonly activeDefinitionVersion: number; readonly enabledCapabilities: readonly string[] },
): Promise<number | undefined> {
  if (activity.activeDefinitionVersion < 1) return undefined;
  if (!activity.enabledCapabilities.includes("grouping")) return undefined;
  const release = await getRelease(trx, activity.id, activity.activeDefinitionVersion);
  const plan = release?.capabilities.grouping;
  if (plan === undefined || plan.ok !== true) return undefined;
  return (plan.artifact as CompiledGroupingArtifact).groupCount;
}

async function stageViews(
  trx: Transaction<Database>,
  stage: StoredGroupingStage,
): Promise<{ groups: readonly { id: string; groupOrder: number; name: string; participantIds: readonly string[] }[] }> {
  const groups = (await listGroupingGroups(trx, [stage.id])).filter((group) => group.isActive);
  const members = await listCurrentGroupingMemberships(trx, stage.id);
  return {
    groups: groups.map((group) => ({
      id: group.id,
      groupOrder: group.groupOrder,
      name: group.name,
      participantIds: members
        .filter((member) => member.groupId === group.id)
        .map((member) => member.participantId),
    })),
  };
}

interface SaveGroupsOptions {
  readonly clearExisting: boolean;
  readonly reason: string;
  readonly actorId: string;
  readonly leftAt: string;
  /** The command id keeps derived ids deterministic under replay. */
  readonly nonce: string;
}

async function saveGroups(
  trx: Transaction<Database>,
  stage: StoredGroupingStage,
  normalized: readonly { readonly name: string; readonly participantIds: readonly string[] }[],
  options: SaveGroupsOptions,
): Promise<void> {
  if (options.clearExisting) {
    await deleteGroupingGroups(trx, stage.id);
  } else {
    await closeCurrentGroupingMemberships(trx, stage.id, options.leftAt, options.actorId, options.reason);
  }
  const existing = options.clearExisting
    ? []
    : (await listGroupingGroups(trx, [stage.id])).filter((group) => group.isActive);
  const byOrder = new Map(existing.map((group) => [group.groupOrder, group]));
  const kept: string[] = [];
  for (const [index, group] of normalized.entries()) {
    const groupOrder = index + 1;
    const current = byOrder.get(groupOrder);
    const groupId = current?.id ?? idFromCommand("grouping_group", `${stage.id}:${index}:${options.nonce}`);
    if (current === undefined) {
      await insertGroupingGroup(trx, {
        id: groupId,
        stageId: stage.id,
        groupOrder,
        name: group.name,
        isActive: true,
      }, options.leftAt);
    } else {
      await updateGroupingGroup(trx, {
        id: groupId,
        stageId: stage.id,
        groupOrder,
        name: group.name,
        isActive: true,
      });
    }
    kept.push(groupId);
    for (const participantId of group.participantIds) {
      await insertGroupingMembership(trx, {
        id: idFromCommand("grouping_member", `${stage.id}:${index}:${participantId}:${options.nonce}`),
        stageId: stage.id,
        groupId,
        participantId,
        isCurrent: true,
        joinedAt: options.leftAt,
        reason: options.reason,
      });
    }
  }
  await deactivateGroupingGroups(trx, stage.id, kept);
}

export interface CreateGroupingStageInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly name: string;
  readonly rosterSource: GroupingRosterSource;
  readonly sourceRoundId?: string;
}

export async function createGroupingStage(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: CreateGroupingStageInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.stage.create",
    actor,
    payload: {
      stageKey: input.stageKey,
      name: input.name,
      rosterSource: input.rosterSource,
      sourceRoundId: input.sourceRoundId ?? null,
    },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    const stageKey = input.stageKey.trim();
    const name = input.name.trim();
    if (stageKey === "" || name === "") {
      throw new DomainError("INVALID_INPUT", "A stage needs a key and a name.");
    }
    if (!ROSTER_SOURCES.has(input.rosterSource)) {
      throw new DomainError("INVALID_INPUT", "Unknown roster source.");
    }
    if (input.rosterSource === "round_advanced") {
      if (input.sourceRoundId === undefined) {
        throw new DomainError("INVALID_INPUT", "A round-sourced stage must name its round.");
      }
      const round = await getRound(trx, input.sourceRoundId);
      if (round === null || round.activityId !== activity.id) {
        throw new DomainError("NOT_FOUND", "The source round was not found in this activity.");
      }
    } else if (input.sourceRoundId !== undefined) {
      throw new DomainError("INVALID_INPUT", "An all-approved stage cannot name a source round.");
    }
    if ((await getGroupingStageByKey(trx, activity.id, stageKey)) !== null) {
      throw new DomainError("GROUPING_STAGE_EXISTS", `Stage ${stageKey} already exists.`);
    }
    const stage: StoredGroupingStage = {
      id: idFromCommand("grouping_stage", input.commandId),
      activityId: activity.id,
      stageKey,
      name,
      status: "draft",
      rosterSource: input.rosterSource,
      ...(input.sourceRoundId === undefined ? {} : { sourceRoundId: input.sourceRoundId }),
      sourceFingerprint: "",
      materialWindow: "closed",
      cancelReason: "",
      revision: 1,
    };
    await insertGroupingStage(trx, stage, deps.now());
    await appendEngineEvent(trx, deps, {
      type: "GroupingStageCreated",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: stage.revision,
      payload: { stageId: stage.id, stageKey, rosterSource: stage.rosterSource },
    });
    return { body: stage, status: 201 };
  });
}

export interface RecordGroupingGroupsInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageId: string;
  readonly expectedRevision: number;
  readonly groups: readonly { readonly name?: string; readonly participantIds: readonly string[] }[];
}

export async function recordGroupingGroups(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: RecordGroupingGroupsInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.groups.record",
    actor,
    payload: { stageId: input.stageId, expectedRevision: input.expectedRevision, groups: input.groups },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    const stage = await getGroupingStageForUpdate(trx, activity.id, input.stageId);
    if (stage === null) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
    requireRevision(stage, input.expectedRevision);
    requireDraft(stage);
    const source = await resolveGroupingSource(trx, activity.id, stage);
    const normalized = normalizeGroupingGroups(input.groups, new Set(source.participantIds), {
      complete: false,
    });
    await saveGroups(trx, stage, normalized, {
      clearExisting: true,
      reason: "",
      actorId: actor.actorId,
      leftAt: deps.now(),
      nonce: input.commandId,
    });
    const saved = { ...stage, revision: stage.revision + 1 };
    if (!(await updateGroupingStage(trx, saved, stage.revision))) {
      throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
    }
    await appendEngineEvent(trx, deps, {
      type: "GroupingGroupsRecorded",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: saved.revision,
      payload: { stageId: stage.id, ...(await stageViews(trx, saved)) },
    });
    return { body: saved };
  });
}

export interface ConfirmGroupingStageInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageId: string;
  readonly expectedRevision: number;
}

export async function confirmGroupingStage(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ConfirmGroupingStageInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.stage.confirm",
    actor,
    payload: { stageId: input.stageId, expectedRevision: input.expectedRevision },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    const stage = await getGroupingStageForUpdate(trx, activity.id, input.stageId);
    if (stage === null) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
    requireRevision(stage, input.expectedRevision);
    if (stage.status !== "draft") {
      throw new DomainError("INVALID_TRANSITION", "Only a draft stage can be confirmed.");
    }
    const source = await resolveGroupingSource(trx, activity.id, stage);
    const groups = (await listGroupingGroups(trx, [stage.id])).filter((group) => group.isActive);
    const members = await listCurrentGroupingMemberships(trx, stage.id);
    const specs = groups.map((group) => ({
      name: group.name,
      participantIds: members
        .filter((member) => member.groupId === group.id)
        .map((member) => member.participantId),
    }));
    normalizeGroupingGroups(specs, new Set(source.participantIds), {
      complete: true,
      ...(await compiledGroupCount(trx, activity).then((count) =>
        count === undefined ? {} : { groupCount: count },
      )),
    });
    const saved: StoredGroupingStage = {
      ...stage,
      status: "confirmed",
      sourceFingerprint: source.fingerprint,
      confirmedAt: deps.now(),
      confirmedBy: actor.actorId,
      revision: stage.revision + 1,
    };
    if (!(await updateGroupingStage(trx, saved, stage.revision))) {
      throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
    }
    await appendEngineEvent(trx, deps, {
      type: "GroupingStageConfirmed",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: saved.revision,
      payload: { stageId: stage.id, sourceFingerprint: saved.sourceFingerprint },
    });
    return { body: saved };
  });
}

export interface FreezeGroupingStageInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageId: string;
  readonly expectedRevision: number;
}

export async function freezeGroupingStage(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: FreezeGroupingStageInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.stage.freeze",
    actor,
    payload: { stageId: input.stageId, expectedRevision: input.expectedRevision },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    const stage = await getGroupingStageForUpdate(trx, activity.id, input.stageId);
    if (stage === null) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
    requireRevision(stage, input.expectedRevision);
    if (stage.status !== "confirmed") {
      throw new DomainError("INVALID_TRANSITION", "Only a confirmed stage can be frozen.");
    }
    const source = await resolveGroupingSource(trx, activity.id, stage);
    if (stage.sourceFingerprint !== "" && stage.sourceFingerprint !== source.fingerprint) {
      throw new DomainError("GROUPING_SOURCE_CHANGED", "The source roster changed after confirmation.");
    }
    const groups = (await listGroupingGroups(trx, [stage.id])).filter((group) => group.isActive);
    const members = await listCurrentGroupingMemberships(trx, stage.id);
    normalizeGroupingGroups(
      groups.map((group) => ({
        name: group.name,
        participantIds: members.filter((member) => member.groupId === group.id).map((member) => member.participantId),
      })),
      new Set(source.participantIds),
      {
        complete: true,
        ...(await compiledGroupCount(trx, activity).then((count) =>
          count === undefined ? {} : { groupCount: count },
        )),
      },
    );
    const saved: StoredGroupingStage = {
      ...stage,
      status: "frozen",
      sourceFingerprint: source.fingerprint,
      frozenAt: deps.now(),
      frozenBy: actor.actorId,
      revision: stage.revision + 1,
    };
    if (!(await updateGroupingStage(trx, saved, stage.revision))) {
      throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
    }
    await appendEngineEvent(trx, deps, {
      type: "GroupingStageFrozen",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: saved.revision,
      payload: { stageId: stage.id },
    });
    return { body: saved };
  });
}
```

Note: `saveGroups` creates fresh membership ids using `deps.newEventId()`, which breaks idempotency under replay? Replay never re-runs the handler (receipt claim), so it is only a determinism concern for tests. Existing services derive ids from commandId. To stay deterministic, change the signature to take a `nonce: string` (the command id) instead of using `newEventId()`. Fix in the plan code: pass `input.commandId` and derive `${stage.id}:${groupOrder}:${nonce}`. Do that.

Adjust `saveGroups` signature: `nonce: string` and replace `deps.newEventId()` with `nonce`. In `record`, pass `input.commandId`; in correct, pass `input.commandId`.

I need to make sure the plan code reflects this. I'll write it correctly.

- [ ] **Step 4: Export the service**

Add to `plus/packages/runtime/src/index.ts`:

```ts
export * from "./grouping-service.js";
```

- [ ] **Step 5: Run the runtime tests**

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/grouping.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```powershell
git add plus/packages/runtime/src/grouping-service.ts plus/packages/runtime/src/index.ts plus/packages/runtime/test/grouping.test.ts
git commit -m "feat(runtime): add grouping create, record, confirm, and freeze"
```

---

## Task 5: Runtime — correct, cancel, material window, consumption guard

**Files:**
- Modify: `plus/packages/runtime/src/grouping-service.ts`
- Modify: `plus/packages/runtime/test/grouping.test.ts`

- [ ] **Step 1: Extend the failing test**

Append to `plus/packages/runtime/test/grouping.test.ts` inside the describe block:

```ts
  it("keeps membership history on correction and refuses without a reason", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-correct",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "record-correct",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1"] }, { name: "B", participantIds: ["p2"] }],
    });
    const confirmed = await confirmGroupingStage(db, deps(), {
      commandId: "confirm-correct",
      activityId,
      stageId: created.body.id,
      expectedRevision: recorded.body.revision,
    });
    await expect(
      correctGroupingStage(db, deps(), {
        commandId: "correct-no-reason",
        activityId,
        stageId: created.body.id,
        expectedRevision: confirmed.body.revision,
        groups: [{ name: "A", participantIds: ["p1", "p2"] }, { name: "B", participantIds: [] }],
        reason: " ",
      }),
    ).rejects.toBeTruthy();
    const corrected = await correctGroupingStage(db, deps(), {
      commandId: "correct-1",
      activityId,
      stageId: created.body.id,
      expectedRevision: confirmed.body.revision,
      groups: [{ name: "A", participantIds: ["p2"] }, { name: "B", participantIds: ["p1"] }],
      reason: "外部分组表更正",
    });
    expect(corrected.body.status).toBe("confirmed");
    const history = await db.selectFrom("grouping_membership").selectAll()
      .where("stage_id", "=", created.body.id).where("is_current", "=", false).execute();
    expect(history).toHaveLength(2);
  });

  it("cancels a draft once and closes the material window", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-cancel",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const cancelled = await cancelGroupingStage(db, deps(), {
      commandId: "cancel-1",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      reason: "当届赛制无分组合唱",
    });
    expect(cancelled.body.status).toBe("cancelled");
    expect(cancelled.body.materialWindow).toBe("closed");
    const again = await cancelGroupingStage(db, deps(), {
      commandId: "cancel-2",
      activityId,
      stageId: created.body.id,
      expectedRevision: cancelled.body.revision,
      reason: "再点一次",
    });
    expect(again.body.status).toBe("cancelled");
  });

  it("refuses correction once a stage result is confirmed", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-consumed",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "record-consumed",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1"] }, { name: "B", participantIds: ["p2"] }],
    });
    const confirmed = await confirmGroupingStage(db, deps(), {
      commandId: "confirm-consumed",
      activityId,
      stageId: created.body.id,
      expectedRevision: recorded.body.revision,
    });
    await db.insertInto("stage_result").values({
      id: "stage-result-1",
      activity_id: activityId,
      stage_key: "final",
      status: "confirmed",
      candidate_revision: 1,
      source_candidate_revision: 1,
      input_fingerprint: "fingerprint",
      decisions: JSON.stringify([]),
      awards: JSON.stringify([]),
      note: "",
      revision: 1,
      confirmed_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
    await expect(
      correctGroupingStage(db, deps(), {
        commandId: "correct-consumed",
        activityId,
        stageId: created.body.id,
        expectedRevision: confirmed.body.revision,
        groups: [{ name: "A", participantIds: ["p2"] }, { name: "B", participantIds: ["p1"] }],
        reason: "改",
      }),
    ).rejects.toMatchObject({ code: "GROUPING_CONSUMED" });
  });

  it("lets exactly one of two concurrent creates with the same key win", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const input = {
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved" as const,
    };
    const results = await Promise.allSettled([
      createGroupingStage(db, deps(), { ...input, commandId: "concurrent-create-a" }),
      createGroupingStage(dbB, deps(), { ...input, commandId: "concurrent-create-b" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    const code = rejected?.status === "rejected" ? rejected.reason.code : undefined;
    expect(code).toBe("GROUPING_STAGE_EXISTS");
  });

  it("rejects a second concurrent mutation at the same revision", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "race-create",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    const recorded = await recordGroupingGroups(db, deps(), {
      commandId: "race-record",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1"] }, { name: "B", participantIds: ["p2"] }],
    });
    const confirmed = await confirmGroupingStage(db, deps(), {
      commandId: "race-confirm",
      activityId,
      stageId: created.body.id,
      expectedRevision: recorded.body.revision,
    });
    const results = await Promise.allSettled([
      freezeGroupingStage(db, deps(), {
        commandId: "race-freeze",
        activityId,
        stageId: created.body.id,
        expectedRevision: confirmed.body.revision,
      }),
      cancelGroupingStage(dbB, deps(), {
        commandId: "race-cancel",
        activityId,
        stageId: created.body.id,
        expectedRevision: confirmed.body.revision,
        reason: "并发取消",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    const code = rejected?.status === "rejected" ? rejected.reason.code : undefined;
    expect(code).toBe("STALE_REVISION");
  });
```

Update imports to include `cancelGroupingStage` and `correctGroupingStage`.

- [ ] **Step 2: Run it and confirm it fails**

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/grouping.test.ts
```
Expected: FAIL — the new functions are not exported.

- [ ] **Step 3: Implement the remaining commands**

Append to `plus/packages/runtime/src/grouping-service.ts`:

```ts
export interface CorrectGroupingStageInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageId: string;
  readonly expectedRevision: number;
  readonly groups: readonly { readonly name?: string; readonly participantIds: readonly string[] }[];
  readonly reason: string;
}

async function requireNoConfirmedResult(
  trx: Kysely<Database>,
  activityId: string,
): Promise<void> {
  const results = await listStageResults(trx, activityId);
  if (results.some((result) => result.status === "confirmed")) {
    throw new DomainError("GROUPING_CONSUMED", "A confirmed result already consumed this activity's grouping.");
  }
}

export async function correctGroupingStage(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: CorrectGroupingStageInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.stage.correct",
    actor,
    payload: {
      stageId: input.stageId,
      expectedRevision: input.expectedRevision,
      groups: input.groups,
      reason: input.reason,
    },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const reason = requireReason(input.reason);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    const stage = await getGroupingStageForUpdate(trx, activity.id, input.stageId);
    if (stage === null) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
    requireRevision(stage, input.expectedRevision);
    if (stage.status !== "confirmed" && stage.status !== "frozen") {
      throw new DomainError("INVALID_TRANSITION", "Only a confirmed or frozen stage can be corrected.");
    }
    await requireNoConfirmedResult(trx, activity.id);
    const source = await resolveGroupingSource(trx, activity.id, stage);
    const normalized = normalizeGroupingGroups(input.groups, new Set(source.participantIds), {
      complete: true,
      ...(await compiledGroupCount(trx, activity).then((count) =>
        count === undefined ? {} : { groupCount: count },
      )),
    });
    await saveGroups(trx, stage, normalized, {
      clearExisting: false,
      reason,
      actorId: actor.actorId,
      leftAt: deps.now(),
      nonce: input.commandId,
    });
    const saved: StoredGroupingStage = {
      ...stage,
      sourceFingerprint: source.fingerprint,
      confirmedAt: deps.now(),
      confirmedBy: actor.actorId,
      ...(stage.status === "frozen" ? { frozenAt: deps.now(), frozenBy: actor.actorId } : {}),
      revision: stage.revision + 1,
    };
    if (!(await updateGroupingStage(trx, saved, stage.revision))) {
      throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
    }
    await appendEngineEvent(trx, deps, {
      type: "GroupingStageCorrected",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: saved.revision,
      payload: { stageId: stage.id, reason, groups: (await stageViews(trx, saved)).groups },
    });
    return { body: saved };
  });
}

export interface CancelGroupingStageInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageId: string;
  readonly expectedRevision: number;
  readonly reason: string;
}

export async function cancelGroupingStage(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: CancelGroupingStageInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.stage.cancel",
    actor,
    payload: { stageId: input.stageId, expectedRevision: input.expectedRevision, reason: input.reason },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const reason = requireReason(input.reason);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    const stage = await getGroupingStageForUpdate(trx, activity.id, input.stageId);
    if (stage === null) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
    requireRevision(stage, input.expectedRevision);
    if (stage.status === "cancelled") return { body: stage };
    if (stage.status === "frozen") {
      throw new DomainError("INVALID_TRANSITION", "A frozen stage cannot be cancelled.");
    }
    if (stage.status === "confirmed") {
      await requireNoConfirmedResult(trx, activity.id);
    }
    const saved: StoredGroupingStage = {
      ...stage,
      status: "cancelled",
      materialWindow: "closed",
      cancelReason: reason,
      cancelledAt: deps.now(),
      cancelledBy: actor.actorId,
      revision: stage.revision + 1,
    };
    if (!(await updateGroupingStage(trx, saved, stage.revision))) {
      throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
    }
    await appendEngineEvent(trx, deps, {
      type: "GroupingStageCancelled",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: saved.revision,
      payload: { stageId: stage.id, reason },
    });
    return { body: saved };
  });
}

export interface SetGroupingWindowInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageId: string;
  readonly expectedRevision: number;
  readonly window: GroupingMaterialWindow;
  readonly note?: string;
}

export async function setGroupingMaterialWindow(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: SetGroupingWindowInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.window.set",
    actor,
    payload: {
      stageId: input.stageId,
      expectedRevision: input.expectedRevision,
      window: input.window,
      note: input.note ?? null,
    },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    if (!WINDOWS.has(input.window)) {
      throw new DomainError("GROUPING_WINDOW_INVALID", "Unknown material window state.");
    }
    const stage = await getGroupingStageForUpdate(trx, activity.id, input.stageId);
    if (stage === null) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
    requireRevision(stage, input.expectedRevision);
    if (stage.status !== "confirmed" && stage.status !== "frozen") {
      throw new DomainError("INVALID_TRANSITION", "Only a confirmed or frozen stage has a material window.");
    }
    if (stage.materialWindow === input.window) {
      return { body: stage };
    }
    const saved: StoredGroupingStage = {
      ...stage,
      materialWindow: input.window,
      revision: stage.revision + 1,
    };
    if (!(await updateGroupingStage(trx, saved, stage.revision))) {
      throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
    }
    await appendEngineEvent(trx, deps, {
      type: "GroupingMaterialWindowChanged",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: saved.revision,
      payload: { stageId: stage.id, window: input.window, note: input.note ?? "" },
    });
    return { body: saved };
  });
}
```

Also change `saveGroups` to accept `nonce` and use it instead of `deps.newEventId()`:

```ts
interface SaveGroupsOptions {
  readonly clearExisting: boolean;
  readonly reason: string;
  readonly actorId: string;
  readonly leftAt: string;
  readonly nonce: string;
}
```

and derive ids:

```ts
const groupId = current?.id ?? idFromCommand("grouping_group", `${stage.id}:${groupOrder}:${options.nonce}`);
...
id: idFromCommand("grouping_member", `${stage.id}:${groupId}:${participantId}:${options.nonce}`),
```

Update the `recordGroupingGroups` call to pass `nonce: input.commandId`.

- [ ] **Step 4: Run the tests**

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/grouping.test.ts
```
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```powershell
git add plus/packages/runtime/src/grouping-service.ts plus/packages/runtime/test/grouping.test.ts
git commit -m "feat(runtime): add grouping correction, cancellation, and material window"
```

---

## Task 6: Read projection (`grouping.describe`)

**Files:**
- Create: `plus/packages/runtime/src/grouping-read-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Modify: `plus/packages/runtime/test/grouping.test.ts`

- [ ] **Step 1: Add the failing test**

Append to the describe block in `plus/packages/runtime/test/grouping.test.ts`:

```ts
  it("describes stages with groups, members, and display names", async () => {
    const activityId = await seedActivity(["p1", "p2"]);
    const created = await createGroupingStage(db, deps(), {
      commandId: "create-read",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
    await recordGroupingGroups(db, deps(), {
      commandId: "record-read",
      activityId,
      stageId: created.body.id,
      expectedRevision: created.body.revision,
      groups: [{ name: "A", participantIds: ["p1"] }, { name: "B", participantIds: ["p2"] }],
    });
    const state = await getGroupingState(db, deps(), { activityId });
    expect(state.stages).toHaveLength(1);
    expect(state.stages[0]?.groupCount).toBe(2);
    expect(state.stages[0]?.matchesGroupCount).toBe(true);
    expect(state.stages[0]?.groups[0]?.members).toEqual([
      { participantId: "p1", displayName: "P1" },
    ]);
  });
```

Add `getGroupingState` to the import list.

- [ ] **Step 2: Run it and confirm it fails**

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/grouping.test.ts
```
Expected: FAIL — `getGroupingState` is not exported.

- [ ] **Step 3: Implement the read service**

Create `plus/packages/runtime/src/grouping-read-service.ts`:

```ts
import type { CompiledGroupingArtifact } from "@artflow-plus/domain";
import { DomainError, requirePermission } from "@artflow-plus/domain";
import type { Database } from "@artflow-plus/db";
import {
  getActivity,
  getRelease,
  listCurrentGroupingMemberships,
  listGroupingGroups,
  listGroupingStages,
  listParticipantLabels,
} from "@artflow-plus/db";
import type { Kysely } from "kysely";

import { runtimeActor, type RuntimeDeps } from "./deps.js";

export interface GroupingStateView {
  readonly stages: readonly {
    readonly id: string;
    readonly stageKey: string;
    readonly name: string;
    readonly status: string;
    readonly rosterSource: string;
    readonly sourceRoundId: string | null;
    readonly materialWindow: string;
    readonly revision: number;
    readonly groupCount: number | null;
    readonly matchesGroupCount: boolean | null;
    readonly groups: readonly {
      readonly id: string;
      readonly order: number;
      readonly name: string;
      readonly members: readonly { readonly participantId: string; readonly displayName: string }[];
    }[];
  }[];
}

export async function getGroupingState(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string },
): Promise<GroupingStateView> {
  requirePermission(runtimeActor(deps), "grouping.manage");
  const activity = await getActivity(db, input.activityId);
  if (activity === null) {
    throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
  }
  if (!activity.enabledCapabilities.includes("grouping")) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", "Capability grouping is not enabled on this activity.");
  }
  const stages = await listGroupingStages(db, activity.id);
  const stageIds = stages.map((stage) => stage.id);
  const groups = await listGroupingGroups(db, stageIds);
  const memberships = (
    await Promise.all(stageIds.map((stageId) => listCurrentGroupingMemberships(db, stageId)))
  ).flat();
  const labels = await listParticipantLabels(db, activity.id);
  let groupCount: number | null = null;
  if (activity.activeDefinitionVersion > 0) {
    const release = await getRelease(db, activity.id, activity.activeDefinitionVersion);
    const plan = release?.capabilities.grouping;
    if (plan !== undefined && plan.ok === true) {
      const artifact = plan.artifact as CompiledGroupingArtifact;
      groupCount = artifact.groupCount ?? null;
    }
  }
  return {
    stages: stages.map((stage) => {
      const stageGroups = groups.filter((group) => group.stageId === stage.id && group.isActive);
      const stageMembers = memberships.filter((member) => member.stageId === stage.id);
      return {
        id: stage.id,
        stageKey: stage.stageKey,
        name: stage.name,
        status: stage.status,
        rosterSource: stage.rosterSource,
        sourceRoundId: stage.sourceRoundId ?? null,
        materialWindow: stage.materialWindow,
        revision: stage.revision,
        groupCount,
        matchesGroupCount: groupCount === null ? null : stageGroups.length === groupCount,
        groups: stageGroups.map((group) => ({
          id: group.id,
          order: group.groupOrder,
          name: group.name,
          members: stageMembers
            .filter((member) => member.groupId === group.id)
            .map((member) => ({
              participantId: member.participantId,
              displayName: labels.get(member.participantId) ?? member.participantId,
            })),
        })),
      };
    }),
  };
}
```

- [ ] **Step 4: Export and run**

Add to `plus/packages/runtime/src/index.ts`:

```ts
export * from "./grouping-read-service.js";
```

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/grouping.test.ts
```
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```powershell
git add plus/packages/runtime/src/grouping-read-service.ts plus/packages/runtime/src/index.ts plus/packages/runtime/test/grouping.test.ts
git commit -m "feat(runtime): add the grouping read projection"
```

---

## Task 7: Archive closure and package content

**Files:**
- Modify: `plus/packages/runtime/src/archive-service.ts`
- Modify: `plus/packages/runtime/src/archive-package.ts`
- Modify: `plus/packages/runtime/test/archive-service.test.ts`

- [ ] **Step 1: Add the failing archive test**

In `plus/packages/runtime/test/archive-service.test.ts`, import `insertGroupingStage` from `@artflow-plus/db` and add inside the describe block:

```ts
it("refuses to archive while a grouping stage is not frozen or cancelled", async () => {
  const activityId = await seed({ capabilities: ["publishing", "archive", "grouping"] });
  await insertGroupingStage(db, {
    id: "grouping-archive-stage",
    activityId,
    stageKey: "chorus",
    name: "分组合唱",
    status: "draft",
    rosterSource: "all_approved",
    sourceFingerprint: "",
    materialWindow: "closed",
    cancelReason: "",
    revision: 1,
  }, "2026-10-27T10:00:00Z");
  await expect(
    archiveActivity(db, deps(), {
      commandId: "archive-grouping-open",
      activityId,
      expectedRevision: 1,
      note: "活动结束归档",
    }),
  ).rejects.toMatchObject({ code: "ARCHIVE_GROUPING_NOT_FROZEN" });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/archive-service.test.ts
```
Expected: FAIL — the archive succeeds instead of refusing.

- [ ] **Step 3: Add the closure check**

In `requireArchiveClosure` in `plus/packages/runtime/src/archive-service.ts`, append before the voting branch:

```ts
  if (activity.enabledCapabilities.includes("grouping")) {
    const stages = await listGroupingStages(trx, activity.id);
    if (stages.some((stage) => stage.status !== "frozen" && stage.status !== "cancelled")) {
      throw new DomainError(
        "ARCHIVE_GROUPING_NOT_FROZEN",
        "Freeze or cancel every grouping stage before archiving.",
      );
    }
  }
```

Add `listGroupingStages` to the `@artflow-plus/db` import list.

- [ ] **Step 4: Add grouping to the archive package**

In `plus/packages/runtime/src/archive-package.ts`:

Add to `ArchivePackageInput`:

```ts
  readonly grouping?: {
    readonly stages: readonly {
      readonly stageKey: string;
      readonly name: string;
      readonly status: string;
      readonly rosterSource: string;
      readonly materialWindow: string;
      readonly groups: readonly {
        readonly order: number;
        readonly name: string;
        readonly active: boolean;
        readonly participantIds: readonly string[];
      }[];
    }[];
  };
```

Add inside `buildArchivePackage`, after the sessions entry:

```ts
  const grouping = input.grouping;
  if (grouping !== undefined && grouping.stages.length > 0) {
    add(
      "grouping.json",
      JSON.stringify({ stages: grouping.stages }, null, 2),
      "application/json",
    );
    const rows: (string | number)[][] = [["stage", "group_order", "group_name", "active", "participant_id"]];
    for (const stage of grouping.stages) {
      for (const group of stage.groups) {
        const members = group.participantIds.length === 0 ? [""] : group.participantIds;
        for (const participantId of members) {
          rows.push([stage.stageKey, group.order, group.name, group.active ? "yes" : "no", participantId]);
        }
      }
    }
    add("grouping.csv", csv(rows), "text/csv");
  }
```

In `archive-service.ts`, before calling `buildArchivePackage`, load the data:

```ts
  const groupingStages = activity.enabledCapabilities.includes("grouping")
    ? await listGroupingStages(trx, activity.id)
    : [];
  const groupingGroups = await listGroupingGroups(trx, groupingStages.map((stage) => stage.id));
  const groupingMembers = (
    await Promise.all(groupingStages.map((stage) => listCurrentGroupingMemberships(trx, stage.id)))
  ).flat();
```

and pass:

```ts
    grouping: {
      stages: groupingStages.map((stage) => ({
        stageKey: stage.stageKey,
        name: stage.name,
        status: stage.status,
        rosterSource: stage.rosterSource,
        materialWindow: stage.materialWindow,
        groups: groupingGroups
          .filter((group) => group.stageId === stage.id && group.isActive)
          .map((group) => ({
            order: group.groupOrder,
            name: group.name,
            active: group.isActive,
            participantIds: groupingMembers
              .filter((member) => member.groupId === group.id)
              .map((member) => member.participantId),
          })),
      })),
    },
```

- [ ] **Step 5: Run the archive tests**

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/archive-service.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add plus/packages/runtime/src/archive-service.ts plus/packages/runtime/src/archive-package.ts plus/packages/runtime/test/archive-service.test.ts
git commit -m "feat(archive): require and include grouping"
```

---

## Task 8: API routes

**Files:**
- Modify: `plus/apps/api/src/app.ts`
- Create: `plus/apps/api/test/grouping.test.ts`

- [ ] **Step 1: Write the failing API test**

Create `plus/apps/api/test/grouping.test.ts`:

```ts
import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertLocalAccount, insertRelease, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { hashPassword } from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_grouping_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let opsToken = "";
let participantToken = "";

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

async function seedGroupingActivity(participants: readonly string[]): Promise<string> {
  const activityId = `act-grouping-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "分组 API 测试",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "grouping"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "api-grouping-release",
    capabilities: {
      grouping: {
        ok: true,
        capabilityKey: "grouping",
        contentHash: "api-grouping",
        artifact: { schemaVersion: 1, groupCount: 2 },
      },
    },
    executionPolicy: { declaredScopes: [], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { grouping: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
  await db.insertInto("roster").values({
    activity_id: activityId,
    status: "final",
    approved_count: participants.length,
    revision: 1,
    finalized_at: "2026-10-27T09:30:00Z",
    updated_at: new Date(),
  }).execute();
  for (const participantId of participants) {
    await db.insertInto("registration").values({
      id: `registration-${activityId}-${participantId}`,
      activity_id: activityId,
      participant_id: participantId,
      questionnaire_version: "v1",
      questionnaire_hash: "hash",
      status: "approved",
      answers: JSON.stringify({ name: participantId.toUpperCase() }),
      revision: 1,
      review_note: "",
      reviewed_by: "staff",
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
  }
  return activityId;
}

async function login(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "content-type": "application/json" },
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

describe.skipIf(!connectionString)("grouping routes", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps, enableRuntimeFacts: true });
    await app.ready();
    await insertLocalAccount(db, {
      username: "grouping-ops",
      passwordDigest: hashPassword("grouping-password"),
      actor: {
        actorId: "grouping-ops",
        actorType: "user",
        roles: ["staff"],
        permissions: ["grouping.manage"],
      },
      active: true,
    });
    await insertLocalAccount(db, {
      username: "grouping-participant",
      passwordDigest: hashPassword("participant-password"),
      actor: { actorId: "grouping-participant", actorType: "user", roles: [], permissions: [] },
      active: true,
    });
    opsToken = await login("grouping-ops", "grouping-password");
    participantToken = await login("grouping-participant", "participant-password");
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("creates, records, confirms, and reads a grouping stage", async () => {
    const activityId = await seedGroupingActivity(["p1", "p2"]);
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${opsToken}`,
    };

    const created = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/grouping/stages`,
      headers: { ...headers, "idempotency-key": "api-group-create" },
      payload: { stageKey: "chorus", name: "分组合唱", rosterSource: "all_approved" },
    });
    expect(created.statusCode).toBe(201);
    const stage = created.json() as { id: string; revision: number };

    const recorded = await app.inject({
      method: "PATCH",
      url: `/api/activities/${activityId}/grouping/stages/${stage.id}/groups`,
      headers: { ...headers, "idempotency-key": "api-group-record" },
      payload: {
        expectedRevision: stage.revision,
        groups: [
          { name: "A", participantIds: ["p1"] },
          { name: "B", participantIds: ["p2"] },
        ],
      },
    });
    expect(recorded.statusCode).toBe(200);
    const recordedStage = recorded.json() as { revision: number };

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/grouping/stages/${stage.id}/confirm`,
      headers: { ...headers, "idempotency-key": "api-group-confirm" },
      payload: { expectedRevision: recordedStage.revision },
    });
    expect(confirmed.statusCode).toBe(200);

    const read = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/grouping`,
      headers,
    });
    expect(read.statusCode).toBe(200);
    const state = read.json() as {
      stages: { status: string; groups: { members: { participantId: string }[] }[] }[];
    };
    expect(state.stages[0]?.status).toBe("confirmed");
    expect(state.stages[0]?.groups).toHaveLength(2);
  });

  it("rejects grouping writes without the permission", async () => {
    const activityId = await seedGroupingActivity(["p1", "p2"]);
    const response = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/grouping/stages`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${participantToken}`,
        "idempotency-key": "api-group-denied",
      },
      payload: { stageKey: "chorus", name: "分组合唱", rosterSource: "all_approved" },
    });
    expect(response.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus --filter @artflow-plus/api exec vitest run test/grouping.test.ts
```
Expected: FAIL — 404 because the routes do not exist.

- [ ] **Step 3: Add the schemas and routes**

In `plus/apps/api/src/app.ts`:

Add near the other TypeBox schemas:

```ts
const GroupingStageParams = Type.Object({
  id: Type.String({ minLength: 1 }),
  stageId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const CreateGroupingStageBody = Type.Object({
  stageKey: Type.String({ minLength: 1, maxLength: 100 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  rosterSource: Type.Union([Type.Literal("all_approved"), Type.Literal("round_advanced")]),
  sourceRoundId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
}, { additionalProperties: false });

const GroupingGroupSpecSchema = Type.Object({
  name: Type.Optional(Type.String({ maxLength: 200 })),
  participantIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1 }),
}, { additionalProperties: false });

const RecordGroupingGroupsBody = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  groups: Type.Array(GroupingGroupSpecSchema, { minItems: 1 }),
}, { additionalProperties: false });

const GroupingRevisionBody = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

const CorrectGroupingBody = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  groups: Type.Array(GroupingGroupSpecSchema, { minItems: 1 }),
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const CancelGroupingBody = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const GroupingWindowBody = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  window: Type.Union([
    Type.Literal("closed"),
    Type.Literal("open"),
    Type.Literal("supplement_only"),
  ]),
  note: Type.Optional(Type.String({ maxLength: 500 })),
}, { additionalProperties: false });
```

Add the routes next to the registration routes:

```ts
  app.get(
    "/api/activities/:id/grouping",
    { schema: { params: ActivityParams } },
    async (request) => {
      const { id } = request.params as { id: string };
      return getGroupingState(db, await requestDeps(request), { activityId: id });
    },
  );

  app.post(
    "/api/activities/:id/grouping/stages",
    { schema: { params: ActivityParams, body: CreateGroupingStageBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        stageKey: string;
        name: string;
        rosterSource: "all_approved" | "round_advanced";
        sourceRoundId?: string;
      };
      const outcome = await createGroupingStage(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageKey: body.stageKey,
        name: body.name,
        rosterSource: body.rosterSource,
        ...(body.sourceRoundId === undefined ? {} : { sourceRoundId: body.sourceRoundId }),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    "/api/activities/:id/grouping/stages/:stageId/groups",
    { schema: { params: GroupingStageParams, body: RecordGroupingGroupsBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as {
        expectedRevision: number;
        groups: readonly { name?: string; participantIds: readonly string[] }[];
      };
      const outcome = await recordGroupingGroups(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
        groups: body.groups,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  for (const action of ["confirm", "freeze"] as const) {
    app.post(
      `/api/activities/:id/grouping/stages/:stageId/${action}`,
      { schema: { params: GroupingStageParams, body: GroupingRevisionBody } },
      async (request, reply) => {
        const commandId = requireIdempotency(request);
        const { id, stageId } = request.params as { id: string; stageId: string };
        const body = request.body as { expectedRevision: number };
        const service = action === "confirm" ? confirmGroupingStage : freezeGroupingStage;
        const outcome = await service(db, await requestDeps(request), {
          commandId,
          activityId: id,
          stageId,
          expectedRevision: body.expectedRevision,
        });
        return reply.status(outcome.status).send(outcome.body);
      },
    );
  }

  app.post(
    "/api/activities/:id/grouping/stages/:stageId/correct",
    { schema: { params: GroupingStageParams, body: CorrectGroupingBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as {
        expectedRevision: number;
        groups: readonly { name?: string; participantIds: readonly string[] }[];
        reason: string;
      };
      const outcome = await correctGroupingStage(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
        groups: body.groups,
        reason: body.reason,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/grouping/stages/:stageId/cancel",
    { schema: { params: GroupingStageParams, body: CancelGroupingBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as { expectedRevision: number; reason: string };
      const outcome = await cancelGroupingStage(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
        reason: body.reason,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    "/api/activities/:id/grouping/stages/:stageId/window",
    { schema: { params: GroupingStageParams, body: GroupingWindowBody } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageId } = request.params as { id: string; stageId: string };
      const body = request.body as {
        expectedRevision: number;
        window: "closed" | "open" | "supplement_only";
        note?: string;
      };
      const outcome = await setGroupingMaterialWindow(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageId,
        expectedRevision: body.expectedRevision,
        window: body.window,
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );
```

Import the runtime functions:

```ts
  cancelGroupingStage,
  confirmGroupingStage,
  correctGroupingStage,
  createGroupingStage,
  freezeGroupingStage,
  getGroupingState,
  recordGroupingGroups,
  setGroupingMaterialWindow,
```

- [ ] **Step 4: Run the API test**

```powershell
pnpm -C plus --filter @artflow-plus/api exec vitest run test/grouping.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```powershell
git add plus/apps/api/src/app.ts plus/apps/api/test/grouping.test.ts
git commit -m "feat(api): expose grouping routes"
```

---

## Task 9: Ops card and E2E

**Files:**
- Create: `plus/apps/web/src/api/grouping.ts`
- Create: `plus/apps/web/src/components/ops/GroupingCard.tsx`
- Modify: `plus/apps/web/src/routes/opsActivity.tsx`
- Modify: `plus/apps/web/src/styles/global.css`
- Modify: `plus/apps/api/scripts/seed-registration.ts`
- Create: `plus/apps/api/scripts/seed-grouping.ts`
- Modify: `plus/apps/api/package.json`
- Create: `plus/apps/web/e2e/grouping.spec.ts`

- [ ] **Step 1: Add the API client**

Create `plus/apps/web/src/api/grouping.ts`:

```ts
import { apiFetch } from "./client.js";

export interface GroupingMember {
  readonly participantId: string;
  readonly displayName: string;
}

export interface GroupingGroup {
  readonly id: string;
  readonly order: number;
  readonly name: string;
  readonly members: readonly GroupingMember[];
}

export interface GroupingStage {
  readonly id: string;
  readonly stageKey: string;
  readonly name: string;
  readonly status: "draft" | "confirmed" | "frozen" | "cancelled";
  readonly rosterSource: "all_approved" | "round_advanced";
  readonly materialWindow: "closed" | "open" | "supplement_only";
  readonly revision: number;
  readonly groupCount: number | null;
  readonly matchesGroupCount: boolean | null;
  readonly groups: readonly GroupingGroup[];
}

export interface GroupingState {
  readonly stages: readonly GroupingStage[];
}

export async function fetchGrouping(activityId: string): Promise<GroupingState> {
  return apiFetch<GroupingState>(`/api/activities/${activityId}/grouping`);
}

export async function createGroupingStage(
  activityId: string,
  commandId: string,
  input: { stageKey: string; name: string; rosterSource: "all_approved" | "round_advanced" },
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(`/api/activities/${activityId}/grouping/stages`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify(input),
  });
}

export async function recordGroupingGroups(
  activityId: string,
  stageId: string,
  commandId: string,
  expectedRevision: number,
  groups: readonly { name?: string; participantIds: readonly string[] }[],
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(
    `/api/activities/${activityId}/grouping/stages/${stageId}/groups`,
    {
      method: "PATCH",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision, groups }),
    },
  );
}

export async function confirmGroupingStage(
  activityId: string,
  stageId: string,
  commandId: string,
  expectedRevision: number,
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(
    `/api/activities/${activityId}/grouping/stages/${stageId}/confirm`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision }),
    },
  );
}

export async function freezeGroupingStage(
  activityId: string,
  stageId: string,
  commandId: string,
  expectedRevision: number,
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(
    `/api/activities/${activityId}/grouping/stages/${stageId}/freeze`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision }),
    },
  );
}

export async function correctGroupingStage(
  activityId: string,
  stageId: string,
  commandId: string,
  expectedRevision: number,
  groups: readonly { name?: string; participantIds: readonly string[] }[],
  reason: string,
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(
    `/api/activities/${activityId}/grouping/stages/${stageId}/correct`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision, groups, reason }),
    },
  );
}

export async function cancelGroupingStage(
  activityId: string,
  stageId: string,
  commandId: string,
  expectedRevision: number,
  reason: string,
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(
    `/api/activities/${activityId}/grouping/stages/${stageId}/cancel`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision, reason }),
    },
  );
}

export async function setGroupingWindow(
  activityId: string,
  stageId: string,
  commandId: string,
  expectedRevision: number,
  window: "closed" | "open" | "supplement_only",
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(
    `/api/activities/${activityId}/grouping/stages/${stageId}/window`,
    {
      method: "PATCH",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision, window }),
    },
  );
}
```

- [ ] **Step 2: Build the card**

Create `plus/apps/web/src/components/ops/GroupingCard.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  cancelGroupingStage,
  confirmGroupingStage,
  correctGroupingStage,
  createGroupingStage,
  fetchGrouping,
  freezeGroupingStage,
  recordGroupingGroups,
  setGroupingWindow,
} from "../../api/grouping.js";
import type { GroupingStage } from "../../api/grouping.js";
import { ApiError } from "../../api/client.js";
import { fetchOpsRegistrations } from "../../api/ops.js";

const STAGE_KEY = "chorus";
const STAGE_NAME = "分组合唱";

function commandId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function splitEvenly(participantIds: readonly string[], count: number): string[][] {
  const groups = Array.from({ length: count }, () => [] as string[]);
  participantIds.forEach((participantId, index) => {
    groups[index % count]?.push(participantId);
  });
  return groups;
}

function errorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "GROUPING_INCOMPLETE") return "还有选手没有分到组。";
  if (code === "GROUPING_SOURCE_CHANGED") return "晋级名单变了，请重新确认。";
  if (code === "GROUPING_CONSUMED") return "结果已确认，不能再改分组。";
  if (code === "GROUPING_GROUP_COUNT") return "组数和规则要求不一致。";
  if (code === "GROUPING_SOURCE_UNKNOWN") return "名单还没有定稿。";
  return error instanceof Error ? error.message : String(error);
}

export function GroupingCard(props: { readonly activityId: string }) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ["grouping", props.activityId],
    queryFn: () => fetchGrouping(props.activityId),
    retry: false,
  });
  const participants = useQuery({
    queryKey: ["ops-registrations", props.activityId],
    queryFn: () => fetchOpsRegistrations(props.activityId),
    retry: false,
  });
  const [groupCount, setGroupCount] = useState(5);
  const [draft, setDraft] = useState<readonly (readonly { name: string; participantIds: readonly string[] })[] | null>(null);
  // Mutation responses carry the new revision; confirming from a stale query
  // would otherwise fail with STALE_REVISION while the refetch is in flight.
  const [latest, setLatest] = useState<GroupingStage | null>(null);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [windowState, setWindowState] = useState<"closed" | "open" | "supplement_only">("closed");

  const stage: GroupingStage | undefined = latest ?? state.data?.stages[0];

  useEffect(() => {
    if (stage !== undefined) setWindowState(stage.materialWindow);
  }, [stage?.id, stage?.materialWindow]);

  const approved = (participants.data ?? []).filter((item) => item.status === "approved");
  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of approved) {
      const name = typeof item.answers.name === "string" ? item.answers.name : "";
      map.set(item.participantId, name || item.participantId);
    }
    return map;
  }, [approved]);

  const accept = (next: GroupingStage) => {
    setLatest(next);
    setDraft(null);
    void queryClient.invalidateQueries({ queryKey: ["grouping", props.activityId] });
  };

  const create = useMutation({
    mutationFn: () =>
      createGroupingStage(props.activityId, commandId("group-create"), {
        stageKey: STAGE_KEY,
        name: STAGE_NAME,
        rosterSource: "all_approved",
      }),
    onSuccess: accept,
  });

  const record = useMutation({
    mutationFn: (groups: readonly (readonly { name: string; participantIds: readonly string[] })[]) => {
      if (stage === undefined) throw new Error("赛段尚未创建。");
      return recordGroupingGroups(
        props.activityId,
        stage.id,
        commandId("group-record"),
        stage.revision,
        groups,
      );
    },
    onSuccess: accept,
  });

  const confirm = useMutation({
    mutationFn: () => {
      if (stage === undefined) throw new Error("赛段尚未创建。");
      return confirmGroupingStage(props.activityId, stage.id, commandId("group-confirm"), stage.revision);
    },
    onSuccess: accept,
  });

  const freeze = useMutation({
    mutationFn: () => {
      if (stage === undefined) throw new Error("赛段尚未创建。");
      return freezeGroupingStage(props.activityId, stage.id, commandId("group-freeze"), stage.revision);
    },
    onSuccess: accept,
  });

  const correct = useMutation({
    mutationFn: () => {
      if (stage === undefined) throw new Error("赛段尚未创建。");
      return correctGroupingStage(
        props.activityId,
        stage.id,
        commandId("group-correct"),
        stage.revision,
        groups,
        reason,
      );
    },
    onSuccess: (next) => {
      accept(next);
      setEditing(false);
      setReason("");
    },
  });

  const cancel = useMutation({
    mutationFn: () => {
      if (stage === undefined) throw new Error("赛段尚未创建。");
      return cancelGroupingStage(
        props.activityId,
        stage.id,
        commandId("group-cancel"),
        stage.revision,
        reason,
      );
    },
    onSuccess: (next) => {
      accept(next);
      setReason("");
    },
  });

  const changeWindow = useMutation({
    mutationFn: () => {
      if (stage === undefined) throw new Error("赛段尚未创建。");
      return setGroupingWindow(
        props.activityId,
        stage.id,
        commandId("group-window"),
        stage.revision,
        windowState,
      );
    },
    onSuccess: accept,
  });

  if (state.isError) return null;
  if (state.isLoading) return <section className="ops-card">正在读取分组…</section>;

  const groups = draft ?? (stage?.groups.map((group) => ({
    name: group.name,
    participantIds: group.members.map((member) => member.participantId),
  })) ?? []);

  const assigned = groups.reduce((total, group) => total + group.participantIds.length, 0);
  const error =
    create.error ??
    record.error ??
    confirm.error ??
    freeze.error ??
    correct.error ??
    cancel.error ??
    changeWindow.error;

  return (
    <section className="ops-card grouping-card">
      <p className="eyebrow">GROUPING · 分组</p>
      <h2>第一轮分组</h2>

      {stage === undefined ? (
        <button type="button" className="button-primary" onClick={() => create.mutate()}>
          创建分组赛段
        </button>
      ) : (
        <>
          <p className="state-copy">
            状态：{stage.status} · 已分 {assigned}/{approved.length} 人
            {stage.groupCount === null ? "" : ` · 规则要求 ${stage.groupCount} 组`}
          </p>

          {stage.status === "draft" || editing ? (
            <>
              <label>
                组数
                <input
                  type="number"
                  min={1}
                  value={groupCount}
                  onChange={(event) => setGroupCount(Number(event.target.value))}
                />
              </label>
              <button
                type="button"
                className="button-secondary"
                disabled={participants.isPending}
                onClick={() =>
                  setDraft(
                    splitEvenly(
                      approved.map((item) => item.participantId),
                      Math.max(1, groupCount),
                    ).map((participantIds, index) => ({
                      name: `第 ${index + 1} 组`,
                      participantIds,
                    })),
                  )
                }
              >
                自动平均分组
              </button>
            </>
          ) : null}

          <div className="grouping-grid">
            {groups.map((group) => (
              <article key={group.name} className="grouping-group">
                <strong>{group.name}</strong>
                <ul>
                  {group.participantIds.map((participantId) => (
                    <li key={participantId}>{labels.get(participantId) ?? participantId}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          {stage.status === "draft" ? (
            <button
              type="button"
              className="button-primary"
              disabled={record.isPending}
              onClick={() => record.mutate(groups)}
            >
              保存分组
            </button>
          ) : null}
          {stage.status === "draft" ? (
            <button
              type="button"
              className="button-primary"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              确认分组
            </button>
          ) : null}
          {stage.status === "confirmed" ? (
            <button
              type="button"
              className="button-primary"
              disabled={freeze.isPending}
              onClick={() => freeze.mutate()}
            >
              冻结分组
            </button>
          ) : null}
          {stage.status === "frozen" ? <p className="state-copy">分组已冻结。</p> : null}

          {stage.status !== "cancelled" ? (
            <details className="grouping-more">
              <summary>更多操作</summary>
              {stage.status === "confirmed" || stage.status === "frozen" ? (
                <>
                  <label>
                    材料窗口
                    <select
                      value={windowState}
                      onChange={(event) =>
                        setWindowState(event.target.value as "closed" | "open" | "supplement_only")
                      }
                    >
                      <option value="closed">关闭</option>
                      <option value="open">开放提交</option>
                      <option value="supplement_only">仅补交</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={changeWindow.isPending}
                    onClick={() => changeWindow.mutate()}
                  >
                    应用材料窗口
                  </button>
                </>
              ) : null}

              <label>
                原因
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="修正或取消必须填写"
                />
              </label>

              {stage.status === "confirmed" || stage.status === "frozen" ? (
                editing ? (
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={correct.isPending}
                    onClick={() => correct.mutate()}
                  >
                    保存修正
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => {
                      setDraft(groups);
                      setEditing(true);
                    }}
                  >
                    修正分组
                  </button>
                )
              ) : null}

              {stage.status === "draft" || stage.status === "confirmed" ? (
                <button
                  type="button"
                  className="button-secondary"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  取消赛段
                </button>
              ) : null}
            </details>
          ) : null}
        </>
      )}

      {error === null || error === undefined ? null : (
        <p className="form-error" role="alert">{errorMessage(error)}</p>
      )}
    </section>
  );
}
```

Note: this first version has no member-moving control; it is still "傻瓜式" (auto split + confirm + freeze). A follow-up can add drag/move. The spec's UI section mentions a dropdown; to keep the plan honest, either implement the dropdown or amend the spec. Implement a simple move control:

Inside each member `<li>`, add a `<select>` to move the participant to another group. This requires mutating the `draft` state. Add:

```tsx
<li key={participantId}>
  {labels.get(participantId) ?? participantId}
  {stage.status === "draft" || editing ? (
    <select
      aria-label={`调整 ${participantId}`}
      value={group.name}
      onChange={(event) => {
        const target = event.target.value;
        setDraft(
          groups.map((item) => ({
            name: item.name,
            participantIds:
              item.name === target
                ? [...item.participantIds, participantId]
                : item.participantIds.filter((id) => id !== participantId),
          })),
        );
      }}
    >
      {groups.map((item) => (
        <option key={item.name} value={item.name}>{item.name}</option>
      ))}
    </select>
  ) : null}
</li>
```

- [ ] **Step 3: Render the card**

In `plus/apps/web/src/routes/opsActivity.tsx`:

Import:

```tsx
import { GroupingCard } from "../components/ops/GroupingCard.js";
```

Inside `<div className="ops-grid">`, after the roster section:

```tsx
        {activity?.enabledCapabilities.includes("grouping") &&
        (session?.actor.permissions.includes("grouping.manage") ?? false) ? (
          <GroupingCard activityId={activityId} />
        ) : null}
```

- [ ] **Step 4: Add minimal styles**

Append to `plus/apps/web/src/styles/global.css`:

```css
.grouping-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin: 12px 0;
}

.grouping-group {
  border: 1px solid var(--line, #ddd);
  border-radius: 10px;
  padding: 12px;
}

.grouping-group ul {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}

.grouping-group li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0;
}
```

- [ ] **Step 5: Grant the permission in the E2E seed**

In `plus/apps/api/scripts/seed-registration.ts`, add to `adminPermissions`:

```ts
  "grouping.manage",
```

- [ ] **Step 6: Add the E2E seed**

Create `plus/apps/api/scripts/seed-grouping.ts` modeled on `seed-registration.ts`:

```ts
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import {
  closeDb,
  createDb,
  getActivity,
  insertRelease,
  migrate,
} from "@artflow-plus/db";

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

const activityId = "act_e2e_grouping";
const publicCode = "E2E-GROUPING";

// Reset only the data this seed owns; the activity and its release are reused.
await db.deleteFrom("grouping_stage").where("activity_id", "=", activityId).execute();
await db.deleteFrom("registration").where("activity_id", "=", activityId).execute();
await db.deleteFrom("roster").where("activity_id", "=", activityId).execute();

if ((await getActivity(db, activityId)) === null) {
  await db.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title: "E2E 分组",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "grouping"]),
    active_definition_version: 1,
  }).execute();

  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "e2e-grouping-release",
    capabilities: {
      grouping: {
        ok: true,
        capabilityKey: "grouping",
        contentHash: "e2e-grouping",
        artifact: { schemaVersion: 1, groupCount: 2 },
      },
    },
    executionPolicy: { declaredScopes: [], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { grouping: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
}

await db.insertInto("roster").values({
  activity_id: activityId,
  status: "final",
  approved_count: 4,
  revision: 1,
  finalized_at: "2026-10-27T09:30:00Z",
  updated_at: new Date(),
}).execute();

for (const [index, participantId] of ["p1", "p2", "p3", "p4"].entries()) {
  await db.insertInto("registration").values({
    id: `registration-${activityId}-${participantId}`,
    activity_id: activityId,
    participant_id: participantId,
    questionnaire_version: "v1",
    questionnaire_hash: "hash",
    status: "approved",
    answers: JSON.stringify({ name: `选手${index + 1}` }),
    revision: 1,
    review_note: "",
    reviewed_by: "staff",
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
}

await closeDb(db);
console.log(`Seeded grouping activity ${activityId} (${publicCode}).`);
```

Note: participant ids must match the E2E account actors only if participants log in; here staff only, so arbitrary ids are fine. Registration display name comes from answers.

- [ ] **Step 7: Run the seed in the E2E script**

In `plus/apps/api/package.json`, append to `seed:e2e`:

```json
    "seed:e2e": "tsx scripts/seed-public-result.ts && tsx scripts/seed-registration.ts && tsx scripts/seed-live.ts && tsx scripts/seed-legacy.ts && tsx scripts/seed-grouping.ts",
```

- [ ] **Step 8: Add the E2E spec**

Create `plus/apps/web/e2e/grouping.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("ops splits, confirms, and freezes a grouping stage", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/ops$/);

  await page.goto("/ops/act_e2e_grouping");
  await expect(page.getByRole("heading", { name: "第一轮分组" })).toBeVisible();

  await page.getByRole("button", { name: "创建分组赛段" }).click();
  await page.getByRole("button", { name: "自动平均分组" }).click();
  await page.getByRole("button", { name: "保存分组" }).click();
  await expect(page.getByText("已分 4/4 人")).toBeVisible();

  await page.getByRole("button", { name: "确认分组" }).click();
  await expect(page.getByText("状态：confirmed")).toBeVisible();

  await page.getByRole("button", { name: "冻结分组" }).click();
  await expect(page.getByText("分组已冻结")).toBeVisible();
});
```

- [ ] **Step 9: Run the E2E**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus --filter @artflow-plus/web test:e2e -- e2e/grouping.spec.ts
```
Expected: PASS (1 test).

- [ ] **Step 10: Commit**

```powershell
git add plus/apps/web/src/api/grouping.ts plus/apps/web/src/components/ops/GroupingCard.tsx plus/apps/web/src/routes/opsActivity.tsx plus/apps/web/src/styles/global.css plus/apps/api/scripts/seed-grouping.ts plus/apps/api/scripts/seed-registration.ts plus/apps/api/package.json plus/apps/web/e2e/grouping.spec.ts
git commit -m "feat(web): add the ops grouping card and journey"
```

---

## Task 10: Legacy export and import

**Files:**
- Modify: `common/management/commands/export_plus_bundle.py`
- Modify: `plus/packages/runtime/src/legacy-bundle.ts`
- Modify: `plus/packages/runtime/src/legacy-import-service.ts`
- Modify: `plus/packages/runtime/test/legacy-import.test.ts`

- [ ] **Step 1: Write the failing exporter and importer tests**

Add to `common/test_plus_bundle.py` (imports: `create_group_stage`,
`record_group_stage`, `confirm_group_stage`, `freeze_group_stage` from
`singer_contest.group_chorus`):

```python
    def test_export_includes_grouping_stages(self) -> None:
        activity = self._activity()
        alice = self._registration(activity, "Alice")
        bob = self._registration(activity, "Bob")
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=activity.pk).update(phase=Activity.Phase.REHEARSAL)
        staff = get_user_model().objects.create_user(
            username="export-staff", password="staff-password", role="admin"
        )
        stage = create_group_stage(
            activity, stage_key="chorus", name="分组合唱", operator=staff
        )
        record_group_stage(
            stage,
            [
                {"name": "A 组", "singer_ids": [alice.pk]},
                {"name": "B 组", "singer_ids": [bob.pk]},
            ],
            staff,
        )
        confirm_group_stage(stage, staff)
        freeze_group_stage(stage, staff)
        output = Path(tempfile.mkdtemp()) / "bundle.json"

        call_command("export_plus_bundle", activity="LEG2025", output=str(output))

        bundle = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(len(bundle["grouping"]), 1)
        self.assertEqual(bundle["grouping"][0]["status"], "frozen")
        self.assertEqual(bundle["grouping"][0]["materialWindow"], "closed")
        self.assertEqual(len(bundle["grouping"][0]["groups"]), 2)
        kinds = {entry["kind"] for entry in bundle["unsupported"]}
        self.assertNotIn("group_stage", kinds)
```

Add to `plus/packages/runtime/test/legacy-import.test.ts`:

```ts
it("imports frozen grouping stages and their current members", async () => {
  const bundle = {
    ...baseBundle,
    grouping: [
      {
        legacyId: 7,
        stageKey: "chorus",
        name: "分组合唱",
        status: "frozen",
        rosterSource: "all_approved",
        materialWindow: "open",
        groups: [
          { legacyId: 70, name: "A", groupOrder: 1, participantKeys: ["p1"] },
          { legacyId: 71, name: "B", groupOrder: 2, participantKeys: ["p2"] },
        ],
      },
    ],
  };
  const { report } = await importLegacyBundle(db, deps(), {
    bundle,
    commandId: "legacy-grouping",
    dryRun: false,
  });
  const stages = await db.selectFrom("grouping_stage").selectAll()
    .where("activity_id", "=", report.activityId).execute();
  expect(stages).toHaveLength(1);
  expect(stages[0]?.status).toBe("frozen");
  expect(stages[0]?.material_window).toBe("open");
  const members = await db.selectFrom("grouping_membership").selectAll()
    .where("stage_id", "=", stages[0]?.id).where("is_current", "=", true).execute();
  expect(members.map((row) => row.participant_id).sort()).toEqual(["p1", "p2"]);
});
```

- [ ] **Step 2: Run them and confirm they fail**

```powershell
uv run python manage.py test common.test_plus_bundle -v 2
```
Expected: FAIL — `bundle["grouping"]` raises `KeyError`.

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/legacy-import.test.ts
```
Expected: FAIL — the bundle parser drops `grouping`.

- [ ] **Step 3: Extend the bundle type and parser**

In `plus/packages/runtime/src/legacy-bundle.ts`, add before `readonly counts`:

```ts
  readonly grouping?: readonly {
    readonly legacyId: number;
    readonly stageKey: string;
    readonly name: string;
    readonly status: "draft" | "confirmed" | "frozen" | "cancelled";
    readonly rosterSource: "all_approved" | "round_advanced";
    readonly sourceRoundLegacyId?: number;
    readonly materialWindow: "closed" | "open" | "supplement_only";
    readonly groups: readonly {
      readonly legacyId: number;
      readonly name: string;
      readonly groupOrder: number;
      readonly participantKeys: readonly string[];
    }[];
  }[];
```

- [ ] **Step 4: Emit the section from v1**

In `common/management/commands/export_plus_bundle.py`, replace the `group_stages` unsupported block with an export:

```python
        grouping = []
        for stage in (
            GroupStage.objects.filter(activity=activity)
            .order_by("created_at", "pk")
            .prefetch_related("groups__memberships")
        ):
            groups = []
            for group in stage.groups.filter(is_active=True).order_by("group_order", "pk"):
                participant_keys = [
                    participant_by_singer.get(membership.singer_id, f"legacy-user:{membership.singer_id}")
                    for membership in group.memberships.filter(is_current=True).order_by("singer_id")
                ]
                groups.append(
                    {
                        "legacyId": group.pk,
                        "name": group.name,
                        "groupOrder": group.group_order,
                        "participantKeys": participant_keys,
                    }
                )
            if not groups:
                continue
            grouping.append(
                {
                    "legacyId": stage.pk,
                    "stageKey": stage.stage_key,
                    "name": stage.name,
                    "status": stage.status,
                    "rosterSource": stage.roster_source,
                    "sourceRoundLegacyId": stage.roster_source_round_id,
                    "materialWindow": stage.material_status,
                    "groups": groups,
                }
            )
```

Add `"grouping": grouping,` to the bundle dict at line ~419 (next to `"rounds"`).
Do **not** add a grouping entry to `counts`: the v2 reconciliation checks only the
existing count keys.

Remove the old `unsupported.append({"kind": "group_stage", ...})` block.

- [ ] **Step 5: Import the section**

In `plus/packages/runtime/src/legacy-import-service.ts`:

1. Near `LEGACY_CAPABILITIES`, keep the list unchanged. Inside `importActivity`, compute:

```ts
  const hasGrouping = bundle.grouping !== undefined && bundle.grouping.length > 0;
  const enabledCapabilities = hasGrouping
    ? [...LEGACY_CAPABILITIES, "grouping"]
    : [...LEGACY_CAPABILITIES];
```

Use it in the activity insert:

```ts
    enabled_capabilities: JSON.stringify(enabledCapabilities),
```

2. Add the grouping capability plan to `capabilityEntries`:

```ts
    ...(hasGrouping
      ? {
          grouping: artifacts.capabilityPlan(
            "grouping",
            { schemaVersion: 1 },
            stableHash({ grouping: 1 }),
          ),
        }
      : {}),
```

3. Add the import function:

```ts
async function importGrouping(
  trx: Transaction<Database>,
  activityId: string,
  publicCode: string,
  prefix: string,
  stages: NonNullable<LegacyBundle["grouping"]>,
  participantKeys: ReadonlySet<string>,
  roundIds: ReadonlySet<string>,
  createdAt: string,
  notes: string[],
): Promise<void> {
  const stageIdFor = (legacyId: number) => `legacy-${publicCode}-grouping-${legacyId}`;
  const groupIdFor = (legacyId: number) => `legacy-${publicCode}-grouping-group-${legacyId}`;
  for (const stage of stages) {
    const sourceRoundId = stage.sourceRoundLegacyId === undefined
      ? undefined
      : `${prefix}-round-${stage.sourceRoundLegacyId}`;
    const rosterSource =
      stage.rosterSource === "round_advanced" &&
      sourceRoundId !== undefined &&
      roundIds.has(sourceRoundId)
        ? "round_advanced"
        : "all_approved";
    if (stage.rosterSource === "round_advanced" && rosterSource === "all_approved") {
      notes.push(
        `grouping ${stage.stageKey}: source round ${stage.sourceRoundLegacyId ?? "?"} was not imported; treated as all_approved`,
      );
    }
    const stageId = stageIdFor(stage.legacyId);
    await trx.insertInto("grouping_stage").values({
      id: stageId,
      activity_id: activityId,
      stage_key: stage.stageKey,
      name: stage.name,
      status: stage.status,
      roster_source: rosterSource,
      source_round_id: rosterSource === "round_advanced" ? sourceRoundId ?? null : null,
      source_fingerprint: "",
      material_window: stage.materialWindow,
      cancel_reason: "",
      confirmed_at: stage.status === "draft" ? null : createdAt,
      confirmed_by: stage.status === "draft" ? null : "legacy",
      frozen_at: stage.status === "frozen" ? createdAt : null,
      frozen_by: stage.status === "frozen" ? "legacy" : null,
      cancelled_at: stage.status === "cancelled" ? createdAt : null,
      cancelled_by: stage.status === "cancelled" ? "legacy" : null,
      revision: 1,
      created_at: new Date(createdAt),
      updated_at: createdAt,
    }).execute();

    for (const group of stage.groups) {
      const groupId = groupIdFor(group.legacyId);
      await trx.insertInto("grouping_group").values({
        id: groupId,
        stage_id: stageId,
        group_order: group.groupOrder,
        name: group.name,
        is_active: true,
        created_at: new Date(createdAt),
        updated_at: createdAt,
      }).execute();
      for (const participantKey of group.participantKeys) {
        if (!participantKeys.has(participantKey)) {
          notes.push(
            `grouping ${stage.stageKey}: participant ${participantKey} has no imported registration`,
          );
          continue;
        }
        await trx.insertInto("grouping_membership").values({
          id: `legacy-${publicCode}-grouping-member-${group.legacyId}-${participantKey}`,
          stage_id: stageId,
          group_id: groupId,
          participant_id: participantKey,
          is_current: true,
          joined_at: createdAt,
          left_at: null,
          removed_by: null,
          reason: "",
        }).execute();
      }
    }
  }
}
```

4. Call it inside `importActivity` after `importCompetition` and before `importResults`:

```ts
  const groupingNotes: string[] = [];
  if (bundle.grouping !== undefined && bundle.grouping.length > 0) {
    const participantKeys = new Set(bundle.registrations.map((row) => row.participantKey));
    const roundIds = new Set([...roundsByLegacy.keys()].map((id) => `${prefix}-round-${id}`));
    await importGrouping(
      trx,
      activityId,
      bundle.activity.publicCode,
      prefix,
      bundle.grouping,
      participantKeys,
      roundIds,
      deps.now(),
      groupingNotes,
    );
  }
```

5. Merge the notes into the report. Just before the `appendEngineEvent(... "LegacyBundleImported" ...)` call, add:

```ts
  const unsupported = [
    ...bundle.unsupported,
    ...groupingNotes.map((reason) => ({ kind: "grouping", reason })),
  ];
```

Use `unsupported` (instead of `bundle.unsupported`) in both the event payload and the returned report.

- [ ] **Step 6: Run the import tests**

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/legacy-import.test.ts
```
Expected: PASS.

- [ ] **Step 7: Run the v1 exporter tests**

```powershell
uv run python manage.py test common.test_plus_bundle -v 2
```
Expected: PASS, including the new grouping export test.

- [ ] **Step 8: Commit**

```powershell
git add common/management/commands/export_plus_bundle.py plus/packages/runtime/src/legacy-bundle.ts plus/packages/runtime/src/legacy-import-service.ts plus/packages/runtime/test/legacy-import.test.ts
git commit -m "feat(legacy): export and import grouping stages"
```

---

## Task 11: Documentation and full gates

**Files:**
- Create: `docs/architecture/adr/0025-grouping-capability.md`
- Modify: `docs/invariants/lifecycle.md`
- Modify: `docs/artflow-plus/roadmap.md`
- Modify: `docs/artflow-plus/shape-validation.md`

- [ ] **Step 1: Write ADR-0025**

Create `docs/architecture/adr/0025-grouping-capability.md`:

```md
# ADR-0025：分组由独立 capability 承载

状态：已采纳（2026-10-27）

## 背景

v1 把分组合唱赛段做成 `GroupStage` + `Group` + `GroupMembership`：分组由外部抽签
产生，赛段自己拥有名单来源、材料窗口和冻结快照。v2 此前没有对应物，v1 导出器把
它标为 `unsupported`。它既不属于报名生命周期（发生在报名截止之后），也不属于比赛
轮次生命周期（可以在没有比赛的活动里存在）。

## 决策

- 新增 `grouping` capability，依赖 `registration` 与 `competition`，只贡献 Ops 面，
  不声明新的执行 scope。
- 聚合是四态的（draft/confirmed/frozen/cancelled），成员关系只追加；数据库用
  `(stage_id, participant_id) WHERE is_current` 唯一索引兜底。
- 两种名单来源：全部已批准（要求 roster final）与指定轮次晋级（要求最新
  advancement decision 为 `auto`）；冻结时重新解析并比对指纹。
- 组数由 active release 的 `groupCount` 约束（声明了才检查），每组人数自由；
  没有 release 时不约束。
- 消费保护采用活动级保守边界：存在已确认 `stage_result` 时拒绝修正与取消。
- 活动状态允许 `active` 与 `closed`，只拒绝 `archived`；`closed` 不是锁定。
- 材料窗口只保留状态机；组材料文件与补交限定归后续媒体 slice。
- v2 没有 `PerformanceGroup`，因此不存在第二份评分名单；v1 的「评分节目必须与
  冻结分组一致」在 v2 结构性消失。

## 后果

- Ops 只暴露「分组 → 确认 → 冻结」三步；所有严格规则在服务端。
- v1 导出器需要随一次 v1 热修发布，bundle 中才会出现 `grouping` 段；没有该段的
  旧 bundle 仍可导入（分组缺失）。
- 分组修正不能被 v2 release 直接证明「已被消费」，因此采用活动级判断，可能比
  v1 更保守。
```


- [ ] **Step 2: Record the invariants**

Append to `docs/invariants/lifecycle.md`:

```md
## GRP-01…09 分组赛段

**规则**：一名选手在一个分组赛段内最多一条 current 成员关系；确认必须完整覆盖来源
名单；冻结重新比对来源指纹；已冻结不可取消；未冻结未取消阻塞归档；来源名单未定
（roster 未 final 或 advancement 非 auto）时 fail closed；材料窗口只在 confirmed/
frozen 可设且取消时关闭；组数由 release 的 `groupCount` 约束而每组人数自由；
`rosterSource` 创建后不可变；存在已确认 `stage_result` 时拒绝修正与取消。

**为什么**：v1 的 `GroupStage` 把外部抽签结果、材料窗口和冻结快照放在同一聚合里，
而报名与比赛轮次都发生在它之前/之后。把消费保护做成活动级保守边界，是因为 v2 的
release 不引用运行期分组 id。

**必须攻击的形状**：跨组重复成员、确认时漏人、冻结前改名单、冻结后取消、归档前
未冻结、组数与 release 不一致、已确认结果后改分组。
```

- [ ] **Step 3: Update roadmap and shape validation**

In `docs/artflow-plus/roadmap.md`, add under M8 (or a new M9 note):

```md
## M9 — Grouping Capability（已完成 2026-10-27）

- 新 `grouping` capability：四态生命周期、append-only 成员历史、两种名单来源、
  材料窗口状态、release `groupCount` 校验、活动级消费保护。
- Ops 三步卡片；归档阻塞与归档包 `grouping.json`/CSV；v1 导出/导入。
- 出口：domain/db/runtime/api/web E2E 全绿；GRP-01…09 写入不变量。
```

In `docs/artflow-plus/shape-validation.md`, change the gap row for
`分组/合唱阶段` from "独立 capability；当前导入标记 unsupported" to
"已由 `grouping` capability 承载；组材料文件仍归媒体 slice".

- [ ] **Step 4: Run the docs check and the full gates**

```powershell
pwsh -NoProfile -File scripts/check_docs.ps1
```
Expected: PASS.

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus run check
pnpm -C plus run test
```
Expected: PASS (all packages; includes the repaired judge-session test).

- [ ] **Step 5: Sweep the configuration lists**

Confirm every new TypeScript file is covered by:
- `plus/tsconfig*.json` and each package's `tsconfig.json`
- `plus/apps/web/tsconfig.json` and the Tailwind `content` globs
- `tests/gates/test_config_lists.py` expectations
- the pyright `include` list and the ruff/mypy module lists (Python files only)

Run:

```powershell
uv run pytest tests/gates -q
```
Expected: PASS.

- [ ] **Step 6: Commit and integrate**

```powershell
git add docs/architecture/adr/0025-grouping-capability.md docs/invariants/lifecycle.md docs/artflow-plus/roadmap.md docs/artflow-plus/shape-validation.md
git commit -m "docs: record the grouping capability and invariants"
git checkout artflow-plus
git merge --no-ff feat/plus-grouping -m "merge: grouping capability"
git push origin artflow-plus
```

---

## Self-review checklist

- Every spec section maps to a task: definition/compiler (1), registry/pack (2),
  tables/constraints (3), lifecycle (4–5), read model (6), archive (7), API (8),
  UI/E2E (9), import/export (10), docs (11).
- No placeholders: every step names a file, a command, and the expected result.
- Types line up: `StoredGroupingStage` is used by the service, API, and archive;
  `GroupingGroupSpec` is used by the domain and API bodies; `getGroupingState` is
  the only read entry point.
- Deliberate deferrals recorded in the spec: group material bytes, question-level
  supplement restriction, round/performance-group linkage.
