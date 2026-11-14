# M15.2 Tasks / Readiness Capability Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. ArtFlow's repository instructions prohibit subagents, so execution must remain inline in the current checkout.

**Goal:** Add an independent tasks capability whose versioned task facts and audited commands provide an aggregate readiness projection without mutating any source capability authority.

**Architecture:** The domain registry/compiler freezes task templates inside an Activity Definition Release. A DB-owned task_item table stores instances bound to that release version; runtime commands mutate only those rows through the existing receipt/activity-lock/task-lock/OCC/audit/outbox path. API and Ops consume a dedicated task read surface, while readiness is calculated from task rows and never becomes a second lifecycle gate.

**Tech Stack:** TypeScript 7, Node 24, Fastify 5, TypeBox, Kysely/PostgreSQL 18, React 19, TanStack Query, Vitest, existing realtime core, and the repository's PowerShell/pytest gates.

**Spec:** docs/artflow-plus/specs/2026-10-28-tasks-readiness-design.md

## Global Constraints

- Work only on artflow-plus, on the existing feat/m15-2-tasks-readiness branch; do not create a worktree or delegate work.
- tasks is optional; existing packs must not silently gain task instances or change the semantics of already released activities.
- A task may reference a source capability but must never write source capability tables or infer source completion automatically.
- Historical v1 imports create no task instances; adoption creates tasks only when a real Plus release includes tasks.
- Every accepted mutation uses the existing receipt → Activity lock → task lock → validation → fact → audit → outbox transaction.
- Every task mutation requires expectedRevision; stale revisions return STALE_REVISION with no state, audit, or outbox mutation.
- tasks.assign is the only first-slice assignment command and accepts a local actor or explicit null; role, shift, team, and resource assignment are not introduced.
- tasks.sync is idempotent and never overwrites an existing task's frozen template fields, assignment, due time, status, or reasons.
- GET routes must declare a read surface at boot; task reads never expose source-capability private rows, credentials, tokens, storage keys, answers, or review notes.
- Realtime is invalidation-only; feature code must not open a socket directly and HTTP remains the recovery authority.
- Do not run full Django tests or require a real activity rehearsal. Use Docker PostgreSQL for DB-backed Plus tests with REQUIRE_DB=1 and preserve source volumes.
- The M15.2 self-built checks in docs/artflow-plus/checks/2026-10-28-tasks-readiness-checks.md are acceptance gates, not descriptive notes.

---

## File Map

- Create plus/packages/domain/src/capabilities/tasks.ts: task definition payload, compiler, deterministic artifact, manifest, and capability metadata.
- Modify plus/packages/domain/src/defaults.ts, plus/packages/domain/src/index.ts, and plus/packages/domain/src/activity-packs.ts: register the capability and expose opt-in guided task templates without changing existing default answers.
- Create plus/packages/domain/test/tasks.test.ts: compiler, composition, freeze, and task-definition counterexamples.
- Modify plus/packages/domain/test/registry-packs.test.ts: prove the capability is registered, optional, and pack opt-in produces valid source references.
- Modify plus/packages/db/src/types.ts and plus/packages/db/src/migrations.ts: add TaskItemRow and the additive task_item schema.
- Create plus/packages/db/src/task-repository.ts: version-bound sync, row locking, task reads, mutation updates, and readiness aggregation.
- Create plus/packages/db/test/tasks-repository.test.ts: real PostgreSQL migration, sync uniqueness, row updates, and aggregate query evidence.
- Create plus/packages/runtime/src/tasks-service.ts: command handlers, state transitions, permission checks, release binding, and task/readiness DTOs.
- Create plus/packages/runtime/test/tasks-service.test.ts: runtime behavior and transaction assertions.
- Modify plus/packages/db/src/index.ts and plus/packages/runtime/src/index.ts: export the new repositories and service.
- Create plus/packages/contracts/src/tasks.ts; modify plus/packages/contracts/src/index.ts: shared params, bodies, task DTO, list, readiness, and error-safe response schemas.
- Modify plus/apps/api/src/app.ts; create plus/apps/api/test/tasks.test.ts: read-surface boot guard, GETs, POST commands, 403/404, schema validation, idempotency, and OCC.
- Create plus/apps/web/src/api/tasks.ts, plus/apps/web/src/components/ops/TasksCard.tsx, and their tests; modify plus/apps/web/src/routes/opsActivity.tsx, its test, and plus/apps/web/src/styles/global.css.
- Modify docs/artflow-plus/checks/2026-10-28-tasks-readiness-checks.md: replace planned markers with exact test/gate evidence after implementation.
- Modify docs/artflow-plus/roadmap.md, plus/README.md, and docs/artflow-plus/self-build-checklist.md: record the completed slice and self-built responsibility mapping.

