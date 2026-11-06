# M7a Publishing / Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `publishing` capability so a confirmed podium candidate becomes an immutable public result release, with revoke/unlock/re-release and one anonymous selector.

**Architecture:** A new `publishing` capability owns stage-result confirmation, the editorial publication container, release snapshots, and the public selector. The runtime reads the latest competition podium candidate inside the same Activity-locked transaction, so the client can never supply the ranking. PostgreSQL stores current state in three tables; the outbox stays the immutable event log.

**Tech Stack:** TypeScript 7, Kysely 0.29, PostgreSQL 18.6, Fastify 5 + TypeBox, Vitest 5, pnpm 12.

**Spec:** `docs/artflow-plus/specs/2026-10-26-m7a-publishing-design.md`

---

## Environment

Run every command from the repository root unless a step says otherwise.

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
```

The container is already running (`artflow-plus-postgres`, PostgreSQL 18.6, port 5433).
Work happens on the existing branch `feat/plus-m7a-publishing`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `plus/packages/domain/src/capabilities/publishing.ts` | Definition compiler, artifact decoder, awards/snapshot functions, capability registration |
| `plus/packages/domain/src/errors.ts` | New domain error codes |
| `plus/packages/domain/src/defaults.ts` | Register `publishing` in the default registry |
| `plus/packages/db/src/migrations.ts` | Migration `0012_m7_publishing` |
| `plus/packages/db/src/types.ts` | Row types and `Database` entries |
| `plus/packages/db/src/score-repository.ts` | Type the podium placement shape (no behavior change) |
| `plus/packages/db/src/publishing-repository.ts` | Locks, CRUD, release history, public selector |
| `plus/packages/db/src/index.ts` | Export the new repository |
| `plus/packages/runtime/src/publishing-service.ts` | Confirm/release/revoke/unlock/edit commands and staff state read |
| `plus/packages/runtime/src/index.ts` | Export the service |
| `plus/packages/contracts/src/publishing.ts` | HTTP body/param/query schemas |
| `plus/packages/contracts/src/index.ts` | Export the schemas |
| `plus/apps/api/src/app.ts` | Error status map and seven routes |
| `plus/packages/domain/test/publishing.test.ts` | Domain tests |
| `plus/packages/db/test/publishing-repository.test.ts` | Persistence and selector tests |
| `plus/packages/db/test/migrations.test.ts` | Migration 0012 assertions |
| `plus/packages/runtime/test/publishing-service.test.ts` | Lifecycle, permissions, revisions, concurrency |
| `plus/packages/runtime/test/golden-result-release-lifecycle.test.ts` | Golden adapter |
| `plus/apps/api/test/publishing.test.ts` | HTTP, auth, anonymous selector |
| `docs/architecture/adr/0014-publishing-ownership.md` | Ownership decision |
| `docs/artflow-plus/roadmap.md`, `plus/README.md`, `docs/domains/results.md` | Status and usage documentation |

---

### Task 1: Domain capability and error codes

**Files:**
- Create: `plus/packages/domain/src/capabilities/publishing.ts`
- Modify: `plus/packages/domain/src/errors.ts`
- Modify: `plus/packages/domain/src/defaults.ts`
- Test: `plus/packages/domain/test/publishing.test.ts`

- [ ] **Step 1: Write the failing domain test**

Create `plus/packages/domain/test/publishing.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildResultSnapshot,
  compilePublishingDefinition,
  createEmptyPublishingDefinition,
  createPublishingDefinition,
  defaultCapabilityRegistry,
  validateAwards,
} from "../src/index.js";

const decisions = [
  { rank: 1, contestantId: "singer-a", score: "98.30" },
  { rank: 2, contestantId: "singer-b", score: "97.80" },
];

function expectCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("publishing capability", () => {
  it("registers and compiles the default final_podium stage", () => {
    expect(defaultCapabilityRegistry.get("publishing")).toBeDefined();
    const compiled = compilePublishingDefinition(createEmptyPublishingDefinition());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact).toMatchObject({
      version: 1,
      schemaVersion: 1,
      stages: [{ key: "final_podium", label: "正式赛果" }],
    });
  });

  it("rejects empty, duplicate, and blank stages", () => {
    expect(compilePublishingDefinition(createPublishingDefinition([])).ok).toBe(false);
    expect(
      compilePublishingDefinition(
        createPublishingDefinition([
          { key: "stage", label: "A" },
          { key: "stage", label: "B" },
        ]),
      ).ok,
    ).toBe(false);
    expect(
      compilePublishingDefinition(createPublishingDefinition([{ key: "", label: "A" }])).ok,
    ).toBe(false);
  });

  it("validates awards against the confirmed decisions", () => {
    expect(() =>
      validateAwards(decisions, [{ award: "冠军", contestantId: "singer-a" }]),
    ).not.toThrow();
    expectCode(
      () => validateAwards(decisions, [{ award: "冠军", contestantId: "singer-x" }]),
      "AWARD_INVALID",
    );
    expectCode(
      () => validateAwards(decisions, [{ award: " ", contestantId: "singer-a" }]),
      "AWARD_INVALID",
    );
    expectCode(
      () =>
        validateAwards(decisions, [
          { award: "冠军", contestantId: "singer-a" },
          { award: "冠军", contestantId: "singer-b" },
        ]),
      "AWARD_INVALID",
    );
  });

  it("freezes the snapshot and derives the public title from the stage label", () => {
    const snapshot = buildResultSnapshot({
      activityTitle: "2026 院十佳",
      stageKey: "final_podium",
      stageLabel: "正式赛果",
      decisions,
      awards: [{ award: "冠军", contestantId: "singer-a" }],
    });
    expect(snapshot.publicTitle).toBe("2026 院十佳 · 正式赛果");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.decisions)).toBe(true);
    expect(Object.isFrozen(snapshot.awards)).toBe(true);
    expect(snapshot.decisions).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
pnpm -C plus --filter @artflow-plus/domain run test -- publishing.test.ts
```

Expected: FAIL — `publishing` is not exported and the default registry has no `publishing`.

- [ ] **Step 3: Add the domain error codes**

In `plus/packages/domain/src/errors.ts`, append these entries to `DomainErrorCode` before `"RATE_LIMITED"`:

```ts
  | "RESULT_POST_FROZEN"
  | "RESULT_ALREADY_RELEASED"
  | "RESULT_RELEASE_NOT_ACTIVE"
  | "RESULT_NOT_CONFIRMED"
  | "RESULT_CANDIDATE_HOLD"
  | "AWARD_INVALID"
```

- [ ] **Step 4: Create the publishing capability**

Create `plus/packages/domain/src/capabilities/publishing.ts`:

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

export interface PublishingStageDefinition {
  readonly key: string;
  readonly label: string;
}

export interface CompiledPublishingArtifact {
  readonly version: 1;
  readonly schemaVersion: 1;
  readonly stages: readonly PublishingStageDefinition[];
}

export interface ResultDecision {
  readonly rank: number;
  readonly contestantId: string;
  readonly score: string;
}

export interface ResultAward {
  readonly award: string;
  readonly contestantId: string;
}

export interface ResultSnapshot {
  readonly activityTitle: string;
  readonly publicTitle: string;
  readonly stageKey: string;
  readonly decisions: readonly ResultDecision[];
  readonly awards: readonly ResultAward[];
}

const DEFAULT_STAGE: PublishingStageDefinition = { key: "final_podium", label: "正式赛果" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStages(value: unknown): PublishingStageDefinition[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const stages: PublishingStageDefinition[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    if (typeof raw.key !== "string" || !raw.key.trim()) return null;
    if (typeof raw.label !== "string" || !raw.label.trim()) return null;
    stages.push({ key: raw.key.trim(), label: raw.label.trim() });
  }
  if (new Set(stages.map((stage) => stage.key)).size !== stages.length) return null;
  return stages;
}

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

export function createPublishingDefinition(
  stages: readonly PublishingStageDefinition[],
): CapabilityDefinition {
  return {
    schemaVersion: 1,
    payload: {
      version: 1,
      schemaVersion: 1,
      stages: stages.map((stage) => ({ key: stage.key, label: stage.label })),
    },
  };
}

export function createEmptyPublishingDefinition(): CapabilityDefinition {
  return createPublishingDefinition([DEFAULT_STAGE]);
}

export function compilePublishingDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  if (definition.schemaVersion !== 1 || !isRecord(definition.payload)) {
    return deepFreeze({
      ok: false,
      issues: [issue("PAYLOAD_INVALID", "Not a publishing definition.", "payload")],
    });
  }
  const payload = definition.payload;
  if (payload.version !== 1 || payload.schemaVersion !== 1) {
    return deepFreeze({
      ok: false,
      issues: [issue("PAYLOAD_INVALID", "Unsupported publishing definition version.", "payload")],
    });
  }
  const stages = parseStages(payload.stages);
  if (stages === null) {
    return deepFreeze({
      ok: false,
      issues: [
        issue(
          "STAGES_INVALID",
          "Publishing stages must be non-empty, unique, and have a key and label.",
          "payload.stages",
        ),
      ],
    });
  }
  const artifact: CompiledPublishingArtifact = { version: 1, schemaVersion: 1, stages };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "publishing",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export function decodePublishingArtifact(value: unknown): CompiledPublishingArtifact {
  if (!isRecord(value) || value.version !== 1 || value.schemaVersion !== 1) {
    fail("RELEASE_SNAPSHOT_INCOMPLETE", "The publishing release artifact version is unsupported.");
  }
  const stages = parseStages(value.stages);
  if (stages === null) {
    fail("RELEASE_SNAPSHOT_INCOMPLETE", "The publishing release artifact has no valid stages.");
  }
  return deepFreeze({ version: 1, schemaVersion: 1, stages });
}

export function validateAwards(
  decisions: readonly ResultDecision[],
  awards: readonly ResultAward[],
): void {
  const contestants = new Set(decisions.map((decision) => decision.contestantId));
  const labels = new Set<string>();
  for (const award of awards) {
    const label = award.award.trim();
    if (!label) fail("AWARD_INVALID", "An award label is required.");
    if (labels.has(label)) fail("AWARD_INVALID", `Award ${label} is duplicated.`);
    labels.add(label);
    if (!contestants.has(award.contestantId)) {
      fail("AWARD_INVALID", `Award ${label} names a contestant outside the confirmed decisions.`);
    }
  }
}

export function buildResultSnapshot(input: {
  readonly activityTitle: string;
  readonly stageKey: string;
  readonly stageLabel: string;
  readonly decisions: readonly ResultDecision[];
  readonly awards: readonly ResultAward[];
}): ResultSnapshot {
  const decisions = input.decisions.map((decision) => ({ ...decision }));
  const awards = input.awards.map((award) => ({ ...award }));
  return deepFreeze({
    activityTitle: input.activityTitle,
    publicTitle: `${input.activityTitle} · ${input.stageLabel}`,
    stageKey: input.stageKey,
    decisions,
    awards,
  });
}

export const publishingCompiler: CapabilityCompiler = {
  capabilityKey: "publishing",
  compile: compilePublishingDefinition,
};

export const publishingCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "publishing",
    version: "1",
    dependencies: ["competition"],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "publishing.stage_result.confirm",
      "publishing.stage_result.unlock",
      "publishing.result.release",
      "publishing.result.revoke",
      "publishing.publication.edit",
    ],
    queries: ["publishing.state.read", "publishing.public_results.read"],
    events: [
      "StageResultConfirmed",
      "StageResultUnlocked",
      "ResultReleased",
      "ResultReleaseRevoked",
      "ResultReleaseSuperseded",
      "ResultPublicationEdited",
    ],
    permissions: ["result.manage"],
    surfaces: ["studio", "ops", "portal"],
    scopes: ["publishing"],
  },
  compiler: publishingCompiler,
  emptyDefinition: createEmptyPublishingDefinition,
});
```

- [ ] **Step 5: Register the capability**

In `plus/packages/domain/src/defaults.ts`, add the import and registry entry:

```ts
import { publishingCapability } from "./capabilities/publishing.js";
```

```ts
    votingCapability,
    ticketingCapability,
    publishingCapability,
```

In `plus/packages/domain/src/index.ts`, add:

```ts
export * from "./capabilities/publishing.js";
```

Update the two tests that enumerate the default registry:

In `plus/packages/domain/test/registry-packs.test.ts`, change the expected list to:

```ts
    "competition",
    "materials",
    "publishing",
    "questionnaire",
    "registration",
    "ticketing",
    "voting",
```

In `plus/apps/api/test/http.test.ts`, change the capabilities length to `7` and the expected
identity list to:

```ts
    "competition",
    "materials",
    "publishing",
    "questionnaire",
    "registration",
    "ticketing",
    "voting",
```

- [ ] **Step 6: Run the domain tests to verify they pass**

```powershell
pnpm -C plus --filter @artflow-plus/domain run test -- publishing.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Run the whole domain package**

```powershell
pnpm -C plus --filter @artflow-plus/domain run test
```

Expected: PASS. `registry-packs` tests still pass because they disable `publish-results` explicitly.

- [ ] **Step 8: Commit**

```powershell
git add plus/packages/domain plus/apps/api/test/http.test.ts
git commit -m "feat: add publishing capability domain model"
```

---

### Task 2: Migration 0012, row types, and podium placement typing

**Files:**
- Modify: `plus/packages/db/src/migrations.ts`
- Modify: `plus/packages/db/src/types.ts`
- Modify: `plus/packages/db/src/score-repository.ts`
- Test: `plus/packages/db/test/migrations.test.ts`

- [ ] **Step 1: Write the failing migration test**

Append this test inside the existing `describe` in `plus/packages/db/test/migrations.test.ts`:

```ts
  it("creates the publishing tables and the single-active-release index", async () => {
    await migrate(db);
    const tables = await sql<{ table_name: string }>`
      select table_name
        from information_schema.tables
       where table_schema = current_schema()
         and table_name in ('stage_result', 'result_publication', 'result_release')
       order by table_name
    `.execute(db);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "result_publication",
      "result_release",
      "stage_result",
    ]);
    const indexes = await sql<{ indexname: string }>`
      select indexname
        from pg_indexes
       where schemaname = current_schema()
         and indexname = 'result_release_active_key'
    `.execute(db);
    expect(indexes.rows).toHaveLength(1);
  });

  it("drops publishing tables when rolling back 0012", async () => {
    await migrate(db);
    await migrateTo(db, "0011_voting_identity_policy");
    const tables = await sql<{ table_name: string }>`
      select table_name
        from information_schema.tables
       where table_schema = current_schema()
         and table_name in ('stage_result', 'result_publication', 'result_release')
    `.execute(db);
    expect(tables.rows).toHaveLength(0);
    await migrate(db);
  });
