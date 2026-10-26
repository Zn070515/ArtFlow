# M8e-2 Legacy Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a v1 activity into a versioned JSON bundle, import it into v2 in one reconciled transaction, and prove a historical activity's published results render in v2.

**Architecture:** A v1 Django management command writes a deterministic bundle; a v2 runtime command validates it, builds a v2 release/facts, writes everything in one transaction, and compares recomputed v2 counts/hashes with the bundle before committing.

**Tech Stack:** Django ORM (exporter), TypeScript/Kysely/Fastify (importer), Vitest, pytest, Playwright.

**Spec:** `docs/artflow-plus/specs/2026-10-26-m8e2-legacy-import-design.md`

---

### Task 1: Bundle contract and v1 exporter

**Files:**
- Create: `common/management/commands/export_plus_bundle.py`
- Create: `common/test_plus_bundle.py`
- Create: `plus/packages/runtime/src/legacy-bundle.ts` (types only in this task)

- [ ] **Step 1: Write the failing exporter test**

Create `common/test_plus_bundle.py`:

```python
import json
import tempfile
from pathlib import Path

from core.models import Activity
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase
from singer_contest.models import SingerRegistration


class ExportPlusBundleTests(TestCase):
    def _activity(self) -> Activity:
        return Activity.objects.create(
            title="2025 院十佳",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_CLOSED,
            public_code="LEG2025",
            is_test_mode=False,
        )

    def _registration(self, activity, name, *, test_data=False):
        user = get_user_model().objects.create_user(
            username=f"legacy-{name}", password="participant-password"
        )
        return SingerRegistration.objects.create(
            activity=activity,
            user=user,
            name=name,
            student_id=f"2025{name}",
            college="信息学院",
            class_name="1 班",
            phone="13800000000",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=test_data,
        )

    def test_export_skips_test_rows_and_never_copies_secrets(self) -> None:
        activity = self._activity()
        self._registration(activity, "Alice")
        self._registration(activity, "TestOnly", test_data=True)
        output = Path(tempfile.mkdtemp()) / "bundle.json"
        call_command("export_plus_bundle", activity="LEG2025", output=str(output))
        bundle = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(bundle["format"], "artflow-plus-legacy-bundle")
        self.assertEqual(bundle["counts"]["registrations"], 1)
        self.assertEqual(bundle["excluded"]["testRegistrations"], 1)
        serialized = output.read_text(encoding="utf-8")
        for forbidden in ("password", "token", "session_key", "ip_address"):
            self.assertNotIn(forbidden, serialized)
```

(The `ScoreRecord` branch is intentionally omitted here; Task 3 extends the exporter test with a round/score fixture.)

- [ ] **Step 2: Run it and watch it fail**

```powershell
uv run pytest common/test_plus_bundle.py -q
```

Expected: FAIL — `export_plus_bundle` is unknown.

- [ ] **Step 3: Implement the exporter**

Create `common/management/commands/export_plus_bundle.py`:

