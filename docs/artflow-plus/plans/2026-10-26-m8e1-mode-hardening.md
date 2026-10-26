# M8e-1 Mode Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate test/rehearsal score and vote facts from formal reads, and add a rehearsal reset so the same activity can rehearse before its formal run.

**Architecture:** Add a `mode` column to `score_fact`, `vote_session`, and `ranking_snapshot`; derive it from the running execution session on every write; filter every competitive read by mode. Guard non-formal lifecycle mutations once formal score facts exist, and provide a staff reset that clears non-formal data and returns the round to `prepared`.

**Tech Stack:** TypeScript 7, Kysely, PostgreSQL, Fastify, Vitest, Playwright.

**Spec:** `docs/artflow-plus/specs/2026-10-26-m8e1-mode-hardening-design.md`

---

### Task 1: Schema and data layer

**Files:**
- Modify: `plus/packages/db/src/migrations.ts` (append after `0014_stage_result_note`)
- Modify: `plus/packages/db/src/types.ts`
- Modify: `plus/packages/db/src/score-repository.ts`
- Modify: `plus/packages/db/src/voting-ticket-repository.ts`
- Test: `plus/packages/db/test/score-repository.test.ts`

- [ ] **Step 1: Write the failing repository test**

In `plus/packages/db/test/score-repository.test.ts`, add `mode: "formal"` to the `seedScoreFact()` return value, import `getScoreFactForUpdate`, `insertRankingSnapshot`, `getCurrentRankingSnapshot`, then add:

```typescript
  it("keeps one current score fact and one ranking per mode", async () => {
    const fact = await seedScoreFact();
    await db.insertInto("panel_snapshot").values({
      id: fact.panelSnapshotId,
      activity_id: fact.activityId,
      round_id: fact.roundId,
      version: 1,
      state: "active",
      expected_judges: 5,
      minimum_judges: 3,
      roster_digest: "roster",
      context_version: 1,
      current: true,
    }).execute();
    await db.insertInto("judge_seat").values({
      id: fact.seatId,
      panel_id: fact.panelSnapshotId,
      judge_id: "judge-1",
      state: "assigned",
      revision: 0,
    }).execute();
    await insertScoreFact(db, fact);
    await insertScoreFact(db, { ...fact, id: `${fact.id}-rehearsal`, mode: "rehearsal", total: "80.00" });

    expect(await getScoreFactForUpdate(db, fact.roundId, fact.contestantId, fact.judgeId, "formal"))
      .toMatchObject({ mode: "formal", total: "91.00" });
    expect(await getScoreFactForUpdate(db, fact.roundId, fact.contestantId, fact.judgeId, "rehearsal"))
      .toMatchObject({ mode: "rehearsal", total: "80.00" });

    const base = {
      activityId: fact.activityId,
      roundId: fact.roundId,
      sourceScoreVersion: 0,
      inputFingerprint: "fp",
      status: "ready" as const,
      rows: [],
      tieGroups: [],
      revision: 1,
    };
    await insertRankingSnapshot(db, { ...base, id: "ranking-formal", mode: "formal" });
    await insertRankingSnapshot(db, { ...base, id: "ranking-rehearsal", mode: "rehearsal" });
    expect((await getCurrentRankingSnapshot(db, fact.roundId, "formal"))?.id).toBe("ranking-formal");
    expect((await getCurrentRankingSnapshot(db, fact.roundId, "rehearsal"))?.id).toBe("ranking-rehearsal");
  });
```

- [ ] **Step 2: Run it and watch it fail**

```powershell
cd plus
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm --filter @artflow-plus/db exec vitest run test/score-repository.test.ts
```

Expected: FAIL — `mode` does not exist on the inserted row / function arity mismatch.

- [ ] **Step 3: Add migration 0015**

Append to `migrations` in `plus/packages/db/src/migrations.ts`:

