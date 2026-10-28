# M8e-4 Shape Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three Guided packs with default capability definitions and prove the singer, stage-show, and review-awards shapes through automated key journeys and an isolated validation report. A real-activity rehearsal is not part of acceptance.

**Architecture:** `ActivityPack` may carry `definitions` that replace `emptyDefinition()` for a capability. The three packs compose existing capabilities; competition gets a runnable round/rubric, stage show uses registration/questionnaire/materials/archive, review-awards adds competition+publishing.

**Tech Stack:** TypeScript, Vitest, Fastify, Kysely/PostgreSQL.

**Spec:** `docs/artflow-plus/specs/2026-10-26-m8e4-shape-validation-design.md`

---

### Task 1: Pack definitions and three packs

**Files:**
- Modify: `plus/packages/domain/src/packs.ts`
- Modify: `plus/packages/domain/src/index.ts`
- Test: `plus/packages/domain/test/registry-packs.test.ts`

- [ ] **Step 1: Extend the pack model and merge definitions**

In `ActivityPack` add:
```typescript
  /** Optional capability definitions that replace emptyDefinition(). */
  readonly definitions?: Readonly<Record<string, CapabilityDefinition>>;
```
In `instantiateActivityPack`, replace:
```typescript
const definition = registration.emptyDefinition();
```
with:
```typescript
const definition = pack.definitions?.[identity] ?? registration.emptyDefinition();
```
Import `type CapabilityDefinition` from `./model.js`.

- [ ] **Step 2: Give the singer pack a runnable default**

Add to `SINGER_COMPETITION_PACK`:
```typescript
definitions: {
  competition: createCompetitionDefinition(
    [
      { key: "roster", type: "roster" },
      { key: "final", type: "round" },
      { key: "result", type: "output" },
    ],
    [{ from: "roster", to: "final" }, { from: "final", to: "result" }],
    {
      rounds: [{ key: "final", judgeCount: 3, minimumJudges: 2, completion: "minimum_valid", advanceCount: 1, scoringMethod: "average" }],
      rubric: { criteria: [
        { key: "演唱技巧", weight: 1, maximum: 100, minimum: 0 },
        { key: "舞台表现", weight: 1, maximum: 100, minimum: 0 },
        { key: "情感表达", weight: 1, maximum: 100, minimum: 0 },
      ] },
      tiePolicy: "review",
    },
  ),
  questionnaire: createQuestionnaireDefinition("guided-v1", [
    { key: "name", label: "姓名", type: "text", required: true },
    { key: "student_id", label: "学号", type: "text", required: true },
    { key: "song", label: "演唱曲目", type: "text", required: true },
    { key: "description", label: "自我介绍", type: "textarea", required: false },
  ]),
  materials: createMaterialsDefinition(25 * 1024 * 1024, ["audio"]),
},
```

- [ ] **Step 3: Add stage-show and review-awards packs**

```typescript
export const STAGE_SHOW_PACK: ActivityPack = deepFreeze({
  identity: "stage-show",
  version: "1",
  title: "Stage Show",
  baselineCapabilities: ["registration", "questionnaire", "materials", "archive"],
  questions: [
    { id: "audience-voting", prompt: "是否需要观众投票？", capability: "voting", default: false },
  ],
  definitions: {
    questionnaire: createQuestionnaireDefinition("stage-v1", [
      { key: "name", label: "负责人", type: "text", required: true },
      { key: "program", label: "节目名称", type: "text", required: true },
      { key: "description", label: "节目介绍", type: "textarea", required: false },
      { key: "work_file", label: "作品文件", type: "file", required: true,
        file: { slot: "work", purpose: "video", accepts: [".mp4", ".mov"], maxBytes: 100 * 1024 * 1024 } },
    ]),
    materials: createMaterialsDefinition(100 * 1024 * 1024, ["video", "image", "document"]),
  },
});

export const REVIEW_AWARDS_PACK: ActivityPack = deepFreeze({
  identity: "review-awards",
  version: "1",
  title: "Review & Awards",
  baselineCapabilities: ["competition", "publishing", "archive"],
  questions: [
    { id: "registration-required", prompt: "是否需要报名？", capability: "registration", default: true },
    { id: "questionnaire", prompt: "是否填写作品问卷？", capability: "questionnaire", default: true },
    { id: "collect-materials", prompt: "是否需要提交作品文件？", capability: "materials", default: true },
    { id: "audience-voting", prompt: "是否需要观众投票？", capability: "voting", default: false },
  ],
  definitions: {
    competition: createCompetitionDefinition(
      [
        { key: "roster", type: "roster" },
        { key: "review", type: "round" },
        { key: "result", type: "output" },
      ],
      [{ from: "roster", to: "review" }, { from: "review", to: "result" }],
      {
        rounds: [{ key: "review", judgeCount: 3, minimumJudges: 2, completion: "minimum_valid", advanceCount: 1, scoringMethod: "average" }],
        rubric: { criteria: [
          { key: "主题", weight: 1, maximum: 100, minimum: 0 },
          { key: "完成度", weight: 1, maximum: 100, minimum: 0 },
          { key: "表现力", weight: 1, maximum: 100, minimum: 0 },
        ] },
        tiePolicy: "review",
      },
    ),
    questionnaire: createQuestionnaireDefinition("review-v1", [
      { key: "name", label: "作者", type: "text", required: true },
      { key: "work_title", label: "作品名称", type: "text", required: true },
      { key: "description", label: "作品说明", type: "textarea", required: false },
      { key: "work_file", label: "作品文件", type: "file", required: true,
        file: { slot: "work", purpose: "video", accepts: [".mp4", ".mov", ".jpg", ".png"], maxBytes: 100 * 1024 * 1024 } },
    ]),
    materials: createMaterialsDefinition(100 * 1024 * 1024, ["video", "image", "document"]),
  },
});
```