```python
import json
from pathlib import Path
from typing import Any

from core.models import Activity
from django.core.management.base import BaseCommand, CommandError
from singer_contest.models import SingerRegistration


class Command(BaseCommand):
    help = "Export one v1 activity as a versioned ArtFlow-Plus import bundle."
    requires_system_checks = []

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--activity", required=True, help="Activity public code.")
        parser.add_argument("--output", required=True, help="Destination JSON path.")

    def handle(self, *args: Any, **options: Any) -> None:
        activity = Activity.objects.filter(public_code=options["activity"]).first()
        if activity is None:
            raise CommandError("Activity not found.")
        registrations = SingerRegistration.objects.filter(activity=activity)
        formal = registrations.filter(is_test_data=False)
        excluded = registrations.filter(is_test_data=True).count()

        bundle = {
            "format": "artflow-plus-legacy-bundle",
            "version": 1,
            "exportedAt": activity.updated_at.isoformat(),
            "source": {
                "publicCode": activity.public_code,
                "activityId": activity.pk,
                "v1Version": "1.0.2",
            },
            "activity": {
                "publicCode": activity.public_code,
                "title": activity.title,
                "subtitle": activity.subtitle,
                "activityType": activity.activity_type,
                "phase": activity.phase,
                "createdAt": activity.created_at.isoformat(),
            },
            "questionnaire": {
                "version": "legacy-v1",
                "questions": [
                    {"key": "name", "label": "姓名", "type": "text", "required": True},
                    {"key": "student_id", "label": "学号", "type": "text", "required": True},
                    {"key": "college", "label": "学院", "type": "text", "required": True},
                    {"key": "class_name", "label": "班级", "type": "text", "required": True},
                    {"key": "phone", "label": "手机", "type": "text", "required": True},
                    {"key": "wechat", "label": "微信", "type": "text", "required": False},
                    {"key": "song", "label": "曲目", "type": "text", "required": False},
                    {"key": "description", "label": "自我介绍", "type": "textarea", "required": False},
                ],
            },
            "ruleset": {"present": False, "raw": {}},
            "rubric": {"criteria": [{"key": "总分", "weight": 1, "maximum": 100, "minimum": 0}], "tiePolicy": "review"},
            "rounds": [],
            "registrations": [
                {
                    "legacyId": row.pk,
                    "participantKey": f"legacy-user:{row.user_id or row.pk}",
                    "status": row.pre_status,
                    "answers": {
                        "name": row.name,
                        "student_id": row.student_id,
                        "college": row.college,
                        "class_name": row.class_name,
                        "phone": row.phone,
                        "wechat": row.wechat,
                        "song": row.song_name,
                        "description": row.description,
                    },
                    "reviewNote": row.remark,
                    "reviewedBy": None,
                    "createdAt": row.created_at.isoformat(),
                    "liveStatus": row.live_status,
                }
                for row in formal.order_by("pk")
            ],
            "roster": {"status": "unknown", "approvedCount": 0, "finalizedAt": None},
            "materials": [],
            "competition": {"panels": [], "seats": [], "performances": [], "scores": [], "rankings": []},
            "voting": {"sessions": [], "ballots": []},
            "results": {"stageResults": [], "releases": []},
            "counts": {
                "registrations": formal.count(),
                "approvedRegistrations": formal.filter(pre_status="approved").count(),
                "materials": 0,
                "rounds": 0,
                "scores": 0,
                "ballots": 0,
                "releases": 0,
            },
            "excluded": {
                "testRegistrations": excluded,
                "testScores": 0,
                "testBallots": 0,
                "testMaterials": 0,
            },
            "unsupported": [],
        }
        target = Path(options["output"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(bundle, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
        self.stdout.write(self.style.SUCCESS(f"Wrote {target}"))
```

- [ ] **Step 4: Run the test and commit**

```powershell
uv run pytest common/test_plus_bundle.py -q
git add common/management/commands/export_plus_bundle.py common/test_plus_bundle.py
git commit -m "feat(legacy): export v1 activities as import bundles"
```

Also create `plus/packages/runtime/src/legacy-bundle.ts` with the TypeScript interfaces mirroring the JSON above (Activity/Question/Rubric/Round/Registration/Material/Panel/Seat/Performance/Score/Ranking/VoteSession/Ballot/StageResult/Release/Counts/Excluded/Unsupported), and export it from `runtime/src/index.ts`. No behavior yet.

---

### Task 2: Import core — activity, release, registrations, roster, materials