```typescript
  "0015_mode_isolation": {
    async up(db: Kysely<Database>): Promise<void> {
      await sql`
        alter table score_fact
          add column mode varchar(20) not null default 'formal',
          add constraint score_fact_mode_check check (mode in ('test', 'rehearsal', 'formal'));
        drop index if exists score_fact_current_key;
        create unique index score_fact_current_key
          on score_fact(round_id, contestant_id, judge_id, mode)
          where current = true;

        alter table vote_session
          add column mode varchar(20) not null default 'formal',
          add constraint vote_session_mode_check check (mode in ('test', 'rehearsal', 'formal'));

        alter table ranking_snapshot
          add column mode varchar(20) not null default 'formal',
          add constraint ranking_snapshot_mode_check check (mode in ('test', 'rehearsal', 'formal'));
        create index ranking_snapshot_round_mode_idx
          on ranking_snapshot(round_id, mode, revision desc);
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await sql`
        drop index if exists ranking_snapshot_round_mode_idx;
        alter table ranking_snapshot drop constraint if exists ranking_snapshot_mode_check;
        alter table ranking_snapshot drop column if exists mode;
        alter table vote_session drop constraint if exists vote_session_mode_check;
        alter table vote_session drop column if exists mode;
        drop index if exists score_fact_current_key;
        alter table score_fact drop constraint if exists score_fact_mode_check;
        alter table score_fact drop column if exists mode;
        create unique index score_fact_current_key
          on score_fact(round_id, contestant_id, judge_id)
          where current = true;
      `.execute(db);
    },
  },