## Task 1: Add the domain tasks capability and opt-in pack definitions

**Interfaces:**

    export type TaskStatus = "pending" | "in_progress" | "blocked" | "done";

    export interface TaskTemplate {
      readonly key: string;
      readonly title: string;
      readonly sourceCapability: string;
      readonly sourceKey: string;
      readonly required: boolean;
    }

    export interface TasksDefinition {
      readonly schemaVersion: 1;
      readonly templates: readonly TaskTemplate[];
    }

    export interface CompiledTasksArtifact {
      readonly schemaVersion: 1;
      readonly templates: readonly TaskTemplate[];
    }

    export function createTasksDefinition(
      templates?: readonly TaskTemplate[],
    ): CapabilityDefinition;
    export function compileTasksDefinition(
      definition: CapabilityDefinition,
    ): CapabilityCompileResult;
    export const tasksCapability: CapabilityRegistration;

- [ ] Step 1: Write the failing domain tests.

Add tests with these exact behavior names:

    it("rejects duplicate task template keys and empty source fields", () => {});
    it("rejects a task template whose source capability is not enabled", () => {});
    it("returns a deterministic deeply frozen tasks artifact", () => {});
    it("registers tasks as optional with ops and studio surfaces", () => {});
    it("opt-in pack answers create only source-valid task templates", () => {});

The composition test must instantiate SINGER_COMPETITION_PACK with answers:
{ tasks: true }, then assert that every template source is in
instantiation.enabledCapabilities; the default answer must remain false and must
not add tasks to existing pack output.

- [ ] Step 2: Run the focused tests and verify the expected red failure.

    pnpm -C plus --filter @artflow-plus/domain test -- tasks.test.ts registry-packs.test.ts

Expected failure: the tasks capability module and tasks pack question do not yet exist.

- [ ] Step 3: Implement the minimal domain capability.

Create capabilities/tasks.ts with bounded string validation, sorted template
normalization, capabilityDefinitionHash, deepFreeze, and
validateComposition({ enabledCapabilities, artifact }). Register exactly the
manifest values from the spec: identity tasks, version 1.0.0, no dependencies,
commands tasks.sync, tasks.assign, tasks.start, tasks.block, tasks.complete,
tasks.reopen, queries tasks.list and readiness.summary, event tasks.changed,
permission tasks.manage, surfaces ["ops", "studio"], and scopes: [].

Add tasks to createDefaultCapabilityRegistry and export it from the domain
index. Add a tasks guided question with default false to each existing product
pack. Supply source-valid templates only when the capability is opted in:
singer uses registration/material/competition/publishing/archive sources;
stage-show uses registration/material/archive; review-awards uses
registration/material/competition/publishing/archive; vote-poll uses
voting/publishing/archive.

- [ ] Step 4: Run the focused tests and verify green.

    pnpm -C plus --filter @artflow-plus/domain test -- tasks.test.ts registry-packs.test.ts
    pnpm -C plus --filter @artflow-plus/domain check

