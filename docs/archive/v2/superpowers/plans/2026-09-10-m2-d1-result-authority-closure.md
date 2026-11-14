# M2-D1 Result Authority & Event-Day Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` for inline execution. `AGENTS.md` requires the primary agent to inspect, edit, test, verify, commit, merge, and push directly; do not spawn or delegate to subagents.

**Goal:** Build a single, auditable internal result-closure contract that distinguishes candidates from confirmed results, exposes every blocking reason, and keeps stale or unlocked results out of official artifacts.

**Architecture:** Keep the existing `StageResult`/`confirm_stage_result()` authority model and add a read-only closure domain value around it. Reuse the frozen ruleset, current fingerprint, consumed-fact, dependency, Award, and round-entry rules instead of duplicating them in views. Add a small Staff closure surface and route all official-result readers through shared current-authority query helpers; public `PublicPost` release remains outside M2-D1.

**Tech Stack:** Django/Python, PostgreSQL transactions and row locks, Django `TestCase`/`TransactionTestCase`, existing `AuditLog`, server-rendered templates, Pyright, Ruff, npm client gates, PowerShell documentation checks.

**Spec:** `docs/superpowers/specs/2026-09-10-m2-d1-result-authority-event-day-closure-design.md`

## Global Constraints

- `READY_TO_CONFIRM` is a candidate; only `StageResult.status == CONFIRMED` is internal formal result authority.
- Only the current maximum `result_version` for an activity/stage, current frozen `RulesetVersion`, matching authority hash, and matching current `input_fingerprint` may be confirmable.
- Raw facts consumed by a confirmed result remain immutable until an audited administrator unlocks the result through `unlock_stage_result()`.
- `PublicPost.PUBLISHED` is not `StageResult.RELEASED`; M2-D1 must not add or imply a public release state.
- Preflight is read-only and must not create results, Awards, round entries, locks, or audit rows.
- Client-supplied activity, stage, result, ruleset, fingerprint, singer, seat, and operator context are never authority sources.
- All cross-object reads are activity-scoped and must reject cross-activity relations and stale candidates.
- Do not commit secrets, tokens, uploaded media, generated exports, SQLite databases, or Docker volume data.
- Every logical change is a small conventional commit with its focused gate run before the commit.
- Production Python changes require both `npm run check:pyright` and `npm run check:pyright:entry-access` to report zero diagnostics.
- Docker/PostgreSQL evidence is required for concurrency/recovery claims; SQLite or static inspection cannot substitute for it.

---

## File Map

| File | Responsibility |
| --- | --- |
| `singer_contest/services.py` | Add typed closure DTOs, stable blocker codes, read-only closure computation, and the shared current-authority query helper; tighten confirmation idempotency ordering. |
| `singer_contest/tests.py` | Unit/service regression coverage for closure states, stale candidates, blocker codes, confirmation and unlock interactions. |
| `staff_panel/views.py` | Add the authenticated read-only closure view and use the shared official-result query helper for Staff Award display. |
| `staff_panel/urls.py` | Register the closure URL without changing existing confirm/unlock POST routes. |
| `templates/staff_panel/activity_result_board.html` | Link the result board to closure preflight and display status/blocked summaries without exposing sensitive facts. |
| `templates/staff_panel/activity_result_closure.html` | Render the read-only event-day closure checklist, stage rows, blocker codes, and audit-safe identifiers. |
| `exports/services.py` | Use the shared official Award queryset so exports and Staff lists cannot diverge. |
| `staff_panel/tests.py` | View, template, list/export filtering, IDOR, and operator-facing error regression coverage. |
| `docs/production-readiness.md` | Record M2-D1 closure contract, evidence fields, and rehearsal expectations. |
| `docs/production-rehearsal-runbook.md` | Add the exact event-day preflight/confirm/recheck sequence and failure handling. |
| `docs/school-onboarding.md` | Clarify that local closure evidence does not satisfy external school identity, edge protection, retention, or recovery evidence. |

No database migration is planned. If an implementation step proves a new persisted field unavoidable, stop before changing models, document the field and rollback/backfill behavior in the plan, and run migration review as a separate commit.