**Files:**
- Modify: `plus/packages/runtime/src/legacy-bundle.ts` (validation)
- Create: `plus/packages/runtime/src/legacy-import-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Create: `plus/packages/runtime/test/fixtures/legacy-bundle.json`
- Test: `plus/packages/runtime/test/legacy-import.test.ts`

- [ ] **Step 1: Write the fixture**

Create a small bundle with: publicCode `LEG-1`, one round `round-1`, one rubric criterion `总分`, two registrations (one approved, one rejected), roster `unknown`, no materials. This mirrors a registration-stage activity.

- [ ] **Step 2: Write the failing import test**

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { closeDb, createDb, migrate, listApprovedParticipantIds, getRoster } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importLegacyBundle } from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
const schema = `artflow_legacy_import_${Date.now()}_${process.pid}`;
const bundle = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/legacy-bundle.json", import.meta.url)), "utf8"));

let db: Kysely<Database>;
let admin: Client;
const deps: RuntimeDeps = { now: () => new Date().toISOString(), newEventId: () => crypto.randomUUID() };

describe.skipIf(!connectionString)("legacy import", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });
  afterAll(async () => {
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("imports activity, release, registrations, and reports reconciliation", async () => {
    const result = await importLegacyBundle(db, deps, {
      commandId: "legacy-import-1",
      bundle,
      dryRun: false,
    });
    expect(result.report.imported.registrations).toBe(2);
    expect(result.report.checks.every((check) => check.ok)).toBe(true);
    const activity = await db.selectFrom("activity").selectAll().where("public_code", "=", "LEG-1").executeTakeFirstOrThrow();
    expect(activity.status).toBe("active");
    expect(await listApprovedParticipantIds(db, activity.id)).toHaveLength(1);
    expect(await getRoster(db, activity.id)).toMatchObject({ status: "unknown" });
    const rows = await db.selectFrom("registration").selectAll().where("activity_id", "=", activity.id).execute();
    expect(rows.map((row) => row.status).sort()).toEqual(["approved", "rejected"]);
  });

  it("replays the same bundle without duplicating rows", async () => {
    const first = await importLegacyBundle(db, deps, { commandId: "legacy-import-2", bundle, dryRun: false });
    const replay = await importLegacyBundle(db, deps, { commandId: "legacy-import-2", bundle, dryRun: false });
    expect(replay.report.bundleHash).toBe(first.report.bundleHash);
    const count = await db.selectFrom("registration").select(({ fn }) => fn.countAll<number>().as("count"))
      .where("activity_id", "=", first.report.activityId).executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(2);
  });

  it("rolls back when the declared counts do not match", async () => {
    const tampered = {
      ...bundle,
      activity: { ...bundle.activity, publicCode: "LEG-2" },
      source: { ...bundle.source, publicCode: "LEG-2" },
      counts: { ...bundle.counts, registrations: 99 },
    };
    await expect(importLegacyBundle(db, deps, { commandId: "legacy-import-bad", bundle: tampered, dryRun: false }))
      .rejects.toMatchObject({ code: "LEGACY_RECONCILIATION_FAILED" });
    const found = await db.selectFrom("activity").select("id").where("public_code", "=", "LEG-2").executeTakeFirst();
    expect(found).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/legacy-import.test.ts
```

Expected: FAIL — `importLegacyBundle` is not exported.

- [ ] **Step 4: Implement the import core**

In `legacy-bundle.ts`, add `parseLegacyBundle(value: unknown): LegacyBundle` that throws `DomainError("LEGACY_BUNDLE_INVALID", ...)` for wrong format/version/missing arrays and checks reference integrity (`registrationLegacyId` exists, vote option refs exist).

In `legacy-import-service.ts`:

```typescript
export interface ImportLegacyInput {
  readonly commandId: string;
  readonly bundle: unknown;
  readonly dryRun: boolean;
}

export interface LegacyImportReport { /* imported/excluded/unsupported/checks/bundleHash/activityId */ }
```

Implementation outline:

1. `const bundle = parseLegacyBundle(input.bundle);`
2. `const bundleHash = stableHash(bundle);`
3. If `dryRun`: validate references and return planned counts (no transaction).
4. `executeCommand` with `commandType: "activity.legacy.import"`, capability `"engine"`, payload `{ bundleHash, publicCode }`.
5. Inside the transaction:
   - Reject if an activity with the public code exists.
   - `activityId = \`legacy-act-${bundle.activity.publicCode}\``.
   - Build questionnaire artifact and competition artifact from the bundle.
   - Insert activity (direct `insertInto("activity")` with public_code, status `closed` if `bundle.results.releases.some(status==="active")` else `active`, enabled capabilities `["competition","registration","questionnaire","materials"]`, active_definition_version 1).
   - `insertRelease(trx, { capabilities: { competition: plan, questionnaire: plan, registration: plan, materials: plan }, capabilityVersions: {competition:"1", questionnaire:"1", registration:"1", materials:"1"}, executionPolicy: {declaredScopes:["judging"], conflicts:{}, runtimeContractVersion:1} })`.
   - For each registration: `insertRegistration` with id `legacy-reg-<legacyId>`, participantId `bundle.registrations[].participantKey`, questionnaireVersion/hash from the artifact, status mapped (same strings), answers, revision 1.
   - Roster: if `bundle.roster.status === "final"`, verify approved count equals imported approved count, then `upsertRoster(trx, activityId, {status:"final", revision:1, approvedCount, finalizedAt}, 0)`. Otherwise leave unknown (no row).
   - Materials: `insertMaterial` with id `legacy-material-<legacyId>`, storageKey `legacy:<legacyId>`, ownerActorId `legacy`, status mapped, review fields.
   - Call `importCompetition` (Task 3 stub initially), `importVoting`/`importResults` (Task 4 stubs).
   - Append `LegacyBundleImported` event with counts/hash.
   - Reconcile: query counts in v2 and compare to `bundle.counts` for the entities imported so far; push checks. If any check fails, throw `LEGACY_RECONCILIATION_FAILED`.