```

- [ ] **Step 4: Update row types**

In `plus/packages/db/src/types.ts`:
- `ScoreFactRow`: add `mode: string;` after `source`.
- `RankingSnapshotRow`: add `mode: string;` after `round_id`.
- `VoteSessionRow`: add `mode: string;` after `definition_version`.

- [ ] **Step 5: Update score repository**

In `plus/packages/db/src/score-repository.ts`:
- Import `type ExecutionMode` from `@artflow-plus/domain`.
- `StoredScoreFact` and `StoredRankingSnapshot`: add `readonly mode: ExecutionMode;`.
- `scoreFact()` / `ranking()`: map `mode: row.mode as ExecutionMode`.
- `getScoreFactForUpdate(trx, roundId, contestantId, judgeId, mode)` add `.where("mode", "=", mode)`.
- `listCurrentScoreFacts(db, roundId, mode)` add `.where("mode", "=", mode)`.
- `listCurrentScoreFactsForJudge(db, roundId, judgeId, mode)` add `.where("mode", "=", mode)`.
- `countCurrentScoreFactsForContext(db, input)` add `mode` to the input and `and mode = ${input.mode}`.
- `countCurrentScoreFacts(db, performanceId, mode)` add `and mode = ${mode}`.
- `insertScoreFact`: write `mode: value.mode`.
- `insertRankingSnapshot`: write `mode: value.mode`.
- `getCurrentRankingSnapshot(db, roundId, mode)`: add `.where("mode", "=", mode)`.
- Sweep every `StoredScoreFact` / `StoredRankingSnapshot` literal under
  `plus/packages/runtime/test`, `plus/packages/db/test`, and `plus/apps/api/test`
  and add `mode: "formal"` (search for `contextVersion:` and
  `inputFingerprint:` fixtures). Typecheck will list any missed literals.

Add the guard helper:

```typescript
export async function existsFormalScoreFactsForRound(
  db: Kysely<Database>,
  roundId: string,
): Promise<boolean> {
  const row = await db.selectFrom("score_fact").select("id")
    .where("round_id", "=", roundId)
    .where("mode", "=", "formal")
    .executeTakeFirst();
  return row !== undefined;
}
```

- [ ] **Step 6: Update vote session repository**

In `plus/packages/db/src/voting-ticket-repository.ts`:
- Import `type ExecutionMode` from `@artflow-plus/domain`.
- `StoredVoteSession`: add `readonly mode: ExecutionMode;`.
- `voteSession()`: map `mode: row.mode as ExecutionMode`.
- `insertVoteSession()`: write `mode: input.mode`.

- [ ] **Step 7: Run the DB tests**

```powershell
pnpm --filter @artflow-plus/db test
```

Expected: the new test passes. Other packages still fail typecheck until call sites are updated.

- [ ] **Step 8: Commit**

```powershell
git add plus/packages/db
git commit -m "feat(db): add execution mode to score, vote, and ranking facts"
```

---

### Task 2: Score write and edit paths

**Files:**
- Modify: `plus/packages/runtime/src/score-service.ts`
- Modify: `plus/packages/runtime/src/competition-service.ts` (gate counts)
- Test: `plus/packages/runtime/test/score-service.test.ts`

- [ ] **Step 1: Write the failing test**

In `score-service.test.ts`, import `listCurrentScoreFacts` from `@artflow-plus/db`, then add:

```typescript
  it("keeps rehearsal facts separate from formal facts", async () => {
    const context = await seedScoreWindow();
    await submitJudgeScore(db, deps(judge), {
      commandId: "mode-formal-score",
      ...context,
      contextVersion: 1,
      criteria,
      notes: "",
      scope: "judging",
    });
    await db.updateTable("execution_session")
      .set({ status: "closed" })
      .where("activity_id", "=", context.activityId)
      .execute();
    await insertSession(db, {
      id: `rehearsal-${context.activityId}`,
      activityId: context.activityId,
      definitionVersion: 1,
      contentHash: "score-release",
      scope: "judging",
      mode: "rehearsal",
      status: "running",
      revision: 0,
    }, "2026-10-19T16:30:00Z");
    const rehearsal = await submitJudgeScore(db, deps(judge), {
      commandId: "mode-rehearsal-score",
      ...context,
      contextVersion: 1,
      criteria: { technique: 40, stage: 30, emotion: 30 },
      notes: "彩排",
      scope: "judging",
    });
    expect(rehearsal.body).toMatchObject({ mode: "rehearsal", total: "100.00" });
    expect(await listCurrentScoreFacts(db, context.roundId, "formal")).toHaveLength(1);
    expect(await listCurrentScoreFacts(db, context.roundId, "rehearsal")).toHaveLength(1);
    await expect(editScoreFact(db, deps(staff), {
      commandId: "mode-wrong-edit",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      scoreFactId: rehearsal.body.id,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 1,
      expectedVersion: 1,
      criteria: { technique: 1, stage: 1, emotion: 1 },
      reason: "wrong mode",
      scope: "judging",
    })).rejects.toMatchObject({ code: "SCORE_FACT_NOT_FOUND" });
  });