## Task 1: Define typed closure values and stable blocker codes

**Files:**
- Modify: `singer_contest/services.py` near the existing result resolver/confirmation helpers at lines `1700-2100` and `2460-2635`
- Test: `singer_contest/tests.py` after `StageResultModelTests`

**Interfaces:**
- Produces `ResultClosureCode(StrEnum)` with exactly `NO_CURRENT_FROZEN_RULESET`, `RULESET_BINDING_INVALID`, `RAW_FACTS_INCOMPLETE`, `RAW_FACTS_UNLOCKED`, `RULE_REVIEW_REQUIRED`, `UPSTREAM_CONFIRMATION_PENDING`, `STALE_CANDIDATE`, `STAGE_CONFIRMATION_PENDING`, `ACTIVITY_OPERATIONALLY_LOCKED`, and `SCHOOL_EXTERNAL_EVIDENCE_PENDING`.
- Produces frozen dataclasses:

```python
@dataclass(frozen=True)
class StageClosure:
    stage_key: str
    current_result_id: int | None
    result_version: int | None
    status: str | None
    confirmable: bool
    reasons: tuple[str, ...]
    input_fingerprint: str | None
    required_raw_facts: dict[str, tuple[int, ...]]
    raw_facts_locked: bool
    upstream_confirmed: bool
    official_awards: int
    round_entries: int
    blocking_reasons: tuple[ResultClosureCode, ...]

@dataclass(frozen=True)
class ResultClosure:
    activity_id: int
    ruleset_version_id: int | None
    ruleset_authority_hash: str | None
    stages: tuple[StageClosure, ...]
    closeable: bool
    blocking_reasons: tuple[ResultClosureCode, ...]
```

- Produces `build_result_closure(activity, *, stage_key: str | None = None) -> ResultClosure` as a read-only service entry point.
- Produces `official_stage_award_queryset(activity)` as the single shared queryset for stage-sourced official Awards; it must retain manual Awards and include only source rows whose StageResult is current, same-activity, `CONFIRMED`, and linked through a valid source decision.

- [ ] **Step 1: Write failing value-shape tests.** Add tests named `test_result_closure_dataclasses_are_immutable`, `test_result_closure_codes_are_stable_strings`, and `test_closure_does_not_contain_token_or_private_payload_fields`.

- [ ] **Step 2: Run the focused tests and verify failure.**

Run:

```powershell
python manage.py test singer_contest.tests.StageResultModelTests -v 2
```

Expected: FAIL because the new DTOs and codes do not exist.

- [ ] **Step 3: Add the enum and dataclasses with explicit annotations.** Import `dataclass`, `StrEnum`, and the existing typing aliases. Do not use `dict[str, Any]` for the DTO fields above; use the concrete tuple/dict types and keep `blocking_reasons` ordered by the code declaration.

- [ ] **Step 4: Add the safe serializer.** Implement `result_closure_as_dict(closure: ResultClosure) -> dict[str, object]`; convert enum members to `.value`, tuple collections to JSON-safe lists, and never add model instances or full reasons payloads. The Staff view will pass this dictionary to the template.

- [ ] **Step 5: Run the focused tests and type checks.**

Run:

```powershell
python manage.py test singer_contest.tests.StageResultModelTests -v 2
npm run check:pyright
npm run check:pyright:entry-access
```

Expected: PASS with zero Pyright diagnostics.

- [ ] **Step 6: Commit the typed contract.**

```powershell
git add singer_contest/services.py singer_contest/tests.py
git commit -m "feat: define result closure authority types"
```

## Task 2: Implement read-only closure computation

**Files:**
- Modify: `singer_contest/services.py` beside `_current_input_fingerprint()`, `_ensure_stage_dependencies_final()`, `_stage_consumed_facts()`, and `_current_frozen_version()`
- Test: `singer_contest/tests.py` in a new `ResultClosureServiceTests(TestCase)` using the existing activity/ruleset factory patterns