6. Return `{ report }`.

Reconciliation helper:

```typescript
function check(name: string, actual: number | string, expected: number | string): LegacyImportCheck {
  return { name, ok: String(actual) === String(expected) };
}
```

- [ ] **Step 5: Run the tests and commit**

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/legacy-import.test.ts
git add plus/packages/runtime/src/legacy-bundle.ts plus/packages/runtime/src/legacy-import-service.ts plus/packages/runtime/src/index.ts plus/packages/runtime/test/legacy-import.test.ts plus/packages/runtime/test/fixtures/legacy-bundle.json
git commit -m "feat(legacy): import activity, release, registrations, and roster"
```

---

### Task 3: Competition facts

**Files:**
- Modify: `plus/packages/runtime/src/legacy-import-service.ts`
- Modify: `plus/packages/runtime/test/fixtures/legacy-bundle.json` (add a locked round with scores)
- Modify: `plus/packages/runtime/test/legacy-import.test.ts`

- [ ] **Step 1: Extend the fixture and test**

Add one round, one panel with one member/seat, one locked performance for the approved registration, one score (criteria `{"总分": 91.5}`), and a ranking. Extend the test to assert `score_fact` rows (`mode=formal`, total 91.50), round state locked, and that reconciliation checks include `scores.byRound`.

- [ ] **Step 2: Watch it fail**

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/legacy-import.test.ts
```

Expected: FAIL — competition rows are not written.

- [ ] **Step 3: Implement `importCompetition(trx, bundle, activityId, releaseVersion)`**

- Insert rounds via `insertRound` with id `legacy-round-<legacyId>`, `roundKey` from the bundle, state from the bundle, `releaseVersion`, judge/minimum/completion/scoring/advanceCount, `currentPanelId` set after the panel insert.
- For each panel: insert `panel_snapshot` (id `legacy-panel-<id>`, current=true, state active), panel members, seats. If a round has no panel, synthesize one member/seat per distinct judge in its scores.
- Performances: if the bundle has them, insert with `state=locked`, `contextVersion=1` and a locked `performance_score_state`. If missing, synthesize one per contestant in the round's scores with `sequence` from registration order, and a matching score state.
- Score facts: `insertScoreFact` with id `legacy-score-<legacyId>`, mode `formal`, source mapped, total, criteria, version 1, current true, timestamp from bundle.
- Rankings: if the bundle has them, `insertRankingSnapshot` with mode formal, revision from bundle, rows/tieGroups. Else compute from facts with `computeRanking({rows, tiePolicy:"review"})` and insert.
- Add reconciliation checks: `scores.byRound` (count per round) and `rankings.count`.

- [ ] **Step 4: Run tests and commit**

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/legacy-import.test.ts
git add plus/packages/runtime/src/legacy-import-service.ts plus/packages/runtime/test/legacy-import.test.ts plus/packages/runtime/test/fixtures/legacy-bundle.json
git commit -m "feat(legacy): import competition rounds, scores, and rankings"
```

---

### Task 4: Voting and published results

**Files:**
- Modify: `plus/packages/runtime/src/legacy-import-service.ts`
- Modify: fixture + test; create `plus/apps/api/test/legacy-results.test.ts`

- [ ] **Step 1: Extend the fixture and write failing assertions**

Add a closed vote session with two options and two anonymous ballots, plus a confirmed stage result and an active result release whose snapshot is `{ activityTitle, publicTitle, stageKey: "final_podium", decisions, awards }`. In the runtime test assert `vote_session.mode === "formal"`, ballots count 2, and `result_release.status === "active"`. In a new API test, build the app, import the bundle, and `GET /api/public/results/LEG-1` returns the snapshot.

- [ ] **Step 2: Watch it fail**

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/legacy-import.test.ts
pnpm -C plus --filter @artflow-plus/api exec vitest run test/legacy-results.test.ts
```