```

- [ ] **Step 2: Run it and watch it fail**

```powershell
cd plus
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm --filter @artflow-plus/runtime exec vitest run test/score-service.test.ts
```

Expected: FAIL — rehearsal submission returns `DUPLICATE_SCORE_FACT` or lacks `mode`.

- [ ] **Step 3: Implement score-service mode plumbing**

- `LoadedScoreContext`: add `readonly mode: ExecutionMode;` and import the type from `@artflow-plus/domain`.
- In `loadScoreContext` return: add `mode: session.mode`.
- `submitScore`:
  - `getScoreFactForUpdate(trx, context.round.id, context.contestantId, context.judgeId, context.mode)`.
  - fact id: `idFromCommand("score", `${scoreFactKey(...)}:${context.contextVersion}:${context.mode}`)`.
  - fact object: add `mode: context.mode`.
- `editScoreFact`: pass `context.mode` to `getScoreFactForUpdate`.
- `correctionContext`: after loading the session, add `if (fact.mode !== session.mode) throw new DomainError("FORBIDDEN", "The score fact belongs to another execution mode.");`.
- `competition-service.ts` gate counts (two `countCurrentScoreFactsForContext` calls): pass the running session's mode. Both call sites already resolve a session via `runningSession(...)`; use its `mode`.

- [ ] **Step 4: Run score + competition tests**

```powershell
pnpm --filter @artflow-plus/runtime exec vitest run test/score-service.test.ts test/competition-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add plus/packages/runtime/src/score-service.ts plus/packages/runtime/src/competition-service.ts plus/packages/runtime/test/score-service.test.ts
git commit -m "feat(score): scope score facts by execution mode"
```

---

### Task 3: Rankings, podium, and advancement

**Files:**
- Modify: `plus/packages/runtime/src/resolution-service.ts`
- Modify: `plus/packages/runtime/src/live-service.ts` (ranking read)
- Modify: `plus/apps/api/src/app.ts` (ranking query)
- Modify: `plus/packages/contracts/src/competition.ts` (ranking query schema)
- Test: `plus/packages/runtime/test/resolution-service.test.ts`

- [ ] **Step 1: Write the failing ranking test**

Add a test that runs a rehearsal-only round (rehearsal session from the start), resolves it, and asserts:

```typescript
    const rehearsalRanking = await resolveRound(db, deps(staff), {
      commandId: "mode-resolve-rehearsal",
      activityId,
      roundId,
      scope: "judging",
    });
    expect(rehearsalRanking.body).toMatchObject({ mode: "rehearsal", status: "ready" });
    expect(await getCurrentRankingSnapshot(db, roundId, "rehearsal")).not.toBeNull();
    expect(await getCurrentRankingSnapshot(db, roundId, "formal")).toBeNull();
    await expect(recomputePodiumCandidate(db, deps(staff), {
      commandId: "mode-podium-rehearsal",
      activityId,
      scope: "judging",
      roundIds: [roundId],
      expectedInputFingerprint: rehearsalRanking.body.inputFingerprint,
    })).rejects.toMatchObject({ code: "FORMAL_MODE_REQUIRED" });