**Interfaces:**
- Consumes existing helpers `_current_frozen_version`, `_version_binding`, `_definition_checkpoints_ordered`/`_definition_checkpoint_keys`, `_current_input_fingerprint`, `_stage_consumed_facts`, and `StageResult`/raw fact querysets.
- Produces `build_result_closure()` from Task 1; it must never call `persist_stage_result`, `recompute_activity_result`, `materialize_stage_awards`, `materialize_round_entry_from_stage`, or any lock/write helper.

- [ ] **Step 1: Write the failing complete-state test.** Create a frozen ruleset and a current `READY_TO_CONFIRM` StageResult with matching fingerprint and locked consumed facts. Assert `closeable is False`, the stage is `confirmable is True`, and the only activity blocker is `STAGE_CONFIRMATION_PENDING`.

- [ ] **Step 2: Write failing blocker tests for missing rule/input states.** Add tests named `test_closure_reports_no_current_frozen_ruleset`, `test_closure_reports_invalid_binding_without_cross_activity_reads`, `test_closure_reports_missing_raw_facts`, `test_closure_reports_unlocked_raw_facts`, `test_closure_reports_review_result`, and `test_closure_reports_unconfirmed_upstream`.

- [ ] **Step 3: Write failing stale/version tests.** Add `test_closure_marks_old_result_version_stale`, `test_closure_marks_fingerprint_mismatch_stale`, `test_closure_marks_non_current_ruleset_stale`, and `test_closure_does_not_reuse_historical_same_fingerprint_row`.

- [ ] **Step 4: Implement the stage-key selection explicitly.** When `stage_key` is supplied, inspect only that stage after verifying it belongs to the activity. Otherwise use frozen checkpoint keys in definition order; if there are no checkpoints use the frozen binding’s `stage_key`. If no current frozen version exists, return an empty stage tuple and `NO_CURRENT_FROZEN_RULESET` rather than guessing from the mutable ruleset.

- [ ] **Step 5: Implement each blocker in a deterministic order.** For each stage: select the maximum `result_version`; derive consumed raw-fact IDs from the same activity; compare the stored fingerprint to `_current_input_fingerprint()`; inspect raw lock flags; inspect `REVIEW`/`HOLD`; validate upstream confirmed results; then mark `READY_TO_CONFIRM` confirmable only if no blocker remains. A `CONFIRMED` current row is internally complete and contributes no pending confirmation blocker.

- [ ] **Step 6: Count official artifacts without leaking details.** Count only `Award` rows returned by `official_stage_award_queryset(activity)` and only round entries in the stage’s same-activity target round. Do not load singer names, score values, notes, vote payloads, bearer data, or private judge fields into the DTO.

- [ ] **Step 7: Prove the function is read-only.** Wrap a closure call in `CaptureQueriesContext`, assert no `INSERT`, `UPDATE`, `DELETE`, or `SELECT ... FOR UPDATE` occurs, and assert counts of StageResult, Award, RoundEntry, and AuditLog are unchanged.

- [ ] **Step 8: Run focused service tests.**

```powershell
python manage.py test singer_contest.tests.ResultClosureServiceTests -v 2
```

Expected: PASS for all blocker, stale, activity-scope, and read-only cases.

- [ ] **Step 9: Commit the read-only service.**

```powershell
git add singer_contest/services.py singer_contest/tests.py
git commit -m "feat: add result closure preflight service"
```

## Task 3: Harden confirmation and official-source selection

**Files:**
- Modify: `singer_contest/services.py:2462-2635`
- Modify: `staff_panel/views.py:2067-2073`
- Modify: `exports/services.py:487-496`
- Test: `singer_contest/tests.py` around existing confirmation/unlock tests
- Test: `staff_panel/tests.py` around `ResultBoardTests` and Award export tests

**Interfaces:**
- Consumes `official_stage_award_queryset(activity)` from Task 1.
- Keeps `confirm_stage_result(stage: StageResult, *, confirmed_by) -> StageResult` and `unlock_stage_result(stage: StageResult, *, operator, note: str = "") -> StageResult` as the only write APIs.

- [ ] **Step 1: Write a failing stale-confirmation regression.** Add `test_confirm_rejects_confirmed_row_that_is_no_longer_current` by creating a confirmed stage and a newer same-stage candidate under the test authority context. Assert the old row cannot be treated as the current idempotent success and no new Award is materialized from it.