- [ ] Step 5: Commit the domain slice.

    git add plus/packages/domain/src/capabilities/tasks.ts plus/packages/domain/src/defaults.ts plus/packages/domain/src/index.ts plus/packages/domain/src/activity-packs.ts plus/packages/domain/test/tasks.test.ts plus/packages/domain/test/registry-packs.test.ts
    git commit -m "feat: register tasks capability"

## Task 2: Add the versioned task-item schema and repository

**Interfaces:**

    export type StoredTaskItem = {
      readonly id: string;
      readonly activityId: string;
      readonly definitionVersion: number;
      readonly templateKey: string;
      readonly title: string;
      readonly sourceCapability: string;
      readonly sourceKey: string;
      readonly required: boolean;
      readonly status: TaskStatus;
      readonly assigneeActorId: string | null;
      readonly dueAt: string | null;
      readonly blockedReason: string | null;
      readonly completionReason: string | null;
      readonly revision: number;
      readonly createdAt: string;
      readonly updatedAt: string;
    };

    export type TaskItemMutation = {
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly status: TaskStatus;
      readonly assigneeActorId: string | null;
      readonly dueAt: string | null;
      readonly blockedReason: string | null;
      readonly completionReason: string | null;
    };

    export type ReadinessSummaryFacts = {
      readonly total: number;
      readonly required: number;
      readonly done: number;
      readonly open: number;
      readonly blocked: number;
      readonly overdue: number;
      readonly byStatus: Readonly<Record<TaskStatus, number>>;
      readonly bySourceCapability: Readonly<Record<string, number>>;
    };

    export function syncTaskItems(
      trx: Transaction<Database>,
      activityId: string,
      definitionVersion: number,
      templates: readonly TaskTemplate[],
    ): Promise<readonly StoredTaskItem[]>;
    export function getTaskItemForUpdate(
      trx: Transaction<Database>,
      activityId: string,
      taskId: string,
    ): Promise<StoredTaskItem | null>;
    export function listTaskItems(
      db: Kysely<Database>,
      activityId: string,
      definitionVersion: number,
    ): Promise<readonly StoredTaskItem[]>;
    export function updateTaskItem(
      trx: Transaction<Database>,
      input: TaskItemMutation,
    ): Promise<StoredTaskItem>;
    export function summarizeTaskItems(
      db: Kysely<Database>,
      activityId: string,
      definitionVersion: number,
      now: string,
    ): Promise<ReadinessSummaryFacts>;

- [ ] Step 1: Write failing PostgreSQL repository tests.

Create tasks-repository.test.ts with these exact cases:

    it("migrates task_item and syncs each release template once", async () => {});
    it("does not overwrite a synced task when sync is retried", async () => {});
    it("allows the same template key in a different definition version", async () => {});
    it("summarizes required, open, blocked, done, and overdue tasks", async () => {});
    it("returns an empty aggregate without reading source capability rows", async () => {});

The test must mutate assignment/status/reasons between two sync calls and assert
they survive the retry. It must insert a private-looking source row and assert
JSON.stringify of the repository DTO does not contain its answer, note, token,
storage_key, or participant identifier.

- [ ] Step 2: Run the DB test and verify the expected red failure.

    $env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
    $env:REQUIRE_DB = "1"
    pnpm -C plus --filter @artflow-plus/db test -- tasks-repository.test.ts

Expected failure: task_item does not exist and the repository exports are missing.

- [ ] Step 3: Add the additive migration, Kysely row type, and repository.

Add TaskItemRow to types.ts, then add one forward-only task_item table to the
module-owned migration registry with the fields and constraints in the spec.
Add unique (activity_id, definition_version, template_key), indexes for
current-version/status and due-time reads, and timestamps following the
existing migration conventions. Do not alter or drop existing tables.

Implement syncTaskItems with insert on conflict do nothing, then select the
version's rows. Implement getTaskItemForUpdate with
forUpdate().executeTakeFirst(), and make updateTaskItem require the caller's
locked revision. Compute overdue as due_at < now and status not done; never read
source capability rows in the summary query.