```

Use the existing seeding helpers in `resolution-service.test.ts`; force the session mode to `rehearsal` by editing the inserted `execution_session` row (`db.updateTable("execution_session").set({ mode: "rehearsal" })`).

- [ ] **Step 2: Run it and watch it fail**

```powershell
pnpm --filter @artflow-plus/runtime exec vitest run test/resolution-service.test.ts
```

Expected: FAIL — ranking has no mode / podium accepts rehearsal.

- [ ] **Step 3: Implement resolution mode**

- `rankingInput(trx, activity, round, mode)`: `listCurrentScoreFacts(trx, round.id, mode)`.
- `resolveRound`: `mode: session.mode` on the snapshot; `getCurrentRankingSnapshot(trx, round.id, session.mode)` for the revision base; pass `session.mode` to `rankingInput`.
- `finalizeAdvancement`, `recordTieDecision`, `recomputePodiumCandidate`: after resolving the running session, `if (session.mode !== "formal") throw new DomainError("FORMAL_MODE_REQUIRED", "Only a formal execution can advance or publish results.");`.
- `recomputePodiumCandidate`: `getCurrentRankingSnapshot(trx, round.id, "formal")`.
- `live-service.getLiveState`: `const mode = session?.mode ?? "formal";` and `getCurrentRankingSnapshot(db, round.id, mode)`; pass `mode` to `countCurrentScoreFactsForContext`.

- [ ] **Step 4: Add the ranking query mode**

In `plus/packages/contracts/src/competition.ts` add:

```typescript
export const CompetitionRankingQuerySchema = Type.Object({
  scope: ScopeSchema,
  mode: Type.Optional(Type.Union([
    Type.Literal("test"),
    Type.Literal("rehearsal"),
    Type.Literal("formal"),
  ])),
}, { additionalProperties: false });
```

In `app.ts` import it and use it on the ranking GET route; pass `query.mode ?? "formal"` to `getCurrentRankingSnapshot`.

- [ ] **Step 5: Run tests**

```powershell
pnpm --filter @artflow-plus/runtime exec vitest run test/resolution-service.test.ts
pnpm --filter @artflow-plus/api exec vitest run test/competition.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add plus/packages/runtime/src/resolution-service.ts plus/packages/runtime/src/live-service.ts plus/apps/api/src/app.ts plus/packages/contracts/src/competition.ts plus/packages/runtime/test/resolution-service.test.ts
git commit -m "feat(resolution): scope rankings and podium reads by mode"
```

---

### Task 4: Vote session mode

**Files:**
- Modify: `plus/packages/runtime/src/voting-ticket-service.ts`
- Test: `plus/packages/runtime/test/voting-ticket-service.test.ts`

- [ ] **Step 1: Write the failing test**

In the voting runtime test, open a vote session under a rehearsal execution session and assert `body.session.mode === "rehearsal"`, then read it back with `getVoteSession` and assert the same. Use the existing `seedActivity`/session helpers; add a helper to insert a rehearsal `execution_session` when needed.

- [ ] **Step 2: Run it and watch it fail**

```powershell
pnpm --filter @artflow-plus/runtime exec vitest run test/voting-ticket-service.test.ts
```

Expected: FAIL — `mode` is undefined.

- [ ] **Step 3: Implement**

In `openVoteSession`, add `mode: session.mode` to the `voteSession` object. Then sweep
every `StoredVoteSession` literal in `plus/packages/runtime/test` and
`plus/apps/api/test` (search for `identityPolicy:`) and add `mode: "formal"`.

- [ ] **Step 4: Run tests and commit**

```powershell
pnpm --filter @artflow-plus/runtime exec vitest run test/voting-ticket-service.test.ts
git add plus/packages/runtime/src/voting-ticket-service.ts plus/packages/runtime/test/voting-ticket-service.test.ts
git commit -m "feat(voting): tag vote sessions with execution mode"
```

---

### Task 5: Formal-facts guard and rehearsal reset

**Files:**
- Modify: `plus/packages/domain/src/errors.ts` (`FORMAL_FACTS_EXIST`)
- Modify: `plus/apps/api/src/app.ts` (status map + route)
- Modify: `plus/packages/contracts/src/competition.ts` (`ResetRehearsalBodySchema`)
- Modify: `plus/packages/db/src/competition-repository.ts` (reset helpers)
- Modify: `plus/packages/db/src/score-repository.ts` (delete helpers)
- Create: `plus/packages/runtime/src/rehearsal-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Test: `plus/packages/runtime/test/mode-guard-reset.test.ts`

- [ ] **Step 1: Write the failing guard/reset test**

Create `plus/packages/runtime/test/mode-guard-reset.test.ts` following the `score-service.test.ts` setup. Two tests:

1. **Guard**: seed a formal session, prepare/panel/open/score/lock performance/lock round; switch the running session to `rehearsal`; expect `resolveRound`, `lockRound`, `lockPerformance`, and `openPerformance` to reject with `FORMAL_FACTS_EXIST`.
2. **Reset**: seed a rehearsal-only round through lock/resolve; call `resetRehearsalRound`; assert:
   - `round.state === "prepared"`, `currentPanelId === null`, `scoreVersion === 0`;
   - `listRoundPerformances` is empty;
   - `listCurrentScoreFacts(round, "rehearsal")` is empty and no rankings;
   - activating a new panel and opening a performance succeeds.

- [ ] **Step 2: Run it and watch it fail**

```powershell
pnpm --filter @artflow-plus/runtime exec vitest run test/mode-guard-reset.test.ts
```

Expected: FAIL — module/function missing.

- [ ] **Step 3: Add guard checks**

In `competition-service.ts` add:

```typescript
async function requireNoFormalFacts(trx: Kysely<Database>, roundId: string, mode: ExecutionMode): Promise<void> {
  if (mode === "formal") return;
  if (await existsFormalScoreFactsForRound(trx, roundId)) {
    throw new DomainError("FORMAL_FACTS_EXIST", "Formal score facts exist; use a copied activity for rehearsal.");
  }
}
```