- [ ] **Step 2: Write failing official-source tests.** Add `test_award_list_excludes_non_current_confirmed_source`, `test_award_export_excludes_unconfirmed_source`, `test_award_export_keeps_manual_award`, and `test_unlocked_source_award_is_not_official`.

- [ ] **Step 3: Move current-result checks before confirmed idempotency.** In `confirm_stage_result`, after locking and re-reading the activity/StageResult, verify activity ownership, current frozen version, maximum `result_version`, and current input fingerprint before returning an already confirmed row. A confirmed row that fails those checks raises the existing validation error instead of being accepted as a current result.

- [ ] **Step 4: Implement the shared official Award queryset.** Enforce same activity on Award, singer, source StageResult, and source StageAwardDecision; keep manual Awards where `source_stage_result IS NULL`; for stage-sourced Awards require current maximum result version and `CONFIRMED` source status. Use this helper in both Staff list and XLSX export.

- [ ] **Step 5: Preserve confirmation transaction behavior.** Confirmed state, audit, Award materialization, and round-entry materialization must remain inside the existing transaction. Do not add a second transaction boundary or direct queryset update that bypasses authority contexts.

- [ ] **Step 6: Run focused tests.**

```powershell
python manage.py test singer_contest.tests.StageResultModelTests singer_contest.tests.RecomputeActivityResultConcurrencyTests -v 2
python manage.py test staff_panel.tests.ResultBoardTests -v 2
python manage.py test staff_panel.tests.ExportPrivacyTests -v 2
```

Expected: PASS; the award-list export assertions are covered by the existing `ExportPrivacyTests` class.

- [ ] **Step 7: Run Pyright and commit.**

```powershell
npm run check:pyright
npm run check:pyright:entry-access
git add singer_contest/services.py singer_contest/tests.py staff_panel/views.py staff_panel/tests.py exports/services.py
git commit -m "fix: enforce current result authority for awards"
```

## Task 4: Add the Staff closure read surface

**Files:**
- Modify: `staff_panel/views.py` after `activity_result_board()`
- Modify: `staff_panel/urls.py` beside the result-board route
- Modify: `templates/staff_panel/activity_result_board.html`
- Create: `templates/staff_panel/activity_result_closure.html`
- Test: `staff_panel/tests.py` in a new `ResultClosureViewTests(TestCase)`

**Interfaces:**
- View: `activity_result_closure(request, activity_id)` accepts GET only, requires `@staff_required`, fetches the activity with `get_object_or_404`, calls `build_result_closure(activity)`, and renders `staff_panel/activity_result_closure.html`.
- URL: `activity/<int:activity_id>/result-closure/`, name `activity_result_closure`.
- Template context: `activity`, `closure`, and `blocking_labels`; no raw model querysets or secrets.

- [ ] **Step 1: Write failing access and response tests.** Add `test_closure_view_requires_staff`, `test_closure_view_is_get_only`, `test_closure_view_is_activity_scoped`, `test_closure_view_shows_ready_confirmation`, and `test_closure_view_shows_stale_and_unlocked_blockers`.

- [ ] **Step 2: Implement the GET-only view and route.** Use `@staff_required` and `@require_GET`. Do not accept `stage_key`, `result_id`, `ruleset_id`, or closure status from query parameters; the initial view renders the complete activity closure. The lookup must be by activity path parameter only.

- [ ] **Step 3: Render a minimal safe checklist.** The template must show stage key, status label, current result version, confirmable/blocked state, blocker codes with Chinese labels, current authority hash prefix only if existing Staff policy permits it, and counts of official artifacts. Do not render full `reasons`, input fingerprints, student IDs, scores, judge notes, session tokens, request headers, or exception tracebacks.

- [ ] **Step 4: Link the existing result board.** Add one GET link using `{% url 'staff:activity_result_closure' activity_id=activity.pk %}`. Preserve existing confirm/unlock POST forms and CSRF tokens unchanged.