- [ ] **Step 4: Update the API pack list and domain exports**

In `plus/apps/api/src/app.ts` import the new packs and default to all three:
```typescript
const packs = options.packs ?? [SINGER_COMPETITION_PACK, STAGE_SHOW_PACK, REVIEW_AWARDS_PACK];
```
Export the packs from `plus/packages/domain/src/index.ts` (if packs are exported there).

- [ ] **Step 5: Write domain tests**

In `registry-packs.test.ts`:
```typescript
it("instantiates all guided packs with runnable defaults", () => {
  for (const pack of [SINGER_COMPETITION_PACK, STAGE_SHOW_PACK, REVIEW_AWARDS_PACK]) {
    const result = instantiateActivityPack(pack, defaultCapabilityRegistry, { title: pack.title });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) continue;
    expect(result.instantiation.definition.capabilities).toBeDefined();
    if (pack.identity === "stage-show") {
      expect(result.instantiation.enabledCapabilities).not.toContain("competition");
      expect(result.instantiation.enabledCapabilities).not.toContain("publishing");
    } else {
      const competition = result.instantiation.definition.capabilities.competition;
      expect(JSON.stringify(competition)).toContain('"rounds"');
    }
  }
});
```
Update any existing exact-definition assertions that assumed empty definitions.

- [ ] **Step 6: Run and commit**

```powershell
pnpm -C plus --filter @artflow-plus/domain test
pnpm -C plus run check
git add plus/packages/domain plus/apps/api/src/app.ts
git commit -m "feat(packs): add stage-show and review-awards with defaults"
```

---

### Task 2: Shape key journeys

**Files:**
- Create: `plus/apps/api/test/activity-shapes.test.ts`
- Reuse: `seed` patterns from `studio.test.ts`, `registration-read.test.ts`, `publishing.test.ts`

- [ ] **Step 1: Singer shape**

Create the activity from `SINGER_COMPETITION_PACK` via `POST /api/activities {packId, answers}`, activate, compile, release, start a `judging` session, prepare `final`, activate a panel (3 judges? the pack default judgeCount is 3; use 3 judge IDs/seats), open `singer-a`, staff_rapid score, lock performance, lock round, resolve; assert a ranking with one row.

- [ ] **Step 2: Stage-show shape**

Create from `STAGE_SHOW_PACK`, activate, compile, release. Participant registers (questionnaire answers + material metadata), ops approves, roster finalizes, archive succeeds. Assert `competition_round` has no rows and `result_release` is empty.

- [ ] **Step 3: Review-awards shape**

Create from `REVIEW_AWARDS_PACK`, activate, compile, release. Participant registers, ops approves, roster finalizes. Start `judging`; prepare `review`; panel; open a submission performance; score; lock; resolve. Start `publishing`; confirm the stage result; release; `GET /api/public/results/<code>` returns the snapshot. Add a negative: before confirm, the public selector returns no results.

- [ ] **Step 4: Run and commit**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus --filter @artflow-plus/api exec vitest run test/activity-shapes.test.ts
git add plus/apps/api/test/activity-shapes.test.ts
git commit -m "test(shapes): cover singer, stage-show, and review-awards"
```

---

### Task 3: Validation report

**Files:**
- Create: `docs/artflow-plus/shape-validation.md`

Validation report: the three packs' capability sets, the exact automated journeys
run, what was configuration-only, the isolated smoke/rollback evidence, and the
gaps (public program page, vote-only results, bracket, participant accounts).

- [ ] **Step 1: Write both documents and commit**

```powershell
git add docs/artflow-plus/shape-validation.md
git commit -m "docs: record the three activity shapes and validation evidence"
```

---

### Task 4: ADR, roadmap, full gate, merge

- [ ] **Step 1: ADR-0024** (`docs/architecture/adr/0024-pack-definitions-and-shapes.md`):
  packs may carry default definitions; three validated shapes; stage-show output
  and vote-only publishing are explicit gaps.
- [ ] **Step 2: Roadmap M8e-4 complete; M8 exit evidence listed.**
- [ ] **Step 3: README/review checklist/KB.**
- [ ] **Step 4: Full gate**

```powershell
pnpm -C plus run check
pnpm -C plus run build:prod
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus run test
pnpm -C plus --filter @artflow-plus/web test:e2e
pwsh -NoProfile -File scripts/check_docs.ps1
uv run pytest common/test_plus_bundle.py -q
```

- [ ] **Step 5: Merge and push**

```powershell
git checkout artflow-plus
git merge --no-ff feat/plus-m8e4-shape-validation -m "merge: M8e-4 shape validation"
git push origin artflow-plus
gh run watch <run-id> --exit-status
```