Call it after the running session is resolved in `openPerformance`, `lockPerformance`, `lockRound`, and `advancePerformance`. In `resolution-service.resolveRound`, call it before computing the ranking. Add `FORMAL_FACTS_EXIST` to `DomainErrorCode` and map it to 409 in `app.ts`.

- [ ] **Step 4: Implement reset repositories**

In `score-repository.ts`:

```typescript
export async function deleteNonFormalScoreDataForRound(trx: Kysely<Database>, roundId: string): Promise<number> {
  const facts = await trx.selectFrom("score_fact").select("id")
    .where("round_id", "=", roundId).where("mode", "!=", "formal").execute();
  const ids = facts.map((row) => row.id);
  if (ids.length === 0) return 0;
  await trx.deleteFrom("score_correction").where("score_fact_id", "in", ids).execute();
  await trx.deleteFrom("score_revision").where("score_fact_id", "in", ids).execute();
  await trx.deleteFrom("score_fact").where("id", "in", ids).execute();
  return ids.length;
}

export async function deleteNonFormalRankingsForRound(trx: Kysely<Database>, roundId: string): Promise<number> {
  const rows = await trx.deleteFrom("ranking_snapshot")
    .where("round_id", "=", roundId).where("mode", "!=", "formal").returning(["id"]).execute();
  return rows.length;
}
```

In `competition-repository.ts`:

```typescript
export async function deletePerformancesForRound(trx: Kysely<Database>, roundId: string): Promise<number> {
  const performances = await trx.selectFrom("performance").select("id")
    .where("round_id", "=", roundId).execute();
  const ids = performances.map((row) => row.id);
  if (ids.length > 0) {
    await trx.deleteFrom("performance_score_state").where("performance_id", "in", ids).execute();
    await trx.deleteFrom("performance").where("id", "in", ids).execute();
  }
  return ids.length;
}

export async function supersedeCurrentPanelForRound(trx: Kysely<Database>, roundId: string): Promise<void> {
  await trx.updateTable("panel_snapshot")
    .set({ current: false, state: "superseded" })
    .where("round_id", "=", roundId).where("current", "=", true).execute();
}
```

- [ ] **Step 5: Implement `resetRehearsalRound`**

Create `plus/packages/runtime/src/rehearsal-service.ts`:

```typescript
export interface ResetRehearsalInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly scope: string;
  readonly mode: "test" | "rehearsal";
}

export async function resetRehearsalRound(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ResetRehearsalInput,
): Promise<CommandOutcome<{ readonly round: StoredRound; readonly deletedFacts: number; readonly deletedRankings: number; readonly deletedPerformances: number }>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.rehearsal.reset",
    scope: input.scope,
    actor,
    payload: { roundId: input.roundId, scope: input.scope, mode: input.mode },
  }, async (trx) => {
    requirePermission(actor, "competition.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    const round = await getRoundForUpdate(trx, input.roundId);
    if (round === null || round.activityId !== activity.id) throw new DomainError("NOT_FOUND", "The competition round was not found.");
    if (await existsFormalScoreFactsForRound(trx, round.id)) {
      throw new DomainError("FORMAL_FACTS_EXIST", "Formal score facts exist; rehearsal reset is refused.");
    }
    const deletedFacts = await deleteNonFormalScoreDataForRound(trx, round.id);
    const deletedRankings = await deleteNonFormalRankingsForRound(trx, round.id);
    const deletedPerformances = await deletePerformancesForRound(trx, round.id);
    await supersedeCurrentPanelForRound(trx, round.id);
    const saved = await updateRound(trx, {
      ...round,
      state: "prepared",
      revision: round.revision + 1,
      scoreVersion: 0,
      currentPanelId: null,
      lockedAt: null,
    }, round.revision);
    await appendEngineEvent(trx, deps, {
      type: "RehearsalRoundReset",
      activityId: activity.id,
      aggregateType: "competition_round",
      aggregateId: round.id,
      revision: saved.revision,
      capability: "competition",
      mode: input.mode,
      scope: input.scope,
      payload: { roundId: round.id, deletedFacts, deletedRankings, deletedPerformances, mode: input.mode },
    });
    return { body: { round: saved, deletedFacts, deletedRankings, deletedPerformances } };
  });
}
```