- [ ] **Step 5: Test IDOR and no-write behavior.** Use two activities and a staff user; request activity A while trying to inject activity B through query parameters and assert only A is rendered. Assert the GET does not create/update StageResult, Award, RoundEntry, or AuditLog rows.

- [ ] **Step 6: Run focused web tests and commit.**

```powershell
python manage.py test staff_panel.tests.ResultClosureViewTests staff_panel.tests.ResultBoardTests -v 2
python manage.py check
git diff --check
git add staff_panel/views.py staff_panel/urls.py templates/staff_panel/activity_result_board.html templates/staff_panel/activity_result_closure.html staff_panel/tests.py
git commit -m "feat: add staff result closure checklist"
```

## Task 5: Complete unlock, audit, and school-boundary semantics

**Files:**
- Modify: `singer_contest/services.py:2592-2635`
- Test: `singer_contest/tests.py` existing unlock tests and new audit cases
- Modify: `docs/production-readiness.md`
- Modify: `docs/production-rehearsal-runbook.md`
- Modify: `docs/school-onboarding.md`

**Interfaces:**
- Keeps `unlock_stage_result()` as the only unlock command.
- Adds no new public release status and no new school integration claim.

- [ ] **Step 1: Write failing unlock reason/audit tests.** Add `test_unlock_requires_non_empty_reason`, `test_unlock_audits_stage_and_consumed_facts`, `test_unlock_rejects_shared_confirmed_consumption`, and `test_unlock_removes_source_award_from_official_reads`.

- [ ] **Step 2: Implement strict reason validation.** Strip `note` inside the service, reject empty/whitespace-only reasons before mutating the StageResult, and include the non-secret reason in the existing unlock audit entry. Keep the existing administrator verification and downstream-started guard.

- [ ] **Step 3: Verify post-unlock closure behavior.** After the existing state transition and fact release, the next `build_result_closure()` call must report `STALE_CANDIDATE` or `STAGE_CONFIRMATION_PENDING` as applicable; it must not report the old source as officially complete. Re-resolve must create a new result version and confirmation must be required again.

- [ ] **Step 4: Update readiness documentation.** Add M2-D1 evidence fields: closure start/end timestamps, per-stage result version and fingerprint prefix, confirmation audit IDs, blocker counts, duplicate/concurrent request counts, stale-source leakage count, and gate results. State that local closure does not prove SSO/MFA/WAF/TLS/DDoS/backup/retention readiness.

- [ ] **Step 5: Run focused tests and docs validation.**

```powershell
python manage.py test singer_contest.tests.StageResultModelTests singer_contest.test_authority_closure.AuthorityClosureAcceptanceTests -v 2
pwsh -NoProfile -File scripts/check_docs.ps1
```

Expected: PASS for the existing `AuthorityClosureAcceptanceTests` authority-closure suite.

- [ ] **Step 6: Commit unlock and documentation changes separately from code surface changes.**

```powershell
git add singer_contest/services.py singer_contest/tests.py
git commit -m "fix: require audited reasons for result unlock"
git add docs/production-readiness.md docs/production-rehearsal-runbook.md docs/school-onboarding.md
git commit -m "docs: define m2-d1 closure evidence"
```

## Task 6: Add adversarial coverage and production rehearsal evidence

**Files:**
- Modify: `singer_contest/tests.py`
- Modify: `staff_panel/tests.py`
- Modify: `common/test_authority_matrix.py` if a cross-app ORM path is uncovered
- Create or modify: `scripts/m2_d1_result_closure_rehearsal.mjs` only if the existing rehearsal harness can reuse its runner; otherwise add a focused script with the same bounded local-service conventions
- Modify: `docs/production-readiness.md`
- Create: `docs/m2-d1-result-closure-matrix.md`

**Interfaces:**
- The rehearsal must use a test activity and bounded local concurrency; it must never target an external school/public service or reset source Docker volumes.
- Quantitative report fields: total requests, concurrency, p50/p95/p99 latency, 2xx/4xx/5xx, timeout count, duplicate-confirm count, stale-rejection count, cross-activity rejection count, token/secret leakage count, and official-source leakage count.