- [ ] Step 4: Run DB checks and verify green.

    pnpm -C plus --filter @artflow-plus/db check
    $env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
    $env:REQUIRE_DB = "1"
    pnpm -C plus --filter @artflow-plus/db test -- tasks-repository.test.ts

- [ ] Step 5: Commit the DB slice.

    git add plus/packages/db/src/types.ts plus/packages/db/src/migrations.ts plus/packages/db/src/task-repository.ts plus/packages/db/src/index.ts plus/packages/db/test/tasks-repository.test.ts
    git commit -m "feat: persist versioned task items"



## Task 3: Implement task commands and readiness runtime

**Interfaces:**

    export interface SyncTasksInput {
      readonly activityId: string;
      readonly definitionVersion: number;
      readonly commandId: string;
      readonly actor: ActorContext;
    }

    export interface TaskMutationInput {
      readonly activityId: string;
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly actor: ActorContext;
      readonly commandId: string;
      readonly reason?: string;
      readonly assigneeActorId?: string | null;
      readonly dueAt?: string | null;
    }

    export interface TaskView extends StoredTaskItem {}

    export interface TaskSyncResult {
      readonly definitionVersion: number;
      readonly createdCount: number;
      readonly tasks: readonly TaskView[];
    }

    export interface TaskListView {
      readonly activityId: string;
      readonly definitionVersion: number;
      readonly tasks: readonly TaskView[];
    }

    export interface ReadinessView {
      readonly activityId: string;
      readonly definitionVersion: number;
      readonly summary: ReadinessSummaryFacts;
      readonly openTaskKeys: readonly string[];
    }

    export function syncTasks(
      db: Kysely<Database>, deps: RuntimeDeps, input: SyncTasksInput,
    ): Promise<CommandOutcome<TaskSyncResult>>;
    export function assignTask(
      db: Kysely<Database>, deps: RuntimeDeps, input: TaskMutationInput,
    ): Promise<CommandOutcome<TaskView>>;
    export function startTask(
      db: Kysely<Database>, deps: RuntimeDeps, input: TaskMutationInput,
    ): Promise<CommandOutcome<TaskView>>;
    export function blockTask(
      db: Kysely<Database>, deps: RuntimeDeps, input: TaskMutationInput,
    ): Promise<CommandOutcome<TaskView>>;
    export function completeTask(
      db: Kysely<Database>, deps: RuntimeDeps, input: TaskMutationInput,
    ): Promise<CommandOutcome<TaskView>>;
    export function reopenTask(
      db: Kysely<Database>, deps: RuntimeDeps, input: TaskMutationInput,
    ): Promise<CommandOutcome<TaskView>>;
    export function listTasks(
      db: Kysely<Database>, deps: RuntimeDeps, activityId: string,
    ): Promise<TaskListView>;
    export function readReadiness(
      db: Kysely<Database>, deps: RuntimeDeps, activityId: string,
    ): Promise<ReadinessView>;

- [ ] Step 1: Write failing runtime tests.

Create tasks-service.test.ts with these exact behavior names:

    it("syncs tasks from the activity's current released artifact", async () => {});
    it("refuses sync when the released artifact has no tasks capability", async () => {});
    it("enforces pending-start-block-complete-reopen transitions", async () => {});
    it("requires reasons for block, complete, and reopen", async () => {});
    it("rejects stale task revisions without writing an audit or outbox event", async () => {});
    it("replays the same command receipt and rejects a conflicting payload", async () => {});
    it("keeps source capability facts unchanged after every task mutation", async () => {});
    it("builds readiness from task facts and marks only unfinished due tasks overdue", async () => {});

- [ ] Step 2: Run the focused runtime test and verify the expected red failure.

    $env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
    $env:REQUIRE_DB = "1"
    pnpm -C plus --filter @artflow-plus/runtime test -- tasks-service.test.ts

Expected failure: the task service module and task repository exports are not
present.

- [ ] Step 3: Implement the runtime service through executeCommand.