- [ ] **Step 3: Implement `importVoting` and `importResults`**

- `insertVoteSession` with id `legacy-vote-<id>`, `definitionVersion`, `mode="formal"`, `status="closed"`, scoringRule from bundle, revision 1, opened/closed timestamps.
- `insertVoteOptions` with ids `legacy-option-<id>`.
- Ballots: `trx.insertInto("ballot")` with id `legacy-ballot-<id>`, `identity_type="anonymous"`, `submitted_at`; vote records per option id `legacy-voterecord-<ballot>-<option>`.
- Results: `insertStageResult` (confirmed, candidate/source revision 1, fingerprint bundle hash, decisions/awards, confirmedAt), `insertResultPublication`, `insertResultRelease` (active, snapshot, resultVersion 1, postVersion 1, inputFingerprint bundle hash, releasedAt).
- Reconciliation: `ballots.total`, `ballots.byOption`, `releases.snapshotHash` (stableHash of the snapshot JSON).

- [ ] **Step 4: Run tests and commit**

```powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/legacy-import.test.ts
pnpm -C plus --filter @artflow-plus/api exec vitest run test/legacy-results.test.ts
git add plus/packages/runtime/src/legacy-import-service.ts plus/packages/runtime/test/fixtures/legacy-bundle.json plus/packages/runtime/test/legacy-import.test.ts plus/apps/api/test/legacy-results.test.ts
git commit -m "feat(legacy): import ballots and published results"
```

---

### Task 5: CLI, idempotency, docs, full gate

**Files:**
- Create: `plus/apps/api/scripts/import-legacy.ts`
- Modify: `plus/apps/api/package.json` (script `import:legacy`)
- Docs: ADR-0021, roadmap, README, review checklist
- Create: `plus/apps/web/e2e/legacy-results.spec.ts` (import the fixture at test setup or use a seeded bundle)

- [ ] **Step 1: CLI**

```typescript
import { readFile } from "node:fs/promises";
import { createDb, closeDb, migrate } from "@artflow-plus/db";
import { defaultRuntimeDeps, importLegacyBundle } from "@artflow-plus/runtime";

const [bundlePath] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (bundlePath === undefined) throw new Error("Usage: import-legacy <bundle.json> [--dry-run] [--report out.json]");
const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (!connectionString) throw new Error("ARTFLOW_PLUS_DATABASE_URL is required.");
const db = createDb({ connectionString });
await migrate(db);
const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
const result = await importLegacyBundle(db, defaultRuntimeDeps(), {
  commandId: `legacy-import-${stableHash(bundle).slice(0, 32)}`,
  bundle,
  dryRun: process.argv.includes("--dry-run"),
});
console.log(JSON.stringify(result.report, null, 2));
await closeDb(db);
```

- [ ] **Step 2: E2E**

Create `plus/apps/api/scripts/seed-legacy.ts`: read `test/fixtures/legacy-bundle.json`,
clone it with `activity.publicCode`/`source.publicCode` = `LEG-<Date.now()>`, import,
and write `{ publicCode }` to `plus/apps/web/.e2e-legacy.json`. Add it to the
`seed:e2e` chain after `seed-live.ts`. The spec reads the handoff, opens
`/results/<publicCode>`, and asserts the snapshot title/decisions. A unique public
code per run keeps repeated E2E runs from colliding.

- [ ] **Step 3: Docs**

ADR-0021 (two-step bundle, facts-not-rules, reconciliation, unsupported constructs), roadmap M8e-2 complete, README section, review checklist, KB ADR-098 + pitfalls.

- [ ] **Step 4: Full gate**

```powershell
uv run pytest common/test_plus_bundle.py -q
pnpm -C plus run check
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus run test
pnpm -C plus --filter @artflow-plus/web test:e2e
pwsh -NoProfile -File scripts/check_docs.ps1
```

- [ ] **Step 5: Merge and push**

```powershell
git checkout artflow-plus
git merge --no-ff feat/plus-m8e2-legacy-import -m "merge: M8e-2 legacy import"
git push origin artflow-plus
gh run watch <run-id> --exit-status
```