- [ ] **Step 1: Add Django malicious cases.** Cover stale result IDs, stale fingerprints, wrong ruleset version, cross-activity Award/source decision, replayed confirm POST, concurrent confirmation, concurrent unlock/recompute, old source export, and closure GET with forged query parameters.

- [ ] **Step 2: Add PostgreSQL-only concurrency tests.** Use `TransactionTestCase` with two database connections for concurrent confirm and confirm-vs-unlock. Assert at most one confirmation audit, one official Award per source decision, no orphaned confirmed trail, and no stale source in the official queryset.

- [ ] **Step 3: Add the bounded rehearsal script.** The script must call only local `127.0.0.1`/configured local base URL, use finite request counts, avoid bearer logging, and exit nonzero if any 5xx, timeout, duplicate official source, cross-activity success, stale acceptance, or token/secret appearance is observed. It must print the metric names from this task.

- [ ] **Step 4: Run the script against the running local service.** Record Docker/web availability first. If Docker is unavailable, run non-PostgreSQL read-only checks and mark PostgreSQL/concurrency/recovery evidence `BLOCKED`; do not call the run PASS.

- [ ] **Step 5: Update the rehearsal matrix and report.** Include setup, exact bounded load, observed values, expected thresholds, deviations, remediation, and Plan B. Separate local application evidence from external school responsibility evidence.

- [ ] **Step 6: Commit the adversarial evidence.**

```powershell
git add singer_contest/tests.py staff_panel/tests.py common/test_authority_matrix.py scripts/m2_d1_result_closure_rehearsal.mjs docs/m2-d1-result-closure-matrix.md docs/production-readiness.md
git commit -m "test: rehearse m2-d1 result closure attacks"
```

## Task 7: Full verification, two self-review rounds, and handoff

**Files:**
- Modify only if verification discovers a documented defect; otherwise no source changes

- [ ] **Step 1: Run the focused gates in commit order.**

```powershell
python manage.py test singer_contest.tests.ResultClosureServiceTests singer_contest.tests.StageResultModelTests -v 2
python manage.py test staff_panel.tests.ResultClosureViewTests staff_panel.tests.ResultBoardTests -v 2
python manage.py check
python manage.py makemigrations --check --dry-run
npm run check:pyright
npm run check:pyright:entry-access
npm run check:client
npm run test:client
npm run check:css
pwsh -NoProfile -File scripts/check_docs.ps1
```

- [ ] **Step 2: Run the full Django suite.**

```powershell
python manage.py test
```

Expected: no failures; report skips explicitly.

- [ ] **Step 3: Run PostgreSQL acceptance and browser smoke when Docker is available.**

```powershell
pwsh -NoProfile -File scripts/verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
npx playwright install chromium
npm run test:e2e
pwsh -NoProfile -File scripts/verify_postgres_backup_restore.ps1 -ComposeProjectName artflow -BackupPath backups/artflow-m2-d1-rehearsal.dump
```

The backup/restore command must use a separate restore target and must not execute `docker compose down --volumes`, reset, or drop the source database/volumes.

- [ ] **Step 4: Perform self-review round one.** Compare every spec section to the plan: authority layers, current candidate, preflight blocker codes, confirm/unlock invariants, activity-day sequence, privacy, school boundary, tests, gates, and evidence. If a spec item lacks a task, add the task before implementation begins.

- [ ] **Step 5: Perform self-review round two.** Search for all callers of `StageResult`, `Award`, `source_stage_result`, `confirm_stage_result`, and `unlock_stage_result`; inspect for stale/current divergence, cross-activity reads, transaction gaps, duplicate materialization, unredacted logs, Pyright regressions, and generated client/CSS drift. Re-run `git diff --check` and the focused tests after any fix.

- [ ] **Step 6: Record final status without overstating it.** Mark M2-D1 PASS only if all local gates and required Docker evidence pass with zero stale-source leakage and zero authority bypasses. Mark external school readiness separately HOLD when its evidence is absent.

- [ ] **Step 7: Commit only verification/documentation corrections.**

```powershell
git status --short
git diff --check
```

If no correction is needed, do not create an empty commit. Keep all logical commits small and reviewable for the eventual non-fast-forward merge into `main`.