Use getRelease(trx, activityId, definitionVersion) for tasks.sync; read only
release.capabilities.tasks.artifact, validate the artifact shape, and call
syncTaskItems. For task mutations, require tasks.manage, lock the Activity first,
lock the task second, verify the task belongs to the activity's current active
definition version, compare expectedRevision, validate the transition, and call
updateTaskItem. Use command types exactly matching the spec and emit
tasks.changed through the existing outbox event helper.

blockTask, completeTask, and reopenTask reject blank reasons with a stable domain
error. startTask allows only pending; blockTask allows pending and in_progress;
completeTask allows only in_progress; reopenTask maps done to pending and
blocked to in_progress. Every accepted mutation returns the safe TaskView only.

- [ ] Step 4: Run the focused runtime tests and verify green.

    pnpm -C plus --filter @artflow-plus/runtime check
    $env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
    $env:REQUIRE_DB = "1"
    pnpm -C plus --filter @artflow-plus/runtime test -- tasks-service.test.ts

- [ ] Step 5: Commit the runtime slice.

    git add plus/packages/runtime/src/tasks-service.ts plus/packages/runtime/src/index.ts plus/packages/runtime/test/tasks-service.test.ts
    git commit -m "feat: add audited task commands"

## Task 4: Add shared contracts and protected API routes

**Interfaces:**

    export type TaskAction = "assign" | "start" | "block" | "complete" | "reopen";
    export type TaskCommandBody = {
      readonly expectedRevision: number;
      readonly assigneeActorId?: string | null;
      readonly dueAt?: string | null;
      readonly reason?: string;
    };
    export const ActivityParamsSchema: TObject<{ id: TString }>;
    export const TaskParamsSchema: TObject<{ id: TString; taskId: TString }>;
    export const SyncTaskBodySchema: TObject<{ definitionVersion: TInteger }>;
    export const RevisionBodySchema: TObject<{ expectedRevision: TInteger }>;
    export const AssignTaskBodySchema: TObject<{
      expectedRevision: TInteger;
      assigneeActorId: TUnion<[TString, TNull]>;
      dueAt: TOptional<TUnion<[TString, TNull]>>;
    }>;
    export const ReasonBodySchema: TObject<{
      expectedRevision: TInteger;
      reason: TString;
    }>;
    export const TaskResponseSchema: TObject<{
      id: TString;
      activityId: TString;
      definitionVersion: TInteger;
      templateKey: TString;
      title: TString;
      sourceCapability: TString;
      sourceKey: TString;
      required: TBoolean;
      status: TUnion<[TLiteral<"pending">, TLiteral<"in_progress">, TLiteral<"blocked">, TLiteral<"done">]>;
      assigneeActorId: TUnion<[TString, TNull]>;
      dueAt: TUnion<[TString, TNull]>;
      blockedReason: TUnion<[TString, TNull]>;
      completionReason: TUnion<[TString, TNull]>;
      revision: TInteger;
      createdAt: TString;
      updatedAt: TString;
    }>;
    export const ReadinessSummarySchema: TObject<{
      total: TInteger;
      required: TInteger;
      done: TInteger;
      open: TInteger;
      blocked: TInteger;
      overdue: TInteger;
      byStatus: TRecord<TString, TInteger>;
      bySourceCapability: TRecord<TString, TInteger>;
    }>;
    export const TaskListResponseSchema: TObject<{
      activityId: TString;
      definitionVersion: TInteger;
      tasks: TArray<TaskResponseSchema>;
    }>;
    export const ReadinessResponseSchema: TObject<{
      activityId: TString;
      definitionVersion: TInteger;
      summary: ReadinessSummarySchema;
      openTaskKeys: TArray<TString>;
    }>;
    export type TaskResponse = Static<typeof TaskResponseSchema>;
    export type TaskListResponse = Static<typeof TaskListResponseSchema>;
    export type ReadinessResponse = Static<typeof ReadinessResponseSchema>;

- [ ] Step 1: Write failing API tests.