```

- [ ] **Step 2: Run the migration test to verify it fails**

```powershell
pnpm -C plus/packages/db exec vitest run test/migrations.test.ts
```

Expected: FAIL — the three tables and `result_release_active_key` do not exist.

- [ ] **Step 3: Add the row types**

In `plus/packages/db/src/types.ts`, add before `export interface Database`:

```ts
export interface StageResultRow {
  id: string;
  activity_id: string;
  stage_key: string;
  status: string;
  candidate_revision: number;
  source_candidate_revision: number;
  input_fingerprint: string;
  decisions: ColumnType<unknown, string, string>;
  awards: ColumnType<unknown, string, string>;
  revision: number;
  confirmed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  unlocked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface ResultPublicationRow {
  id: string;
  activity_id: string;
  stage_key: string;
  title: string;
  content: string;
  version: number;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface ResultReleaseRow {
  id: string;
  activity_id: string;
  publication_id: string;
  stage_result_id: string;
  stage_key: string;
  status: string;
  snapshot: ColumnType<unknown, string, string>;
  snapshot_candidate_revision: number;
  result_version: number;
  post_version: number;
  input_fingerprint: string;
  note: string;
  released_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  superseded_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
}
```

Add to `Database`:

```ts
  stage_result: StageResultRow;
  result_publication: ResultPublicationRow;
  result_release: ResultReleaseRow;
```

- [ ] **Step 4: Add migration `0012_m7_publishing`**

In `plus/packages/db/src/migrations.ts`, insert before the closing `};` of `migrations`:

```ts
  "0012_m7_publishing": {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("stage_result")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("stage_key", "varchar(100)", (column) => column.notNull())
        .addColumn("status", "varchar(30)", (column) => column.notNull())
        .addColumn("candidate_revision", "integer", (column) => column.notNull())
        .addColumn("source_candidate_revision", "integer", (column) => column.notNull())
        .addColumn("input_fingerprint", "varchar(128)", (column) => column.notNull())
        .addColumn("decisions", "jsonb", (column) => column.notNull())
        .addColumn("awards", "jsonb", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("confirmed_at", "timestamptz")
        .addColumn("unlocked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("stage_result_status_check", sql`status in ('confirmed', 'ready_to_confirm')`)
        .addCheckConstraint(
          "stage_result_revision_check",
          sql`candidate_revision >= 1 and source_candidate_revision >= 1`,
        )
        .addUniqueConstraint("stage_result_activity_stage_key", ["activity_id", "stage_key"])
        .addUniqueConstraint("stage_result_activity_id_key", ["activity_id", "id"])
        .execute();

      await db.schema
        .createTable("result_publication")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("stage_key", "varchar(100)", (column) => column.notNull())
        .addColumn("title", "varchar(300)", (column) => column.notNull())
        .addColumn("content", "text", (column) => column.notNull())
        .addColumn("version", "integer", (column) => column.notNull().defaultTo(1))
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("result_publication_version_check", sql`version >= 1`)
        .addUniqueConstraint("result_publication_activity_stage_key", ["activity_id", "stage_key"])
        .addUniqueConstraint("result_publication_activity_id_key", ["activity_id", "id"])
        .execute();

      await db.schema
        .createTable("result_release")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("publication_id", "varchar(100)", (column) => column.notNull())
        .addColumn("stage_result_id", "varchar(100)", (column) => column.notNull())
        .addColumn("stage_key", "varchar(100)", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("snapshot", "jsonb", (column) => column.notNull())
        .addColumn("snapshot_candidate_revision", "integer", (column) => column.notNull())
        .addColumn("result_version", "integer", (column) => column.notNull())
        .addColumn("post_version", "integer", (column) => column.notNull())
        .addColumn("input_fingerprint", "varchar(128)", (column) => column.notNull())
        .addColumn("note", "text", (column) => column.notNull())
        .addColumn("released_at", "timestamptz", (column) => column.notNull())
        .addColumn("revoked_at", "timestamptz")
        .addColumn("superseded_at", "timestamptz")
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint(
          "result_release_status_check",
          sql`status in ('active', 'revoked', 'superseded')`,
        )
        .execute();

      await sql`
        alter table result_release
          add constraint result_release_publication_activity_fk
            foreign key (activity_id, publication_id)
            references result_publication (activity_id, id)
            on delete restrict,
          add constraint result_release_stage_result_activity_fk
            foreign key (activity_id, stage_result_id)
            references stage_result (activity_id, id)
            on delete restrict
      `.execute(db);
      await sql`
        create unique index result_release_active_key
          on result_release (activity_id, stage_key)
          where status = 'active'
      `.execute(db);
      await sql`
        create index result_release_history_idx
          on result_release (activity_id, stage_key, released_at)
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`drop index if exists result_release_history_idx`.execute(db);
      await sql`drop index if exists result_release_active_key`.execute(db);
      await db.schema.dropTable("result_release").ifExists().execute();
      await db.schema.dropTable("result_publication").ifExists().execute();
      await db.schema.dropTable("stage_result").ifExists().execute();
    },
  },
```

- [ ] **Step 5: Type the podium placements**

In `plus/packages/db/src/score-repository.ts`, add before `StoredPodiumCandidate`:

```ts
export interface StoredPodiumPlacement {
  readonly place: number;
  readonly contestantId: string;
  readonly total: string;
}
```

Change the `placements` field of `StoredPodiumCandidate` to:

```ts
  readonly placements: readonly StoredPodiumPlacement[];
```

Change the mapper in `function podium(...)` to:

```ts
    placements: arrayValue(row.placements) as StoredPodiumPlacement[],
```

No behavior change; `tsc` now verifies the shape used by publishing.

- [ ] **Step 6: Run the migration tests**

```powershell
pnpm -C plus/packages/db exec vitest run test/migrations.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Type-check the workspace**

```powershell
pnpm -C plus run check
```

Expected: PASS. If `insertPodiumCandidate` call sites now fail, the error means their fixture placements are malformed; fix the fixture, not the type.

- [ ] **Step 8: Commit**

```powershell
git add plus/packages/db
git commit -m "feat: add publishing persistence schema"
```

---

### Task 3: Publishing repository and public selector

**Files:**
- Create: `plus/packages/db/src/publishing-repository.ts`
- Modify: `plus/packages/db/src/index.ts`
- Test: `plus/packages/db/test/publishing-repository.test.ts`

- [ ] **Step 1: Write the failing repository test**

Create `plus/packages/db/test/publishing-repository.test.ts`:

```ts
import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  insertResultPublication,
  insertResultRelease,
  insertStageResult,
  listResultReleases,
  migrate,
  selectPublicResults,
  updateResultReleaseStatus,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_publishing_repository_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const decisions = [
  { rank: 1, contestantId: "singer-a", score: "98.30" },
  { rank: 2, contestantId: "singer-b", score: "97.80" },
];
const awards = [{ award: "冠军", contestantId: "singer-a" }];
const snapshot = {
  activityTitle: "2026 院十佳",
  publicTitle: "2026 院十佳 · 正式赛果",
  stageKey: "final_podium",
  decisions,
  awards,
};

async function seed(activityId: string, publicCode: string): Promise<void> {
  await db
    .insertInto("activity")
    .values({
      id: activityId,
      public_code: publicCode,
      title: "2026 院十佳",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify([]),
      active_definition_version: 1,
    })
    .execute();
  await insertStageResult(db, {
    id: `stage-${activityId}`,
    activityId,
    stageKey: "final_podium",
    status: "confirmed",
    candidateRevision: 3,
    sourceCandidateRevision: 3,
    inputFingerprint: "fp-1",
    decisions,
    awards,
    revision: 1,
    confirmedAt: "2026-10-19T17:00:00.000Z",
  });
  await insertResultPublication(db, {
    id: `publication-${activityId}`,
    activityId,
    stageKey: "final_podium",
    title: "正式赛果",
    content: "编辑正文",
    version: 1,
    revision: 0,
  });
}

async function release(activityId: string, releaseId: string): Promise<void> {
  await insertResultRelease(db, {
    id: releaseId,
    activityId,
    publicationId: `publication-${activityId}`,
    stageResultId: `stage-${activityId}`,
    stageKey: "final_podium",
    status: "active",
    snapshot,
    snapshotCandidateRevision: 3,
    resultVersion: 3,
    postVersion: 1,
    inputFingerprint: "fp-1",
    note: "正式发布",
    releasedAt: "2026-10-19T18:00:00.000Z",
    revision: 0,
  });
}

describe.skipIf(!connectionString)("publishing repository", () => {
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

  it("allows only one active release per activity and stage", async () => {
    const activityId = `act-${randomUUID()}`;
    await seed(activityId, activityId);
    await release(activityId, `release-a-${activityId}`);
    await expect(release(activityId, `release-b-${activityId}`)).rejects.toThrow(/result_release_active_key/);
  });

  it("keeps release history and returns only active snapshots publicly", async () => {
    const activityId = `act-${randomUUID()}`;
    const publicCode = `CODE${activityId.slice(-6).toUpperCase()}`;
    await seed(activityId, publicCode);
    await release(activityId, `release-1-${activityId}`);
    expect(await selectPublicResults(db, publicCode)).toMatchObject({
      activity: { publicCode },
      activityTitle: "2026 院十佳",
      results: [{ stageKey: "final_podium", publicTitle: "2026 院十佳 · 正式赛果", decisions }],
    });
    expect(JSON.stringify(await selectPublicResults(db, publicCode))).not.toContain("fp-1");
    await updateResultReleaseStatus(db, {
      id: `release-1-${activityId}`,
      activityId,
      status: "revoked",
      revokedAt: "2026-10-19T19:00:00.000Z",
      supersededAt: null,
      revision: 1,
    });
    expect((await selectPublicResults(db, publicCode))?.results).toEqual([]);
    expect(await listResultReleases(db, activityId, "final_podium")).toHaveLength(1);
    expect(await selectPublicResults(db, "UNKNOWN-CODE")).toBeNull();
  });

  it("keeps activities isolated", async () => {
    const first = `act-${randomUUID()}`;
    const second = `act-${randomUUID()}`;
    await seed(first, `A${first.slice(-6).toUpperCase()}`);
    await seed(second, `B${second.slice(-6).toUpperCase()}`);
    await release(first, `release-first-${first}`);
    expect(await selectPublicResults(db, `A${first.slice(-6).toUpperCase()}`)).not.toBeNull();
    const other = await selectPublicResults(db, `B${second.slice(-6).toUpperCase()}`);
    expect(other?.results).toEqual([]);
    const cross = await sql<{ count: string }>`
      select count(*)::text as count from result_release where activity_id = ${second}
    `.execute(db);
    expect(cross.rows[0]?.count).toBe("0");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
pnpm -C plus/packages/db exec vitest run test/publishing-repository.test.ts
```

Expected: FAIL — `publishing-repository` exports do not exist.

- [ ] **Step 3: Implement the repository**

Create `plus/packages/db/src/publishing-repository.ts`:

```ts
import type {
  ResultAward,
  ResultDecision,
  ResultSnapshot,
} from "@artflow-plus/domain";
import type { Kysely, Selectable } from "kysely";

import type {
  Database,
  ResultPublicationRow,
  ResultReleaseRow,
  StageResultRow,
} from "./types.js";

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function json(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

export interface StoredStageResult {
  readonly id: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly status: "confirmed" | "ready_to_confirm";
  readonly candidateRevision: number;
  readonly sourceCandidateRevision: number;
  readonly inputFingerprint: string;
  readonly decisions: readonly ResultDecision[];
  readonly awards: readonly ResultAward[];
  readonly revision: number;
  readonly confirmedAt?: string;
  readonly unlockedAt?: string;
}

function stageResult(row: Selectable<StageResultRow>): StoredStageResult {
  const confirmedAt = iso(row.confirmed_at);
  const unlockedAt = iso(row.unlocked_at);
  return {
    id: row.id,
    activityId: row.activity_id,
    stageKey: row.stage_key,
    status: row.status as StoredStageResult["status"],
    candidateRevision: row.candidate_revision,
    sourceCandidateRevision: row.source_candidate_revision,
    inputFingerprint: row.input_fingerprint,
    decisions: json(row.decisions) as ResultDecision[],
    awards: json(row.awards) as ResultAward[],
    revision: row.revision,
    ...(confirmedAt === null ? {} : { confirmedAt }),
    ...(unlockedAt === null ? {} : { unlockedAt }),
  };
}

export async function getStageResult(
  db: Kysely<Database>,
  activityId: string,
  stageKey: string,
): Promise<StoredStageResult | null> {
  const row = await db.selectFrom("stage_result").selectAll()
    .where("activity_id", "=", activityId)
    .where("stage_key", "=", stageKey)
    .executeTakeFirst();
  return row === undefined ? null : stageResult(row);
}

export async function getStageResultForUpdate(
  db: Kysely<Database>,
  activityId: string,
  stageKey: string,
): Promise<StoredStageResult | null> {
  const row = await db.selectFrom("stage_result").selectAll()
    .where("activity_id", "=", activityId)
    .where("stage_key", "=", stageKey)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : stageResult(row);
}

export async function listStageResults(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredStageResult[]> {
  const rows = await db.selectFrom("stage_result").selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("stage_key", "asc")
    .execute();
  return rows.map(stageResult);
}

export async function insertStageResult(
  db: Kysely<Database>,
  value: StoredStageResult,
): Promise<void> {
  await db.insertInto("stage_result").values({
    id: value.id,
    activity_id: value.activityId,
    stage_key: value.stageKey,
    status: value.status,
    candidate_revision: value.candidateRevision,
    source_candidate_revision: value.sourceCandidateRevision,
    input_fingerprint: value.inputFingerprint,
    decisions: JSON.stringify(value.decisions),
    awards: JSON.stringify(value.awards),
    revision: value.revision,
    confirmed_at: value.confirmedAt ?? null,
    unlocked_at: value.unlockedAt ?? null,
  }).execute();
}

export async function updateStageResult(
  db: Kysely<Database>,
  value: StoredStageResult,
): Promise<void> {
  await db.updateTable("stage_result").set({
    status: value.status,
    candidate_revision: value.candidateRevision,
    source_candidate_revision: value.sourceCandidateRevision,
    input_fingerprint: value.inputFingerprint,
    decisions: JSON.stringify(value.decisions),
    awards: JSON.stringify(value.awards),
    revision: value.revision,
    confirmed_at: value.confirmedAt ?? null,
    unlocked_at: value.unlockedAt ?? null,
    updated_at: new Date(),
  }).where("id", "=", value.id).execute();
}

export interface StoredResultPublication {
  readonly id: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly title: string;
  readonly content: string;
  readonly version: number;
  readonly revision: number;
}

function publication(row: Selectable<ResultPublicationRow>): StoredResultPublication {
  return {
    id: row.id,
    activityId: row.activity_id,
    stageKey: row.stage_key,
    title: row.title,
    content: row.content,
    version: row.version,
    revision: row.revision,
  };
}

export async function getResultPublication(
  db: Kysely<Database>,
  activityId: string,
  stageKey: string,
): Promise<StoredResultPublication | null> {
  const row = await db.selectFrom("result_publication").selectAll()
    .where("activity_id", "=", activityId)
    .where("stage_key", "=", stageKey)
    .executeTakeFirst();
  return row === undefined ? null : publication(row);
}

export async function getResultPublicationForUpdate(
  db: Kysely<Database>,
  activityId: string,
  stageKey: string,
): Promise<StoredResultPublication | null> {
  const row = await db.selectFrom("result_publication").selectAll()
    .where("activity_id", "=", activityId)
    .where("stage_key", "=", stageKey)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : publication(row);
}

export async function listResultPublications(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredResultPublication[]> {
  const rows = await db.selectFrom("result_publication").selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("stage_key", "asc")
    .execute();
  return rows.map(publication);
}

export async function insertResultPublication(
  db: Kysely<Database>,
  value: StoredResultPublication,
): Promise<void> {
  await db.insertInto("result_publication").values({
    id: value.id,
    activity_id: value.activityId,
    stage_key: value.stageKey,
    title: value.title,
    content: value.content,
    version: value.version,
    revision: value.revision,
  }).execute();
}

export async function updateResultPublication(
  db: Kysely<Database>,
  value: StoredResultPublication,
): Promise<void> {
  await db.updateTable("result_publication").set({
    title: value.title,
    content: value.content,
    version: value.version,
    revision: value.revision,
    updated_at: new Date(),
  }).where("id", "=", value.id).execute();
}

export interface StoredResultRelease {
  readonly id: string;
  readonly activityId: string;
  readonly publicationId: string;
  readonly stageResultId: string;
  readonly stageKey: string;
  readonly status: "active" | "revoked" | "superseded";
  readonly snapshot: ResultSnapshot;
  readonly snapshotCandidateRevision: number;
  readonly resultVersion: number;
  readonly postVersion: number;
  readonly inputFingerprint: string;
  readonly note: string;
  readonly releasedAt: string;
  readonly revokedAt?: string;
  readonly supersededAt?: string;
  readonly revision: number;
}

function resultRelease(row: Selectable<ResultReleaseRow>): StoredResultRelease {
  const releasedAt = iso(row.released_at) ?? "";
  const revokedAt = iso(row.revoked_at);
  const supersededAt = iso(row.superseded_at);
  return {
    id: row.id,
    activityId: row.activity_id,
    publicationId: row.publication_id,
    stageResultId: row.stage_result_id,
    stageKey: row.stage_key,
    status: row.status as StoredResultRelease["status"],
    snapshot: json(row.snapshot) as ResultSnapshot,
    snapshotCandidateRevision: row.snapshot_candidate_revision,
    resultVersion: row.result_version,
    postVersion: row.post_version,
    inputFingerprint: row.input_fingerprint,
    note: row.note,
    releasedAt,
    ...(revokedAt === null ? {} : { revokedAt }),
    ...(supersededAt === null ? {} : { supersededAt }),
    revision: row.revision,
  };
}

export async function getActiveResultRelease(
  db: Kysely<Database>,
  activityId: string,
  stageKey: string,
): Promise<StoredResultRelease | null> {
  const row = await db.selectFrom("result_release").selectAll()
    .where("activity_id", "=", activityId)
    .where("stage_key", "=", stageKey)
    .where("status", "=", "active")
    .executeTakeFirst();
  return row === undefined ? null : resultRelease(row);
}

export async function getResultReleaseByIdForUpdate(
  db: Kysely<Database>,
  releaseId: string,
): Promise<StoredResultRelease | null> {
  const row = await db.selectFrom("result_release").selectAll()
    .where("id", "=", releaseId)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : resultRelease(row);
}

export async function listResultReleases(
  db: Kysely<Database>,
  activityId: string,
  stageKey?: string,
): Promise<readonly StoredResultRelease[]> {
  let query = db.selectFrom("result_release").selectAll().where("activity_id", "=", activityId);
  if (stageKey !== undefined) query = query.where("stage_key", "=", stageKey);
  const rows = await query.orderBy("released_at", "asc").orderBy("id", "asc").execute();
  return rows.map(resultRelease);
}

export async function insertResultRelease(
  db: Kysely<Database>,
  value: StoredResultRelease,
): Promise<void> {
  await db.insertInto("result_release").values({
    id: value.id,
    activity_id: value.activityId,
    publication_id: value.publicationId,
    stage_result_id: value.stageResultId,
    stage_key: value.stageKey,
    status: value.status,
    snapshot: JSON.stringify(value.snapshot),
    snapshot_candidate_revision: value.snapshotCandidateRevision,
    result_version: value.resultVersion,
    post_version: value.postVersion,
    input_fingerprint: value.inputFingerprint,
    note: value.note,
    released_at: value.releasedAt,
    revoked_at: value.revokedAt ?? null,
    superseded_at: value.supersededAt ?? null,
    revision: value.revision,
  }).execute();
}

export async function updateResultReleaseStatus(
  db: Kysely<Database>,
  value: {
    readonly id: string;
    readonly activityId: string;
    readonly status: "active" | "revoked" | "superseded";
    readonly revokedAt: string | null;
    readonly supersededAt: string | null;
    readonly revision: number;
  },
): Promise<void> {
  await db.updateTable("result_release").set({
    status: value.status,
    revoked_at: value.revokedAt,
    superseded_at: value.supersededAt,
    revision: value.revision,
  }).where("id", "=", value.id).where("activity_id", "=", value.activityId).execute();
}

export interface PublicResult {
  readonly releaseId: string;
  readonly stageKey: string;
  readonly publicTitle: string;
  readonly releasedAt: string;
  readonly decisions: readonly ResultDecision[];
  readonly awards: readonly ResultAward[];
}

export interface PublicResults {
  readonly activity: { readonly publicCode: string };
  readonly activityTitle: string;
  readonly results: readonly PublicResult[];
}

/** The single public selector: active snapshots only, never internal fields. */
export async function selectPublicResults(
  db: Kysely<Database>,
  publicCode: string,
  stageKey?: string,
): Promise<PublicResults | null> {
  const activity = await db.selectFrom("activity")
    .select(["id", "public_code"])
    .where("public_code", "=", publicCode)
    .executeTakeFirst();
  if (activity === undefined) return null;
  let query = db.selectFrom("result_release").selectAll()
    .where("activity_id", "=", activity.id)
    .where("status", "=", "active");
  if (stageKey !== undefined) query = query.where("stage_key", "=", stageKey);
  const rows = await query.orderBy("stage_key", "asc").orderBy("released_at", "desc").execute();
  const mapped = rows.map((row) => {
    const snapshot = json(row.snapshot) as ResultSnapshot;
    return {
      releaseId: row.id,
      stageKey: row.stage_key,
      publicTitle: snapshot.publicTitle,
      releasedAt: iso(row.released_at) ?? "",
      decisions: snapshot.decisions,
      awards: snapshot.awards,
    };
  });
  const newest = [...rows].sort((left, right) => {
    const leftAt = iso(left.released_at) ?? "";
    const rightAt = iso(right.released_at) ?? "";
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    return right.id.localeCompare(left.id);
  })[0];
  const activityTitle = newest === undefined
    ? ""
    : (json(newest.snapshot) as ResultSnapshot).activityTitle;
  return { activity: { publicCode: activity.public_code }, activityTitle, results: mapped };
}
```

- [ ] **Step 4: Export the repository**

In `plus/packages/db/src/index.ts`, add:

```ts
export * from "./publishing-repository.js";
```

- [ ] **Step 5: Run the repository tests**

```powershell
pnpm -C plus/packages/db exec vitest run test/publishing-repository.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Run the full db package serially**

```powershell
pnpm -C plus/packages/db run test
```

Expected: PASS, 29 tests.

- [ ] **Step 7: Commit**

```powershell
git add plus/packages/db
git commit -m "feat: add publishing repository and public selector"
```

---

### Task 4: Runtime confirm and staff state read

**Files:**
- Create: `plus/packages/runtime/src/publishing-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Test: `plus/packages/runtime/test/publishing-service.test.ts`

- [ ] **Step 1: Write the failing runtime test**

Create `plus/packages/runtime/test/publishing-service.test.ts` with the shared seeding helper and the confirm/state tests:

```ts
import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertPodiumCandidate, insertRelease, insertSession, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext, ExecutionSession } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { confirmStageResult, getPublishingState } from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_publishing_service_${Date.now()}_${process.pid}`;
const secret = "m7-test-secret";

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "m7-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["result.manage"],
};
const outsider: ActorContext = {
  actorId: "m7-outsider",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

function deps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    credentialSecret: secret,
    now: () => new Date(Date.UTC(2026, 9, 19, 18, 0, tick++)).toISOString(),
    newEventId: () => `m7-${randomUUID()}`,
  };
}

const placements = [
  { place: 1, contestantId: "singer-a", total: "98.30" },
  { place: 2, contestantId: "singer-b", total: "97.80" },
];

async function seedActivity(
  activityId = `act-${randomUUID()}`,
  publicCode = activityId,
  sourceRevision = 3,
  fingerprint = "fp-1",
): Promise<string> {
  await db.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title: "2026 院十佳",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition", "publishing"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "m7-release",
    capabilities: {
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: "publishing",
        artifact: {
          version: 1,
          schemaVersion: 1,
          stages: [{ key: "final_podium", label: "正式赛果" }],
        },
      },
    },
    executionPolicy: { declaredScopes: ["publishing"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-19T17:00:00Z",
    sourceDraftRevision: 1,
  });
  const session: ExecutionSession = {
    id: `publishing-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "m7-release",
    scope: "publishing",
    mode: "formal",
    status: "running",
    revision: 0,
  };
  await insertSession(db, session, "2026-10-19T17:00:00Z");
  await insertPodiumCandidate(db, {
    id: `podium-${activityId}`,
    activityId,
    inputFingerprint: fingerprint,
    status: "candidate",
    placements,
    sourceRoundIds: ["round-final"],
    sourceScoreVersions: [{ roundId: "round-final", sourceScoreVersion: 1 }],
    revision: sourceRevision,
  });
  return activityId;
}

describe.skipIf(!connectionString)("publishing service", () => {
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

  it("confirms the latest podium candidate and exposes the staff state", async () => {
    const activityId = await seedActivity();
    const confirmed = await confirmStageResult(db, deps(staff), {
      commandId: "m7-confirm-1",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [{ award: "冠军", contestantId: "singer-a" }],
      note: "核定",
    });
    expect(confirmed.body).toMatchObject({
      stageKey: "final_podium",
      status: "confirmed",
      candidateRevision: 3,
      sourceCandidateRevision: 3,
      inputFingerprint: "fp-1",
      decisions: [
        { rank: 1, contestantId: "singer-a", score: "98.30" },
        { rank: 2, contestantId: "singer-b", score: "97.80" },
      ],
      awards: [{ award: "冠军", contestantId: "singer-a" }],
    });
    const state = await getPublishingState(db, deps(staff), { activityId });
    expect(state.stageResults).toHaveLength(1);
    expect(state.stageResults[0]?.candidateRevision).toBe(3);
  });

  it("rejects stale candidates, bad awards, and missing permission", async () => {
    const activityId = await seedActivity();
    await expect(confirmStageResult(db, deps(staff), {
      commandId: "m7-stale",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 2,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "stale",
    })).rejects.toMatchObject({ code: "STALE_RESOLUTION_INPUT" });
    await expect(confirmStageResult(db, deps(staff), {
      commandId: "m7-bad-award",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [{ award: "冠军", contestantId: "singer-x" }],
      note: "bad award",
    })).rejects.toMatchObject({ code: "AWARD_INVALID" });
    await expect(confirmStageResult(db, deps(outsider), {
      commandId: "m7-forbidden",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "forbidden",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a held podium candidate", async () => {
    const activityId = await seedActivity("act-hold", "HOLD");
    await db.updateTable("podium_candidate").set({ status: "hold" }).where("activity_id", "=", activityId).execute();
    await expect(confirmStageResult(db, deps(staff), {
      commandId: "m7-hold-confirm",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "hold",
    })).rejects.toMatchObject({ code: "RESULT_CANDIDATE_HOLD" });
  });

  it("rejects a second confirm without an unlock", async () => {
    const activityId = await seedActivity();
    const input = {
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "confirm",
    };
    await confirmStageResult(db, deps(staff), { ...input, commandId: "m7-twice-1" });
    await expect(
      confirmStageResult(db, deps(staff), { ...input, commandId: "m7-twice-2" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
pnpm -C plus/packages/runtime exec vitest run test/publishing-service.test.ts
```

Expected: FAIL — `confirmStageResult` and `getPublishingState` are not exported.

- [ ] **Step 3: Implement the service (confirm and state)**

Create `plus/packages/runtime/src/publishing-service.ts`:

```ts
import type {
  Database,
  StoredPodiumCandidate,
  StoredResultPublication,
  StoredResultRelease,
  StoredStageResult,
} from "@artflow-plus/db";
import {
  findRunningSessionByScope,
  getActivityForUpdate,
  getLatestPodiumCandidate,
  getRelease,
  getStageResultForUpdate,
  insertStageResult,
  listResultPublications,
  listResultReleases,
  listStageResults,
  updateStageResult,
} from "@artflow-plus/db";
import {
  decodePublishingArtifact,
  DomainError,
  requirePermission,
  validateAwards,
} from "@artflow-plus/domain";
import type {
  CompiledPublishingArtifact,
  PublishingStageDefinition,
  ResultAward,
  ResultDecision,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand } from "./hash.js";

function requireActive(activity: { readonly status: string }, label: string): void {
  if (activity.status !== "active") {
    throw new DomainError("ACTIVITY_NOT_ACTIVE", `${label} requires an active activity.`);
  }
}

function requireCapability(
  activity: { readonly enabledCapabilities: readonly string[] },
  key: string,
): void {
  if (!activity.enabledCapabilities.includes(key)) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", `Capability ${key} is not enabled on this activity.`);
  }
}

async function publishingArtifact(
  trx: Kysely<Database>,
  activity: { readonly id: string },
  definitionVersion: number,
): Promise<CompiledPublishingArtifact> {
  const release = await getRelease(trx, activity.id, definitionVersion);
  if (release === null) {
    throw new DomainError("VERSION_NOT_RELEASED", "The activity has no active released definition.");
  }
  const plan = release.capabilities.publishing;
  if (plan === undefined || plan.ok !== true) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The release has no publishing snapshot.");
  }
  return decodePublishingArtifact(plan.artifact);
}

function requireStage(
  artifact: CompiledPublishingArtifact,
  stageKey: string,
): PublishingStageDefinition {
  const stage = artifact.stages.find((candidate) => candidate.key === stageKey);
  if (stage === undefined) {
    throw new DomainError("INVALID_INPUT", `Stage ${stageKey} is not declared in the released publishing definition.`);
  }
  return stage;
}

function decisionsFromCandidate(candidate: StoredPodiumCandidate): ResultDecision[] {
  return candidate.placements.map((placement) => {
    if (
      !Number.isInteger(placement.place) ||
      placement.place < 1 ||
      typeof placement.contestantId !== "string" ||
      !placement.contestantId.trim() ||
      typeof placement.total !== "string"
    ) {
      throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The podium candidate placements are malformed.");
    }
    return { rank: placement.place, contestantId: placement.contestantId, score: placement.total };
  });
}

export interface ConfirmStageResultInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly scope: string;
  readonly expectedSourceRevision: number;
  readonly expectedInputFingerprint: string;
  readonly awards: readonly ResultAward[];
  readonly note?: string;
}

export async function confirmStageResult(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ConfirmStageResultInput,
): Promise<CommandOutcome<StoredStageResult>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "publishing",
    commandType: "publishing.stage_result.confirm",
    scope: input.scope,
    actor,
    payload: {
      stageKey: input.stageKey,
      expectedSourceRevision: input.expectedSourceRevision,
      expectedInputFingerprint: input.expectedInputFingerprint,
      awards: input.awards,
      note: input.note ?? "",
    },
  }, async (trx) => {
    requirePermission(actor, "result.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity, "Publishing");
    requireCapability(activity, "publishing");
    const session = await findRunningSessionByScope(trx, activity.id, input.scope);
    if (session === null) {
      throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution.`);
    }
    const stage = requireStage(await publishingArtifact(trx, activity, session.definitionVersion), input.stageKey);
    const candidate = await getLatestPodiumCandidate(trx, activity.id);
    if (candidate === null) throw new DomainError("NOT_FOUND", "No podium candidate is available to confirm.");
    if (candidate.status !== "candidate") {
      throw new DomainError("RESULT_CANDIDATE_HOLD", "A held podium candidate cannot be confirmed.");
    }
    if (
      candidate.revision !== input.expectedSourceRevision ||
      candidate.inputFingerprint !== input.expectedInputFingerprint
    ) {
      throw new DomainError("STALE_RESOLUTION_INPUT", "The podium candidate changed since it was read.");
    }
    const decisions = decisionsFromCandidate(candidate);
    validateAwards(decisions, input.awards);
    const existing = await getStageResultForUpdate(trx, activity.id, stage.key);
    if (existing !== null && existing.status === "confirmed") {
      throw new DomainError("INVALID_TRANSITION", "Unlock the confirmed stage result before confirming it again.");
    }
    const candidateRevision = existing === null
      ? candidate.revision
      : Math.max(existing.candidateRevision + 1, candidate.revision);
    const stored: StoredStageResult = {
      id: existing?.id ?? idFromCommand("stage-result", `${activity.id}:${stage.key}`),
      activityId: activity.id,
      stageKey: stage.key,
      status: "confirmed",
      candidateRevision,
      sourceCandidateRevision: candidate.revision,
      inputFingerprint: candidate.inputFingerprint,
      decisions,
      awards: input.awards.map((award) => ({ award: award.award.trim(), contestantId: award.contestantId })),
      revision: (existing?.revision ?? 0) + 1,
      confirmedAt: deps.now(),
    };
    if (existing === null) await insertStageResult(trx, stored);
    else await updateStageResult(trx, stored);
    await appendEngineEvent(trx, deps, {
      type: "StageResultConfirmed",
      activityId: activity.id,
      aggregateType: "stage_result",
      aggregateId: stored.id,
      revision: stored.revision,
      capability: "publishing",
      mode: session.mode,
      scope: input.scope,
      payload: {
        stageKey: stored.stageKey,
        candidateRevision: stored.candidateRevision,
        sourceCandidateRevision: stored.sourceCandidateRevision,
        decisions: stored.decisions,
        awards: stored.awards,
      },
    });
    return { body: stored, status: existing === null ? 201 : 200 };
  });
}

export interface PublishingState {
  readonly stageResults: readonly StoredStageResult[];
  readonly publications: readonly StoredResultPublication[];
  readonly releases: readonly StoredResultRelease[];
}

export async function getPublishingState(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string },
): Promise<PublishingState> {
  requirePermission(runtimeActor(deps), "result.manage");
  const activity = await db.selectFrom("activity").select("id").where("id", "=", input.activityId).executeTakeFirst();
  if (activity === undefined) throw new DomainError("NOT_FOUND", "The activity was not found.");
  return {
    stageResults: await listStageResults(db, input.activityId),
    publications: await listResultPublications(db, input.activityId),
    releases: await listResultReleases(db, input.activityId),
  };
}
```

The import list above is exactly what Task 4 needs; Task 5 extends it explicitly.

- [ ] **Step 4: Export the service**

In `plus/packages/runtime/src/index.ts`, add:

```ts
export * from "./publishing-service.js";
```

- [ ] **Step 5: Run the runtime test**

```powershell
pnpm -C plus/packages/runtime exec vitest run test/publishing-service.test.ts
```

Expected: PASS, 4 tests. If `insertStageResult` is reported missing, the import list in Step 3 is incomplete; fix it there.

- [ ] **Step 6: Commit**

```powershell
git add plus/packages/runtime
git commit -m "feat: add publishing confirm and state service"
```

---

### Task 5: Runtime release, revoke, unlock, and publication edit

**Files:**
- Modify: `plus/packages/runtime/src/publishing-service.ts`
- Test: `plus/packages/runtime/test/publishing-service.test.ts`

- [ ] **Step 1: Add failing lifecycle tests**

Append these tests to `plus/packages/runtime/test/publishing-service.test.ts` (inside the `describe`):

```ts
  it("releases, freezes the publication, revokes, re-releases, and unlocks", async () => {
    const activityId = await seedActivity("act-lifecycle", "LIFECYCLE", 3, "fp-1");
    await confirmStageResult(db, deps(staff), {
      commandId: "m7-life-confirm",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [{ award: "冠军", contestantId: "singer-a" }],
      note: "核定",
    });
    const released = await releaseResult(db, deps(staff), {
      commandId: "m7-life-release-1",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "正式发布",
    });
    expect(released.body).toMatchObject({
      status: "active",
      stageKey: "final_podium",
      snapshotCandidateRevision: 3,
      resultVersion: 3,
    });
    await expect(editPublication(db, deps(staff), {
      commandId: "m7-life-edit-frozen",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedVersion: 1,
      title: "改后的标题",
      content: "正文",
    })).rejects.toMatchObject({ code: "RESULT_POST_FROZEN" });
    const revoked = await revokeResultRelease(db, deps(staff), {
      commandId: "m7-life-revoke",
      activityId,
      releaseId: released.body.id,
      scope: "publishing",
      note: "复核",
    });
    expect(revoked.body.status).toBe("revoked");
    await expect(revokeResultRelease(db, deps(staff), {
      commandId: "m7-life-revoke-again",
      activityId,
      releaseId: released.body.id,
      scope: "publishing",
      note: "again",
    })).rejects.toMatchObject({ code: "RESULT_RELEASE_NOT_ACTIVE" });
    expect((await getPublishingState(db, deps(staff), { activityId })).releases).toHaveLength(1);
    const reReleased = await releaseResult(db, deps(staff), {
      commandId: "m7-life-release-2",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "复核后重新发布",
    });
    expect(reReleased.body.status).toBe("active");
    expect((await getPublishingState(db, deps(staff), { activityId })).releases).toHaveLength(2);
    const unlocked = await unlockStageResult(db, deps(staff), {
      commandId: "m7-life-unlock",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "更正名次",
    });
    expect(unlocked.body).toMatchObject({ status: "ready_to_confirm", candidateRevision: 4 });
    const state = await getPublishingState(db, deps(staff), { activityId });
    expect(state.releases.map((release) => release.status)).toEqual(["revoked", "superseded"]);
  });

  it("rejects release before confirm and a second active release", async () => {
    const activityId = await seedActivity("act-release-guards", "GUARDS");
    await expect(releaseResult(db, deps(staff), {
      commandId: "m7-release-unconfirmed",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "not confirmed",
    })).rejects.toMatchObject({ code: "RESULT_NOT_CONFIRMED" });
    await confirmStageResult(db, deps(staff), {
      commandId: "m7-guard-confirm",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "confirm",
    });
    await releaseResult(db, deps(staff), {
      commandId: "m7-guard-release-1",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "release",
    });
    await expect(releaseResult(db, deps(staff), {
      commandId: "m7-guard-release-2",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "again",
    })).rejects.toMatchObject({ code: "RESULT_ALREADY_RELEASED" });
  });
```

Update the import line to include the new functions:

```ts
import {
  confirmStageResult,
  editPublication,
  getPublishingState,
  releaseResult,
  revokeResultRelease,
  unlockStageResult,
} from "../src/index.js";
```

- [ ] **Step 2: Run to verify it fails**

```powershell
pnpm -C plus/packages/runtime exec vitest run test/publishing-service.test.ts
```

Expected: FAIL — the four new exports do not exist.

- [ ] **Step 3: Extend the db imports**

Add these names to the `@artflow-plus/db` import list in
`plus/packages/runtime/src/publishing-service.ts`:

```ts
  getActiveResultRelease,
  getResultPublicationForUpdate,
  getResultReleaseByIdForUpdate,
  insertResultPublication,
  insertResultRelease,
  updateResultPublication,
  updateResultReleaseStatus,
```

Add `buildResultSnapshot` to the `@artflow-plus/domain` value import list:

- [ ] **Step 4: Implement release**

Append to `plus/packages/runtime/src/publishing-service.ts`:

```ts
export interface ReleaseResultInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly scope: string;
  readonly expectedCandidateRevision: number;
  readonly note: string;
}

export async function releaseResult(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ReleaseResultInput,
): Promise<CommandOutcome<StoredResultRelease>> {
  const actor = runtimeActor(deps);
  const note = input.note.trim();
  if (!note) throw new DomainError("INVALID_INPUT", "A release note is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "publishing",
    commandType: "publishing.result.release",
    scope: input.scope,
    actor,
    payload: { stageKey: input.stageKey, expectedCandidateRevision: input.expectedCandidateRevision, note },
  }, async (trx) => {
    requirePermission(actor, "result.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity, "Publishing");
    requireCapability(activity, "publishing");
    const session = await findRunningSessionByScope(trx, activity.id, input.scope);
    if (session === null) {
      throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution.`);
    }
    const stage = requireStage(await publishingArtifact(trx, activity, session.definitionVersion), input.stageKey);
    const stageResult = await getStageResultForUpdate(trx, activity.id, stage.key);
    if (stageResult === null) throw new DomainError("RESULT_NOT_CONFIRMED", "The stage result has not been confirmed.");
    if (stageResult.status !== "confirmed") {
      throw new DomainError("RESULT_NOT_CONFIRMED", "The stage result is unlocked and must be confirmed again.");
    }
    if (stageResult.candidateRevision !== input.expectedCandidateRevision) {
      throw new DomainError("STALE_REVISION", "The stage result changed since it was read.");
    }
    const active = await getActiveResultRelease(trx, activity.id, stage.key);
    if (active !== null) {
      throw new DomainError("RESULT_ALREADY_RELEASED", "Revoke the active release before publishing again.");
    }
    const snapshot = buildResultSnapshot({
      activityTitle: activity.title,
      stageKey: stage.key,
      stageLabel: stage.label,
      decisions: stageResult.decisions,
      awards: stageResult.awards,
    });
    let publication = await getResultPublicationForUpdate(trx, activity.id, stage.key);
    if (publication === null) {
      publication = {
        id: idFromCommand("result-publication", `${activity.id}:${stage.key}`),
        activityId: activity.id,
        stageKey: stage.key,
        title: snapshot.publicTitle,
        content: "",
        version: 1,
        revision: 0,
      };
      await insertResultPublication(trx, publication);
    }
    const stored: StoredResultRelease = {
      id: idFromCommand("result-release", input.commandId),
      activityId: activity.id,
      publicationId: publication.id,
      stageResultId: stageResult.id,
      stageKey: stage.key,
      status: "active",
      snapshot,
      snapshotCandidateRevision: stageResult.candidateRevision,
      resultVersion: stageResult.candidateRevision,
      postVersion: publication.version,
      inputFingerprint: stageResult.inputFingerprint,
      note,
      releasedAt: deps.now(),
      revision: 0,
    };
    await insertResultRelease(trx, stored);
    await appendEngineEvent(trx, deps, {
      type: "ResultReleased",
      activityId: activity.id,
      aggregateType: "result_release",
      aggregateId: stored.id,
      revision: stored.revision,
      capability: "publishing",
      mode: session.mode,
      scope: input.scope,
      payload: {
        releaseId: stored.id,
        stageKey: stored.stageKey,
        candidateRevision: stored.snapshotCandidateRevision,
        publicTitle: stored.snapshot.publicTitle,
      },
    });
    return { body: stored, status: 201 };
  });
}
```

The imports were extended in Step 3.

- [ ] **Step 5: Implement revoke**

Append:

```ts
export interface RevokeResultReleaseInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly releaseId: string;
  readonly scope: string;
  readonly note: string;
}

export async function revokeResultRelease(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: RevokeResultReleaseInput,
): Promise<CommandOutcome<StoredResultRelease>> {
  const actor = runtimeActor(deps);
  const note = input.note.trim();
  if (!note) throw new DomainError("INVALID_INPUT", "A revoke note is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "publishing",
    commandType: "publishing.result.revoke",
    scope: input.scope,
    actor,
    payload: { releaseId: input.releaseId, note },
  }, async (trx) => {
    requirePermission(actor, "result.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity, "Publishing");
    requireCapability(activity, "publishing");
    const session = await findRunningSessionByScope(trx, activity.id, input.scope);
    if (session === null) {
      throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution.`);
    }
    const release = await getResultReleaseByIdForUpdate(trx, input.releaseId);
    if (release === null || release.activityId !== activity.id) {
      throw new DomainError("NOT_FOUND", "The result release was not found.");
    }
    if (release.status !== "active") {
      throw new DomainError("RESULT_RELEASE_NOT_ACTIVE", "Only an active release can be revoked.");
    }
    const revokedAt = deps.now();
    await updateResultReleaseStatus(trx, {
      id: release.id,
      activityId: release.activityId,
      status: "revoked",
      revokedAt,
      supersededAt: null,
      revision: release.revision + 1,
    });
    const stored: StoredResultRelease = { ...release, status: "revoked", revokedAt, revision: release.revision + 1 };
    await appendEngineEvent(trx, deps, {
      type: "ResultReleaseRevoked",
      activityId: activity.id,
      aggregateType: "result_release",
      aggregateId: stored.id,
      revision: stored.revision,
      capability: "publishing",
      mode: session.mode,
      scope: input.scope,
      payload: { releaseId: stored.id, stageKey: stored.stageKey, note },
    });
    return { body: stored, status: 200 };
  });
}
```

The imports were extended in Step 3.

- [ ] **Step 6: Implement unlock**

Append:

```ts
export interface UnlockStageResultInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly scope: string;
  readonly expectedCandidateRevision: number;
  readonly note: string;
}

export async function unlockStageResult(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: UnlockStageResultInput,
): Promise<CommandOutcome<StoredStageResult>> {
  const actor = runtimeActor(deps);
  const note = input.note.trim();
  if (!note) throw new DomainError("INVALID_INPUT", "An unlock note is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "publishing",
    commandType: "publishing.stage_result.unlock",
    scope: input.scope,
    actor,
    payload: { stageKey: input.stageKey, expectedCandidateRevision: input.expectedCandidateRevision, note },
  }, async (trx) => {
    requirePermission(actor, "result.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity, "Publishing");
    requireCapability(activity, "publishing");
    const session = await findRunningSessionByScope(trx, activity.id, input.scope);
    if (session === null) {
      throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution.`);
    }
    const stage = requireStage(await publishingArtifact(trx, activity, session.definitionVersion), input.stageKey);
    const stageResult = await getStageResultForUpdate(trx, activity.id, stage.key);
    if (stageResult === null) throw new DomainError("RESULT_NOT_CONFIRMED", "The stage result has not been confirmed.");
    if (stageResult.status !== "confirmed") {
      throw new DomainError("INVALID_TRANSITION", "The stage result is already unlocked.");
    }
    if (stageResult.candidateRevision !== input.expectedCandidateRevision) {
      throw new DomainError("STALE_REVISION", "The stage result changed since it was read.");
    }
    const active = await getActiveResultRelease(trx, activity.id, stage.key);
    if (active !== null) {
      const supersededAt = deps.now();
      await updateResultReleaseStatus(trx, {
        id: active.id,
        activityId: active.activityId,
        status: "superseded",
        revokedAt: null,
        supersededAt,
        revision: active.revision + 1,
      });
      await appendEngineEvent(trx, deps, {
        type: "ResultReleaseSuperseded",
        activityId: activity.id,
        aggregateType: "result_release",
        aggregateId: active.id,
        revision: active.revision + 1,
        capability: "publishing",
        mode: session.mode,
        scope: input.scope,
        payload: { releaseId: active.id, stageKey: active.stageKey },
      });
    }
    const unlocked: StoredStageResult = {
      ...stageResult,
      status: "ready_to_confirm",
      candidateRevision: stageResult.candidateRevision + 1,
      revision: stageResult.revision + 1,
      unlockedAt: deps.now(),
    };
    await updateStageResult(trx, unlocked);
    await appendEngineEvent(trx, deps, {
      type: "StageResultUnlocked",
      activityId: activity.id,
      aggregateType: "stage_result",
      aggregateId: unlocked.id,
      revision: unlocked.revision,
      capability: "publishing",
      mode: session.mode,
      scope: input.scope,
      payload: { stageKey: unlocked.stageKey, candidateRevision: unlocked.candidateRevision, note },
    });
    return { body: unlocked, status: 200 };
  });
}
```

- [ ] **Step 7: Implement publication edit**

Append:

```ts
export interface EditPublicationInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly scope: string;
  readonly expectedVersion: number;
  readonly title: string;
  readonly content: string;
}

export async function editPublication(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: EditPublicationInput,
): Promise<CommandOutcome<StoredResultPublication>> {
  const actor = runtimeActor(deps);
  const title = input.title.trim();
  if (!title) throw new DomainError("INVALID_INPUT", "A publication title is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "publishing",
    commandType: "publishing.publication.edit",
    scope: input.scope,
    actor,
    payload: {
      stageKey: input.stageKey,
      expectedVersion: input.expectedVersion,
      title,
      content: input.content,
    },
  }, async (trx) => {
    requirePermission(actor, "result.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity, "Publishing");
    requireCapability(activity, "publishing");
    const session = await findRunningSessionByScope(trx, activity.id, input.scope);
    if (session === null) {
      throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution.`);
    }
    const stage = requireStage(await publishingArtifact(trx, activity, session.definitionVersion), input.stageKey);
    if ((await getActiveResultRelease(trx, activity.id, stage.key)) !== null) {
      throw new DomainError("RESULT_POST_FROZEN", "An active result release freezes the publication.");
    }
    const existing = await getResultPublicationForUpdate(trx, activity.id, stage.key);
    if (existing === null) {
      if (input.expectedVersion !== 0) {
        throw new DomainError("STALE_REVISION", "A missing publication has version 0.");
      }
      const created: StoredResultPublication = {
        id: idFromCommand("result-publication", `${activity.id}:${stage.key}`),
        activityId: activity.id,
        stageKey: stage.key,
        title,
        content: input.content,
        version: 1,
        revision: 0,
      };
      await insertResultPublication(trx, created);
      await appendEngineEvent(trx, deps, {
        type: "ResultPublicationEdited",
        activityId: activity.id,
        aggregateType: "result_publication",
        aggregateId: created.id,
        revision: created.revision,
        capability: "publishing",
        mode: session.mode,
        scope: input.scope,
        payload: { publicationId: created.id, stageKey: created.stageKey, version: created.version },
      });
      return { body: created, status: 201 };
    }
    if (existing.version !== input.expectedVersion) {
      throw new DomainError("STALE_REVISION", "The publication changed since it was read.");
    }
    const updated: StoredResultPublication = {
      ...existing,
      title,
      content: input.content,
      version: existing.version + 1,
      revision: existing.revision + 1,
    };
    await updateResultPublication(trx, updated);
    await appendEngineEvent(trx, deps, {
      type: "ResultPublicationEdited",
      activityId: activity.id,
      aggregateType: "result_publication",
      aggregateId: updated.id,
      revision: updated.revision,
      capability: "publishing",
      mode: session.mode,
      scope: input.scope,
      payload: { publicationId: updated.id, stageKey: updated.stageKey, version: updated.version },
    });
    return { body: updated, status: 200 };
  });
}
```

The imports were extended in Step 3.

- [ ] **Step 8: Run the lifecycle tests**

```powershell
pnpm -C plus/packages/runtime exec vitest run test/publishing-service.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```powershell
git add plus/packages/runtime
git commit -m "feat: add publishing release lifecycle commands"
```

---

### Task 6: Concurrency and audit evidence

**Files:**
- Modify: `plus/packages/runtime/test/publishing-service.test.ts`

- [ ] **Step 1: Add the two-connection release race test**

Append inside the `describe`:

```ts
  it("serializes two concurrent releases on the same stage through the Activity lock", async () => {
    const activityId = await seedActivity("act-release-race", "RACE");
    await confirmStageResult(db, deps(staff), {
      commandId: "m7-race-confirm",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "confirm",
    });
    const other = createDb({ connectionString: connectionString ?? "", schema });
    try {
      const results = await Promise.allSettled([
        releaseResult(db, deps(staff), {
          commandId: "m7-race-a",
          activityId,
          stageKey: "final_podium",
          scope: "publishing",
          expectedCandidateRevision: 3,
          note: "a",
        }),
        releaseResult(other, deps({ ...staff, actorId: "m7-staff-b" }), {
          commandId: "m7-race-b",
          activityId,
          stageKey: "final_podium",
          scope: "publishing",
          expectedCandidateRevision: 3,
          note: "b",
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        results
          .filter((result) => result.status === "rejected")
          .map((result) => (result as PromiseRejectedResult).reason.code),
      ).toContain("RESULT_ALREADY_RELEASED");
    } finally {
      await closeDb(other);
    }
  });

  it("writes audit and outbox facts for every accepted lifecycle command", async () => {
    const activityId = await seedActivity("act-audit", "AUDIT");
    await confirmStageResult(db, deps(staff), {
      commandId: "m7-audit-confirm",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-1",
      awards: [],
      note: "confirm",
    });
    const released = await releaseResult(db, deps(staff), {
      commandId: "m7-audit-release",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "release",
    });
    await revokeResultRelease(db, deps(staff), {
      commandId: "m7-audit-revoke",
      activityId,
      releaseId: released.body.id,
      scope: "publishing",
      note: "revoke",
    });
    const audits = await db.selectFrom("audit_entry").select(["command_id"]).where("activity_id", "=", activityId).execute();
    expect(audits.map((row) => row.command_id)).toEqual(
      expect.arrayContaining(["m7-audit-confirm", "m7-audit-release", "m7-audit-revoke"]),
    );
    const events = await readEventsSince(db, { activityId, after: 0, limit: 100 });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["StageResultConfirmed", "ResultReleased", "ResultReleaseRevoked"]),
    );
  });
```

Add `readEventsSince` to the db import and `createDb`, `closeDb` are already imported.

- [ ] **Step 2: Run the tests**

```powershell
pnpm -C plus/packages/runtime exec vitest run test/publishing-service.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 3: Commit**

```powershell
git add plus/packages/runtime
git commit -m "test: cover publishing concurrency and audit"
```

---

### Task 7: Contracts and HTTP routes

**Files:**
- Create: `plus/packages/contracts/src/publishing.ts`
- Modify: `plus/packages/contracts/src/index.ts`
- Modify: `plus/apps/api/src/app.ts`
- Test: `plus/apps/api/test/publishing.test.ts`

- [ ] **Step 1: Add the contract schemas**

Create `plus/packages/contracts/src/publishing.ts`:

```ts
import { Type, type Static } from "@sinclair/typebox";

const ScopeSchema = Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 100 });
const StageKeySchema = Type.String({ minLength: 1, maxLength: 100 });

export const PublishingStageParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1 }), stageKey: StageKeySchema },
  { additionalProperties: false },
);

export const PublishingReleaseParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1 }), releaseId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const PublicResultsParamsSchema = Type.Object(
  { publicCode: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

export const PublicResultsQuerySchema = Type.Object(
  { stage: Type.Optional(StageKeySchema) },
  { additionalProperties: false },
);

const AwardSchema = Type.Object(
  {
    award: Type.String({ minLength: 1, maxLength: 100 }),
    contestantId: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);

export const ConfirmStageResultBodySchema = Type.Object(
  {
    scope: ScopeSchema,
    expectedSourceRevision: Type.Integer({ minimum: 1 }),
    expectedInputFingerprint: Type.String({ minLength: 1, maxLength: 128 }),
    awards: Type.Array(AwardSchema, { maxItems: 50 }),
    note: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);

export const ReleaseResultBodySchema = Type.Object(
  {
    stageKey: StageKeySchema,
    scope: ScopeSchema,
    expectedCandidateRevision: Type.Integer({ minimum: 1 }),
    note: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const RevokeResultReleaseBodySchema = Type.Object(
  { scope: ScopeSchema, note: Type.String({ minLength: 1, maxLength: 2000 }) },
  { additionalProperties: false },
);

export const UnlockStageResultBodySchema = Type.Object(
  {
    scope: ScopeSchema,
    expectedCandidateRevision: Type.Integer({ minimum: 1 }),
    note: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const EditPublicationBodySchema = Type.Object(
  {
    scope: ScopeSchema,
    expectedVersion: Type.Integer({ minimum: 0 }),
    title: Type.String({ minLength: 1, maxLength: 300 }),
    content: Type.String({ maxLength: 20000 }),
  },
  { additionalProperties: false },
);

export type ConfirmStageResultBody = Static<typeof ConfirmStageResultBodySchema>;
export type ReleaseResultBody = Static<typeof ReleaseResultBodySchema>;
export type RevokeResultReleaseBody = Static<typeof RevokeResultReleaseBodySchema>;
export type UnlockStageResultBody = Static<typeof UnlockStageResultBodySchema>;
export type EditPublicationBody = Static<typeof EditPublicationBodySchema>;
export type PublicResultsQuery = Static<typeof PublicResultsQuerySchema>;
```

- [ ] **Step 2: Export the schemas**

In `plus/packages/contracts/src/index.ts`, add:

```ts
export * from "./publishing.js";
```

- [ ] **Step 3: Register HTTP statuses**

In `plus/apps/api/src/app.ts`, add to `STATUS_BY_CODE` before `RATE_LIMITED`:

```ts
  RESULT_POST_FROZEN: 409,
  RESULT_ALREADY_RELEASED: 409,
  RESULT_RELEASE_NOT_ACTIVE: 409,
  RESULT_NOT_CONFIRMED: 409,
  RESULT_CANDIDATE_HOLD: 409,
  AWARD_INVALID: 422,
```

- [ ] **Step 4: Import the contracts and runtime functions**

Add to the `@artflow-plus/contracts` import block:

```ts
  ConfirmStageResultBodySchema,
  EditPublicationBodySchema,
  PublicResultsParamsSchema,
  PublicResultsQuerySchema,
  PublishingReleaseParamsSchema,
  PublishingStageParamsSchema,
  ReleaseResultBodySchema,
  RevokeResultReleaseBodySchema,
  UnlockStageResultBodySchema,
```

Add to the `@artflow-plus/runtime` import block:

```ts
  confirmStageResult,
  editPublication,
  getPublishingState,
  releaseResult,
  revokeResultRelease,
  unlockStageResult,
```

Add `selectPublicResults` to the `@artflow-plus/db` import.

- [ ] **Step 5: Add the seven routes**

Insert before `app.post("/api/activities/:id/tickets", ...)` in `plus/apps/api/src/app.ts`:

```ts
  app.post(
    "/api/activities/:id/publishing/stage-results/:stageKey/confirm",
    { schema: { params: PublishingStageParamsSchema, body: ConfirmStageResultBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageKey } = request.params as { id: string; stageKey: string };
      const body = request.body as {
        scope: string;
        expectedSourceRevision: number;
        expectedInputFingerprint: string;
        awards: { award: string; contestantId: string }[];
        note?: string;
      };
      const outcome = await confirmStageResult(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageKey,
        scope: body.scope,
        expectedSourceRevision: body.expectedSourceRevision,
        expectedInputFingerprint: body.expectedInputFingerprint,
        awards: body.awards,
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/publishing/stage-results/:stageKey/unlock",
    { schema: { params: PublishingStageParamsSchema, body: UnlockStageResultBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageKey } = request.params as { id: string; stageKey: string };
      const body = request.body as { scope: string; expectedCandidateRevision: number; note: string };
      const outcome = await unlockStageResult(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageKey,
        scope: body.scope,
        expectedCandidateRevision: body.expectedCandidateRevision,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/publishing/releases",
    { schema: { params: ActivityParams, body: ReleaseResultBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        stageKey: string;
        scope: string;
        expectedCandidateRevision: number;
        note: string;
      };
      const outcome = await releaseResult(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageKey: body.stageKey,
        scope: body.scope,
        expectedCandidateRevision: body.expectedCandidateRevision,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    "/api/activities/:id/publishing/releases/:releaseId/revoke",
    { schema: { params: PublishingReleaseParamsSchema, body: RevokeResultReleaseBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, releaseId } = request.params as { id: string; releaseId: string };
      const body = request.body as { scope: string; note: string };
      const outcome = await revokeResultRelease(db, await requestDeps(request), {
        commandId,
        activityId: id,
        releaseId,
        scope: body.scope,
        note: body.note,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    "/api/activities/:id/publishing/publications/:stageKey",
    { schema: { params: PublishingStageParamsSchema, body: EditPublicationBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, stageKey } = request.params as { id: string; stageKey: string };
      const body = request.body as {
        scope: string;
        expectedVersion: number;
        title: string;
        content: string;
      };
      const outcome = await editPublication(db, await requestDeps(request), {
        commandId,
        activityId: id,
        stageKey,
        scope: body.scope,
        expectedVersion: body.expectedVersion,
        title: body.title,
        content: body.content,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get(
    "/api/activities/:id/publishing/state",
    { schema: { params: ActivityParams } },
    async (request) => {
      const { id } = request.params as { id: string };
      return getPublishingState(db, await requestDeps(request), { activityId: id });
    },
  );

  app.get(
    "/api/public/results/:publicCode",
    { schema: { params: PublicResultsParamsSchema, querystring: PublicResultsQuerySchema } },
    async (request, reply) => {
      const { publicCode } = request.params as { publicCode: string };
      const query = request.query as { stage?: string };
      await requirePublicRateLimit(request, `public-results:${publicCode}`, 120);
      const results = await selectPublicResults(db, publicCode, query.stage);
      reply.header("cache-control", "no-store");
      if (results === null) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "The public results were not found." });
      }
      return results;
    },
  );
```

- [ ] **Step 6: Write the API test**

Create `plus/apps/api/test/publishing.test.ts`:

```ts
import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertPodiumCandidate, insertRelease, insertSession, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext, ExecutionSession } from "@artflow-plus/domain";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { RuntimeDeps } from "@artflow-plus/runtime";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_publishing_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;
let forbiddenApp: FastifyInstance;
let unauthenticatedApp: FastifyInstance;
let clock = 0;

const staff: ActorContext = {
  actorId: "api-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["result.manage"],
};
const outsider: ActorContext = {
  actorId: "api-outsider",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};
const deps: RuntimeDeps = {
  now: () => new Date(Date.UTC(2026, 9, 19, 18, 0, clock++)).toISOString(),
  newEventId: () => randomUUID(),
};

function headers(id = `cmd-${randomUUID()}`) {
  return { "idempotency-key": id, "content-type": "application/json" };
}

async function seed(activityId: string, publicCode: string): Promise<void> {
  await db.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title: "2026 院十佳",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition", "publishing"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "api-release",
    capabilities: {
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: "publishing",
        artifact: {
          version: 1,
          schemaVersion: 1,
          stages: [{ key: "final_podium", label: "正式赛果" }],
        },
      },
    },
    executionPolicy: { declaredScopes: ["publishing"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-19T17:00:00Z",
    sourceDraftRevision: 1,
  });
  const session: ExecutionSession = {
    id: `publishing-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "api-release",
    scope: "publishing",
    mode: "formal",
    status: "running",
    revision: 0,
  };
  await insertSession(db, session, "2026-10-19T17:00:00Z");
  await insertPodiumCandidate(db, {
    id: `podium-${activityId}`,
    activityId,
    inputFingerprint: "fp-api",
    status: "candidate",
    placements: [
      { place: 1, contestantId: "singer-a", total: "98.30" },
      { place: 2, contestantId: "singer-b", total: "97.80" },
    ],
    sourceRoundIds: ["round-final"],
    sourceScoreVersions: [{ roundId: "round-final", sourceScoreVersion: 1 }],
    revision: 3,
  });
}

async function confirm(activityId: string): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: `/api/activities/${activityId}/publishing/stage-results/final_podium/confirm`,
    headers: headers(`api-confirm-${activityId}`),
    payload: {
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-api",
      awards: [{ award: "冠军", contestantId: "singer-a" }],
      note: "confirm",
    },
  });
  expect(response.statusCode).toBe(201);
}

describe.skipIf(!connectionString)("publishing HTTP", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps, actor: staff });
    forbiddenApp = await buildApp({ db, deps, actor: outsider });
    unauthenticatedApp = await buildApp({ db, deps });
    await Promise.all([app.ready(), forbiddenApp.ready(), unauthenticatedApp.ready()]);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await Promise.all([app.close(), forbiddenApp.close(), unauthenticatedApp.close()]);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("releases and serves the anonymous selector without internal fields", async () => {
    const activityId = `act-${randomUUID()}`;
    await seed(activityId, "APICODE");
    await confirm(activityId);
    const released = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/publishing/releases`,
      headers: headers(`api-release-${activityId}`),
      payload: {
        stageKey: "final_podium",
        scope: "publishing",
        expectedCandidateRevision: 3,
        note: "release",
      },
    });
    expect(released.statusCode).toBe(201);
    const publicResponse = await unauthenticatedApp.inject({
      method: "GET",
      url: "/api/public/results/APICODE",
    });
    expect(publicResponse.statusCode).toBe(200);
    expect(publicResponse.headers["cache-control"]).toBe("no-store");
    expect(publicResponse.json()).toMatchObject({
      activity: { publicCode: "APICODE" },
      activityTitle: "2026 院十佳",
      results: [
        {
          stageKey: "final_podium",
          publicTitle: "2026 院十佳 · 正式赛果",
          decisions: [
            { rank: 1, contestantId: "singer-a", score: "98.30" },
            { rank: 2, contestantId: "singer-b", score: "97.80" },
          ],
          awards: [{ award: "冠军", contestantId: "singer-a" }],
        },
      ],
    });
    expect(publicResponse.body).not.toContain("fp-api");
    expect(publicResponse.body).not.toContain("input_fingerprint");
  });

  it("returns 404 for an unknown public code and 200 with an empty list for a missing stage", async () => {
    const missing = await unauthenticatedApp.inject({ method: "GET", url: "/api/public/results/NOPE" });
    expect(missing.statusCode).toBe(404);
    const activityId = `act-${randomUUID()}`;
    await seed(activityId, "EMPTYCODE");
    const empty = await unauthenticatedApp.inject({
      method: "GET",
      url: "/api/public/results/EMPTYCODE?stage=final_podium",
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().results).toEqual([]);
  });

  it("requires authentication and result.manage", async () => {
    const activityId = `act-${randomUUID()}`;
    await seed(activityId, "AUTHCODE");
    const unauthorized = await unauthenticatedApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/publishing/stage-results/final_podium/confirm`,
      headers: headers("api-unauth"),
      payload: {
        scope: "publishing",
        expectedSourceRevision: 3,
        expectedInputFingerprint: "fp-api",
        awards: [],
      },
    });
    expect(unauthorized.statusCode).toBe(401);
    const forbidden = await forbiddenApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/publishing/stage-results/final_podium/confirm`,
      headers: headers("api-forbidden"),
      payload: {
        scope: "publishing",
        expectedSourceRevision: 3,
        expectedInputFingerprint: "fp-api",
        awards: [],
      },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("returns 409 for a stale candidate revision", async () => {
    const activityId = `act-${randomUUID()}`;
    await seed(activityId, "STALECODE");
    const stale = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/publishing/stage-results/final_podium/confirm`,
      headers: headers("api-stale"),
      payload: {
        scope: "publishing",
        expectedSourceRevision: 2,
        expectedInputFingerprint: "fp-api",
        awards: [],
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("STALE_RESOLUTION_INPUT");
  });
});
```

- [ ] **Step 7: Run the API tests**

```powershell
pnpm -C plus/apps/api exec vitest run test/publishing.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 8: Type-check and run the whole workspace tests**

```powershell
pnpm -C plus run check
pnpm -C plus run test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add plus/packages/contracts plus/apps/api
git commit -m "feat: expose publishing HTTP commands and public results"
```

---

### Task 8: Golden adapter

**Files:**
- Create: `plus/packages/runtime/test/golden-result-release-lifecycle.test.ts`

- [ ] **Step 1: Write the golden adapter**

Create the file with the same seeding helper shape as Task 4 plus the five fixture steps:

```ts
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  closeDb,
  createDb,
  insertPodiumCandidate,
  insertRelease,
  insertSession,
  migrate,
  readEventsSince,
  selectPublicResults,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext, ExecutionSession } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  confirmStageResult,
  editPublication,
  getPublishingState,
  releaseResult,
  revokeResultRelease,
  unlockStageResult,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../../", "tests/golden/result-release-lifecycle.json"), "utf8"),
) as {
  readonly id: string;
  readonly invariants: readonly string[];
  readonly facts: {
    readonly stage_result: {
      readonly candidate_revision: number;
      readonly input_fingerprint: string;
      readonly decisions: readonly { rank: number; contestant: string; score: string }[];
      readonly awards: readonly { award: string; contestant: string }[];
    };
    readonly activity: { readonly title: string };
  };
  readonly steps: readonly {
    readonly command: string;
    readonly input: Record<string, unknown>;
    readonly expect: {
      readonly outcome: string;
      readonly reason?: string;
      readonly events?: readonly string[];
      readonly read_model?: Record<string, unknown>;
    };
  }[];
};
const schema = `artflow_golden_m7_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "fixture-admin",
  actorType: "user",
  roles: ["admin"],
  permissions: ["result.manage"],
};

function deps(): RuntimeDeps {
  return {
    actor: staff,
    now: () => new Date(Date.UTC(2026, 9, 19, 20, 0, tick++)).toISOString(),
    newEventId: () => `golden-m7-${randomUUID()}`,
  };
}

async function seed(): Promise<string> {
  const activityId = "act-2026";
  await db.insertInto("activity").values({
    id: activityId,
    public_code: "ABC123",
    title: fixture.facts.activity.title,
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition", "publishing"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "m7-release",
    capabilities: {
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: "publishing",
        artifact: { version: 1, schemaVersion: 1, stages: [{ key: "final_podium", label: "正式赛果" }] },
      },
    },
    executionPolicy: { declaredScopes: ["publishing"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-19T17:00:00Z",
    sourceDraftRevision: 1,
  });
  const session: ExecutionSession = {
    id: "execution-act-2026",
    activityId,
    definitionVersion: 1,
    contentHash: "m7-release",
    scope: "publishing",
    mode: "formal",
    status: "running",
    revision: 0,
  };
  await insertSession(db, session, "2026-10-19T17:00:00Z");
  await insertPodiumCandidate(db, {
    id: "podium-act-2026",
    activityId,
    inputFingerprint: fixture.facts.stage_result.input_fingerprint,
    status: "candidate",
    placements: fixture.facts.stage_result.decisions.map((decision) => ({
      place: decision.rank,
      contestantId: decision.contestant,
      total: decision.score,
    })),
    sourceRoundIds: ["round-final"],
    sourceScoreVersions: [{ roundId: "round-final", sourceScoreVersion: 1 }],
    revision: fixture.facts.stage_result.candidate_revision,
  });
  return activityId;
}

function step(index: number) {
  const value = fixture.steps[index];
  if (value === undefined) throw new Error(`Golden step ${index} is missing.`);
  return value;
}

describe.skipIf(!connectionString)("result-release-lifecycle golden", () => {
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

  it("consumes the fixture through real Plus commands", async () => {
    expect(fixture.id).toBe("result-release-lifecycle");
    expect(fixture.invariants).toEqual(expect.arrayContaining(["RES-01", "RES-02", "RES-03", "RES-04"]));
    const activityId = await seed();
    const facts = fixture.facts.stage_result;
    await confirmStageResult(db, deps(), {
      commandId: "golden-confirm",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: facts.candidate_revision,
      expectedInputFingerprint: facts.input_fingerprint,
      awards: facts.awards.map((award) => ({ award: award.award, contestantId: award.contestant })),
      note: "fixture confirm",
    });

    const releaseStep = step(0);
    const released = await releaseResult(db, deps(), {
      commandId: "golden-release-1",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: Number(releaseStep.input.expected_candidate_revision),
      note: String(releaseStep.input.note),
    });
    expect(releaseStep.expect.outcome).toBe("accepted");
    expect(released.body.snapshot).toMatchObject({
      publicTitle: "2026 院十佳 · 正式赛果",
    });
    expect(released.body.snapshot.decisions).toHaveLength(2);
    expect(released.body.inputFingerprint).toBe("fp-1");

    const editStep = step(1);
    await expect(editPublication(db, deps(), {
      commandId: "golden-edit",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedVersion: 1,
      title: String(editStep.input.editorial_title),
      content: "",
    })).rejects.toMatchObject({ code: editStep.expect.reason ?? "RESULT_POST_FROZEN" });
    expect((await getPublishingState(db, deps(), { activityId })).releases).toHaveLength(1);

    const revokeStep = step(2);
    const revoked = await revokeResultRelease(db, deps(), {
      commandId: "golden-revoke",
      activityId,
      releaseId: released.body.id,
      scope: "publishing",
      note: String(revokeStep.input.note),
    });
    expect(revoked.body.status).toBe("revoked");
    expect((await selectPublicResults(db, "ABC123"))?.results).toEqual([]);

    const reReleaseStep = step(3);
    const reReleased = await releaseResult(db, deps(), {
      commandId: "golden-release-2",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: Number(reReleaseStep.input.expected_candidate_revision),
      note: String(reReleaseStep.input.note),
    });
    expect(reReleased.body.status).toBe("active");
    expect((await getPublishingState(db, deps(), { activityId })).releases).toHaveLength(2);
    expect((await selectPublicResults(db, "ABC123"))?.results).toHaveLength(1);

    const unlockStep = step(4);
    const unlocked = await unlockStageResult(db, deps(), {
      commandId: "golden-unlock",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: Number(unlockStep.input.expected_candidate_revision),
      note: String(unlockStep.input.note),
    });
    expect(unlocked.body).toMatchObject({ status: "ready_to_confirm", candidateRevision: 4 });
    expect((await selectPublicResults(db, "ABC123"))?.results).toEqual([]);
    const events = (await readEventsSince(db, { activityId, after: 0, limit: 100 })).map((event) => event.type);
    expect(events).toEqual(
      expect.arrayContaining([
        "StageResultConfirmed",
        "ResultReleased",
        "ResultReleaseRevoked",
        "ResultReleaseSuperseded",
        "StageResultUnlocked",
      ]),
    );
  });
});
```

- [ ] **Step 2: Run the golden adapter**

```powershell
pnpm -C plus/packages/runtime exec vitest run test/golden-result-release-lifecycle.test.ts
```

Expected: PASS, 1 test.

- [ ] **Step 3: Commit**

```powershell
git add plus/packages/runtime/test/golden-result-release-lifecycle.test.ts
git commit -m "test: adapt result-release-lifecycle golden"
```

---

### Task 9: Documentation, ADR, and roadmap

**Files:**
- Create: `docs/architecture/adr/0014-publishing-ownership.md`
- Modify: `docs/artflow-plus/roadmap.md`
- Modify: `plus/README.md`
- Modify: `docs/domains/results.md`
- Modify: `docs/artflow-plus/review-checklist.md`

- [ ] **Step 1: Write ADR 0014**

Create `docs/architecture/adr/0014-publishing-ownership.md`:

```markdown
# ADR-0014: Publishing owns confirmation and release

- **Status**: accepted
- **Date**: 2026-10-26

## Decision

The `publishing` capability owns stage-result confirmation, unlock, the editorial
publication container, result releases, revocation, supersession, and the single
public results selector. `competition` keeps podium candidates as an upstream
read model; it does not own public result facts.

`unlock_stage_result` must write `StageResultUnlocked` and
`ResultReleaseSuperseded` in one transaction. Splitting confirmation and release
into two capabilities would require cross-capability immediate consistency, so
M7a deliberately keeps both under one owner.

The runtime reads the latest podium candidate inside the Activity-locked
transaction and passes its decisions to publishing. The HTTP client never
supplies ranking data; it supplies only the stage key and the expected source
revision/fingerprint.

## Alternatives rejected

- Extending `competition` with public release fields would mix internal
  evaluation with public facts and enlarge the competition surface.
- A separate `results` capability plus `publishing` would make the golden
  fixture's atomic unlock/supersede impossible without a new saga mechanism.
- Accepting decisions from the request body would let a caller forge the
  confirmed ranking.
```

- [ ] **Step 2: Update the roadmap**

In `docs/artflow-plus/roadmap.md`, replace the whole section from
`## M7 — Publishing / Results / Archive` through its `**出口**` paragraph with:

```markdown
## M7a — Publishing / Results（已完成，2026-10-26）

- `publishing` capability：核定、解锁、release snapshot、撤销/替代、唯一公开 selector。
- 公开出口 `GET /api/public/results/:publicCode`；staff 状态出口与五条写命令。
- `result-release-lifecycle` golden 已由 Plus adapter 消费。

**出口**：发布/撤销/再发布/解锁生命周期、公开 selector、并发与审计测试全绿。

## M7b — Archive（下一 slice）

- 归档包：冻结身份、历史、文件清单、保留。
- `archive-identity` golden；媒体出口回归；归档与在线一致。
```

- [ ] **Step 3: Update the Plus README**

In `plus/README.md`, under "Next slice", replace the M7 line with:

```markdown
1. M7b Archive: the permanent archive package, retention, and `archive-identity`.
   M7a publishing/results is complete.
```

Add a short section before "Current layout":

```markdown
M7a publishing/results exposes one authoritative selector and five commands:

```text
POST  /api/activities/:id/publishing/stage-results/:stageKey/confirm
POST  /api/activities/:id/publishing/stage-results/:stageKey/unlock
POST  /api/activities/:id/publishing/releases
POST  /api/activities/:id/publishing/releases/:releaseId/revoke
PATCH /api/activities/:id/publishing/publications/:stageKey
GET   /api/activities/:id/publishing/state
GET   /api/public/results/:publicCode
```

The public selector is anonymous and never returns fingerprints, hashes, actors,
notes, or editorial fields. The in-memory public rate limiter is a single-process
IP bucket; production multi-instance deployments need a shared limiter.
```

- [ ] **Step 4: Update the domain doc**

In `docs/domains/results.md`, append to `## Plus 要求`:

```markdown
- M7a 实现：`publishing` capability 同时拥有核定与发布；`StageResult`、`ResultPublication`、
  `ResultRelease` 在 `0012_m7_publishing`；公开 selector 唯一实现于
  `selectPublicResults`。
```

- [ ] **Step 5: Update the review checklist**

In `docs/artflow-plus/review-checklist.md`, append:

```markdown
- [ ] 结果发布是否只读 release snapshot，而不是 activity/post 编辑字段？
- [ ] 公开 selector 是否排除了 fingerprint、hash、actor、note 与编辑字段？
- [ ] 同一 stage 是否最多一条 ACTIVE release，且部分唯一索引真实存在？
- [ ] unlock 是否在同一事务里写 StageResultUnlocked 与 ResultReleaseSuperseded？
```

- [ ] **Step 6: Run the documentation check and structural gates**

```powershell
pwsh -NoProfile -File scripts/check_docs.ps1
uv run pytest tests/gates -q
```

Expected: PASS, 22 gate tests.

- [ ] **Step 7: Commit**

```powershell
git add docs/architecture/adr/0014-publishing-ownership.md docs/artflow-plus/roadmap.md plus/README.md docs/domains/results.md docs/artflow-plus/review-checklist.md
git commit -m "docs: record M7a publishing ownership and usage"
```

---

### Task 10: Full verification and integration

**Files:** none (verification only).

- [ ] **Step 1: Run the complete Plus gate against PostgreSQL**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus run check
pnpm -C plus run test
```

Expected: PASS. Every DB test runs; none are skipped.

- [ ] **Step 2: Run the Python gates**

```powershell
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
uv run python manage.py test tests.golden --noinput
uv run ruff check tests/gates tests/golden
```

Expected: all exit 0.

- [ ] **Step 3: Sweep configuration lists**

Check that the new files are covered by `pyrightconfig.json`, the ruff/mypy module
lists, `tsconfig*.json` include lists, Tailwind content globs, `.env` templates,
`.dockerignore`, and `dependabot.yml`. The new files are under already-included
`plus/` globs; if any list enumerates files explicitly, add the new files.

- [ ] **Step 4: Commit any remaining changes**

```powershell
git status --short
```

If anything remains, commit it with a focused message. The working tree must be
clean before integration.

- [ ] **Step 5: Merge into `artflow-plus` and push**

```powershell
git checkout artflow-plus
git merge --no-ff feat/plus-m7a-publishing -m "merge: M7a publishing and results"
git push origin artflow-plus
```

Expected: `origin/artflow-plus` advances; CI Gates runs.