Export it from `plus/packages/runtime/src/index.ts`.

- [ ] **Step 6: Add the route**

In `contracts/competition.ts`:

```typescript
export const ResetRehearsalBodySchema = Type.Object({
  scope: ScopeSchema,
  mode: Type.Union([Type.Literal("test"), Type.Literal("rehearsal")]),
}, { additionalProperties: false });
```

In `app.ts` add:

```typescript
  app.post(
    "/api/activities/:id/competition/rounds/:roundKey/reset-rehearsal",
    { schema: { params: CompetitionRoundParamsSchema, body: ResetRehearsalBodySchema } },
    async (request, reply) => {
      const commandId = requireIdempotency(request);
      const { id, roundKey } = request.params as { id: string; roundKey: string };
      const body = request.body as { scope: string; mode: "test" | "rehearsal" };
      const round = await routeRound(id, roundKey);
      const outcome = await resetRehearsalRound(db, await requestDeps(request), {
        commandId,
        activityId: id,
        roundId: round.id,
        scope: body.scope,
        mode: body.mode,
      });
      return reply.status(outcome.status).send(outcome.body);
    },
  );
```

- [ ] **Step 7: Run tests and commit**

```powershell
pnpm --filter @artflow-plus/runtime exec vitest run test/mode-guard-reset.test.ts
git add plus/packages/domain/src/errors.ts plus/apps/api/src/app.ts plus/packages/contracts/src/competition.ts plus/packages/db/src/competition-repository.ts plus/packages/db/src/score-repository.ts plus/packages/runtime/src/rehearsal-service.ts plus/packages/runtime/src/index.ts plus/packages/runtime/src/competition-service.ts plus/packages/runtime/src/resolution-service.ts plus/packages/runtime/test/mode-guard-reset.test.ts
git commit -m "feat(competition): guard formal facts and add rehearsal reset"
```

---

### Task 6: Live, judge, and API read surfaces

**Files:**
- Modify: `plus/packages/runtime/src/live-service.ts`
- Modify: `plus/apps/api/test/live.test.ts`
- Modify: `plus/apps/web/src/api/live.ts` and `LiveRoundPanel.tsx` (reset button)
- Test: `plus/apps/api/test/live.test.ts`

- [ ] **Step 1: Write the failing API test**

In `live.test.ts`, after the existing context test, change the execution session to `rehearsal`, submit a score through the API, and assert:

```typescript
    const rehearsalLive = await app.inject({ method: "GET", url: `/api/activities/${activityId}/live` });
    expect(rehearsalLive.json().rounds[0].performances[0].scoreCount).toBe(1);
    await db.updateTable("execution_session").set({ mode: "formal" }).where("activity_id", "=", activityId).execute();
    const formalLive = await app.inject({ method: "GET", url: `/api/activities/${activityId}/live` });
    expect(formalLive.json().rounds[0].performances[0].scoreCount).toBe(0);
```

Also assert the judge context returns the rehearsal score only under the rehearsal mode (set the session mode before reading).

- [ ] **Step 2: Run it and watch it fail**

```powershell
pnpm --filter @artflow-plus/api exec vitest run test/live.test.ts
```

Expected: FAIL — counts include both modes / judge context ignores mode.

- [ ] **Step 3: Implement Live and judge mode**

- `getLiveState`: derive `mode = session?.mode ?? "formal"` before the round loop; pass `mode` to `countCurrentScoreFactsForContext` and `getCurrentRankingSnapshot`.
- `getJudgeContext`: after `authenticateJudgeSession`, find the running judging session:

```typescript
const running = await findRunningSessionByScope(db, session.activityId, "judging");
const mode = running?.mode ?? "formal";
```

Pass `mode` to `listCurrentScoreFactsForJudge` and add `mode` to the returned context DTO.