Create plus/apps/api/test/tasks.test.ts with these exact cases:

    it("declares the tasks read surface and returns an aggregate task list", async () => {});
    it("returns readiness counts without source capability private fields", async () => {});
    it("rejects task reads without an allowed task/operations permission", async () => {});
    it("returns 404 for a missing activity and 409 for a stale task revision", async () => {});
    it("accepts an idempotent task command and replays the same response", async () => {});
    it("rejects invalid command bodies before runtime mutation", async () => {});

- [ ] Step 2: Run the focused API tests and verify the expected red failure.

    $env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
    $env:REQUIRE_DB = "1"
    pnpm -C plus --filter @artflow-plus/api test -- tasks.test.ts

Expected failure: no tasks contracts or routes are registered.

- [ ] Step 3: Add contracts and route registration.

Create exact TypeBox schemas for path IDs, definitionVersion, expectedRevision,
assigneeActorId: string | null, dueAt: ISO string | null, and non-empty reason.
Add response schemas that enumerate only safe task and readiness fields. Add the
tasks read surface with the exact permissions in the spec; keep the existing
operations event-feed surface unchanged.

Register GET /api/activities/:id/tasks and /api/activities/:id/readiness with
response schemas and config.access: tasks. Register the six POST routes with
body schemas, tasks.manage command authorization, idempotency header parsing,
and existing publicErrorMessage/DomainError mapping. The sync route accepts the
required definitionVersion body field, while the runtime reads the activity's
current active release under lock and rejects any version mismatch; the client
cannot choose a different activity or release through a path/body mismatch.

- [ ] Step 4: Run the focused API tests and verify green.

    pnpm -C plus --filter @artflow-plus/api check
    $env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
    $env:REQUIRE_DB = "1"
    pnpm -C plus --filter @artflow-plus/api test -- tasks.test.ts

- [ ] Step 5: Commit the API slice.

    git add plus/packages/contracts/src/tasks.ts plus/packages/contracts/src/index.ts plus/apps/api/src/app.ts plus/apps/api/test/tasks.test.ts
    git commit -m "feat: expose protected task API"

## Task 5: Build the Ops task checklist and readiness UI

**Interfaces:**

    export function fetchTasks(activityId: string): Promise<TaskListResponse>;
    export function fetchReadiness(activityId: string): Promise<ReadinessResponse>;
    export function mutateTask(
      activityId: string,
      taskId: string,
      action: TaskAction,
      body: TaskCommandBody,
    ): Promise<TaskView>;
    export function TasksCard(props: {
      activityId: string;
      tasks: TaskResponse[];
      readiness: ReadinessResponse;
      canManage: boolean;
    }): JSX.Element;

- [ ] Step 1: Write failing web tests.

Create TasksCard.test.tsx with these exact cases:

    it("renders task title, source, status, assignee, due time, and reasons", () => {});
    it("renders a clear empty state when no templates are synced", () => {});
    it("hides mutation controls without tasks.manage", () => {});
    it("renders blocked and overdue readiness summaries", () => {});

Extend opsActivity.test.tsx with a mocked task/readiness query and assert the
card is mounted only when the activity enables tasks.

- [ ] Step 2: Run the focused Web tests and verify the expected red failure.

    pnpm -C plus --filter @artflow-plus/web test -- TasksCard.test.tsx opsActivity.test.tsx

Expected failure: the API client and TasksCard do not exist.

- [ ] Step 3: Implement the minimal UI.

Use the existing apiFetch and idempotency helper; never put source private fields
or raw credentials into browser state. Render the checklist with stable status
labels, bounded reason text, and ISO dates formatted in the existing locale.
Render controls only for tasks.manage; each mutation uses the latest returned
revision and reports stale conflicts without silently refreshing the task. Add
responsive styles without introducing a new visual theme or socket client.

- [ ] Step 4: Run focused Web tests and check the production build.

    pnpm -C plus --filter @artflow-plus/web test -- TasksCard.test.tsx opsActivity.test.tsx
    pnpm -C plus --filter @artflow-plus/web check
    pnpm -C plus --filter @artflow-plus/web build

- [ ] Step 5: Commit the Web slice.

    git add plus/apps/web/src/api/tasks.ts plus/apps/web/src/api/tasks.test.ts plus/apps/web/src/components/ops/TasksCard.tsx plus/apps/web/src/components/ops/TasksCard.test.tsx plus/apps/web/src/routes/opsActivity.tsx plus/apps/web/src/routes/opsActivity.test.tsx plus/apps/web/src/styles/global.css
    git commit -m "feat: add Ops task checklist"



## Task 6: Complete the self-built responsibility checks and product docs

**Files:**

- Modify docs/artflow-plus/checks/2026-10-28-tasks-readiness-checks.md.
- Modify docs/artflow-plus/roadmap.md.
- Modify plus/README.md.
- Modify docs/artflow-plus/self-build-checklist.md only if a new durable
  responsibility or explicit non-goal needs to be indexed.

- [ ] Step 1: Replace planned check markers with evidence.

For each TASK-* row, record the exact passing test file/command and mark it only
after the command has run with exit code 0. For concurrency, migration,
read-surface, redaction, and no-source-mutation checks, link the focused test
name rather than writing a prose assertion.

- [ ] Step 2: Update roadmap and README.

Mark M15.2 complete only after the full verification task passes. State that
tasks are optional, release-bound, activity-operation facts, and that readiness
does not close any source capability. Keep M15.3 check-in and M15.4 schedule as
the next ordered work; do not add a rehearsal prerequisite.

- [ ] Step 3: Run documentation and diff checks.

    pwsh -NoProfile -File scripts/check_docs.ps1
    git diff --check

- [ ] Step 4: Commit the responsibility documentation.

    git add docs/artflow-plus/checks/2026-10-28-tasks-readiness-checks.md docs/artflow-plus/roadmap.md plus/README.md docs/artflow-plus/self-build-checklist.md
    git commit -m "docs: record tasks readiness checks"

## Task 7: Run the complete verification and integrate

- [ ] Step 1: Run focused evidence one final time.

    $env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
    $env:REQUIRE_DB = "1"
    pnpm -C plus --filter @artflow-plus/domain test -- tasks.test.ts registry-packs.test.ts
    pnpm -C plus --filter @artflow-plus/db test -- tasks-repository.test.ts
    pnpm -C plus --filter @artflow-plus/runtime test -- tasks-service.test.ts
    pnpm -C plus --filter @artflow-plus/api test -- tasks.test.ts
    pnpm -C plus --filter @artflow-plus/web test -- TasksCard.test.tsx opsActivity.test.tsx

- [ ] Step 2: Run all Plus and repository gates.

    pnpm -C plus run check
    pnpm -C plus run build
    pnpm -C plus run test
    uv run pytest tests/gates -q
    pwsh -NoProfile -File scripts/check_docs.ps1
    git diff --check
    git status --short --branch

Expected: no skipped DB tests under REQUIRE_DB=1, no new allowlist entries,
no warnings treated as success, and a clean feature branch after commits.

- [ ] Step 3: Review the configuration sweep.

Confirm the new domain/db/runtime/API/Web files are covered by existing workspace
tsconfig files, package exports, build scripts, Tailwind content, and gate
discovery. Confirm no environment variable, dependency, media mount, or worker
process was added.

- [ ] Step 4: Merge and push directly.

    git status --short
    git diff --check
    git switch artflow-plus
    git pull --ff-only origin artflow-plus
    git merge --no-ff feat/m15-2-tasks-readiness -m "merge: add tasks readiness capability"
    git push origin artflow-plus
    git status --short --branch
    git ls-remote origin refs/heads/artflow-plus
    git branch -d feat/m15-2-tasks-readiness

Do not open a PR, run full Django tests, or start a real activity rehearsal.