- [ ] **Step 4: Add the reset control to the Live UI**

- `src/api/live.ts`: add `resetRehearsal(activityId, roundKey, mode)` calling the new route.
- `LiveRoundPanel.tsx`: when `round.state !== "prepared"` and the current session mode is non-formal, render a `danger-button` "重置排练"; on click `window.confirm("清空本回合排练数据并回到准备状态？")`, then call `resetRehearsal(activityId, config.key, mode)` and `onChanged()`.
- Pass `sessionMode` into `LiveRoundPanel` from `liveActivity.tsx` (`state.session?.mode`).

- [ ] **Step 5: Run tests and commit**

```powershell
pnpm --filter @artflow-plus/api exec vitest run test/live.test.ts
pnpm --filter @artflow-plus/web test
git add plus/packages/runtime/src/live-service.ts plus/apps/api/test/live.test.ts plus/apps/web/src/api/live.ts plus/apps/web/src/components/live/LiveRoundPanel.tsx plus/apps/web/src/routes/liveActivity.tsx
git commit -m "feat(live): read mode-scoped scores and reset rehearsals"
```

---

### Task 7: Rehearsal E2E

**Files:**
- Modify: `plus/apps/api/scripts/seed-live.ts` (second activity `act_e2e_mode_*`)
- Create: `plus/apps/web/e2e/mode-hardening.spec.ts`

- [ ] **Step 1: Seed a second activity**

In `seed-live.ts`, after the existing activity, seed `act-e2e-mode-<stamp>` / `E2E-MODE-<stamp>` with the same competition artifact and `["competition", "ticketing"]`, approved `singer-a`, final roster. Write it to the handoff as `modeActivityId`/`modePublicCode` in addition to the existing fields.

- [ ] **Step 2: Write the E2E**

`mode-hardening.spec.ts`:
1. Staff logs in, opens `/live/${modeActivityId}`.
2. Starts a `rehearsal` session, prepares `round-1`, activates the panel, opens `singer-a`.
3. Generates the judge link, judge scores 90/92/91, staff sees 1/1.
4. Locks performance and round, resolves → ranking 273.00.
5. Accepts the confirm dialog and clicks "重置排练"; expects the round heading `round-1 · prepared`, the performance table to be gone, and the ranking block to disappear.
6. Closes the session, starts a formal session, activates the panel again, opens `singer-a`, generates a new judge link, judge scores 80/80/80, locks performance/round, resolves → ranking 240.00.

- [ ] **Step 3: Run E2E**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus --filter @artflow-plus/web test:e2e
```

Expected: all specs pass.

- [ ] **Step 4: Commit**

```powershell
git add plus/apps/api/scripts/seed-live.ts plus/apps/web/e2e/mode-hardening.spec.ts
git commit -m "test(e2e): cover rehearsal, reset, and formal rerun"
```

---

### Task 8: Docs, full gate, integration

- [ ] **Step 1: Docs**

- Append ADR-0020 (`docs/architecture/adr/0020-mode-hardening.md`) and add it to the ADR index.
- Update roadmap M8e with the M8e-1 completion and remaining sub-slices.
- Update `plus/README.md` with the mode semantics and reset endpoint.
- Add M8e-1 items to `docs/artflow-plus/review-checklist.md`.
- Update the knowledge base `01-Projects/ArtFlow.md` (ADR entry + pitfalls) and commit it separately.

- [ ] **Step 2: Full gate**

```powershell
pnpm -C plus run check
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus run test
pnpm -C plus --filter @artflow-plus/web test:e2e
pwsh -NoProfile -File scripts/check_docs.ps1
```

Expected: all pass.

- [ ] **Step 3: Merge and push**

```powershell
git checkout artflow-plus
git merge --no-ff feat/plus-m8e1-mode-hardening -m "merge: M8e-1 mode hardening"
git push origin artflow-plus
gh run list -L 3 --branch artflow-plus
gh run watch <run-id> --exit-status
```

Expected: CI green.
