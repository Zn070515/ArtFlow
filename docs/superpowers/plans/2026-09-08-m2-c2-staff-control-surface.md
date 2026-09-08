# M2-C2 Staff Judge Control Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Deliver a server-rendered Staff control surface that safely drives the existing Judge Panel, performance, QR, STAFF_PROXY, and PAPER_DR authority services during a live contest.

**Architecture:** Keep all mutations inside `singer_contest.judge_authority`; add thin Staff views and forms that validate request shape, render non-sensitive operational state, and use PRG after successful POST actions. Generate Judge QR data in memory from the one-time grant returned by `issue_judge_grant`; never add a token persistence path or a second ORM write path.

**Tech Stack:** Django 6, server-rendered templates, existing `qrcode` dependency, Django `TestCase`, TypeScript/client gates unchanged, PostgreSQL Compose acceptance.

**Spec:** `docs/superpowers/specs/2026-09-08-m2-c2-staff-control-surface.md`

## Global Constraints

- Do not use `.worktree/`, linked worktrees, or subagents; work directly on the current feature branch.
- Every logical change is a small conventional commit with its focused gate run first.
- All POST control actions use `staff_required`, `require_POST`, and Django CSRF; no new `csrf_exempt`.
- Staff views must call existing authority services and must not write Panel, seat, performance, or score models directly.
- Grant tokens may appear only inside the generated QR data URI and must not be logged, put in messages, or rendered as plain text.
- Cross-round and cross-activity validation remains service-owned; views must pass IDs through the service rather than trusting page state.
- Run `npm run check:pyright` and `npm run check:pyright:entry-access` before commits containing production Python.
- Push feature commits, merge with `--no-ff` into `main`, then push `main`; retry a timed-out push through `127.0.0.1:12334`.

---

### Task 1: Add failing Staff control contracts (RED)

**Files:**

- Modify: `staff_panel/tests.py`
- Modify: `staff_panel/forms.py`
- Modify: `staff_panel/urls.py`

**Interfaces:**

- The tests will require `staff:judge_control`, `staff:judge_prepare`, `staff:judge_panel_hold`, `staff:judge_panel_resume`, `staff:judge_performance_advance`, `staff:judge_performance_hold`, `staff:judge_performance_resume`, `staff:judge_seat_qr`, `staff:judge_score_proxy`, and `staff:judge_score_paper`.
- The tests will require forms named `JudgePanelAttendanceForm`, `JudgePerformanceActionForm`, and `JudgeBoundScoreForm` with integer ID validation and bounded text fields.

- [x] **Step 1: Write the failing route and form tests.**

  Add `JudgeControlHTTPTests` with a prepared test round, one performance, one staff operator, and one judge seat. Assert route reversing and that the forms reject booleans/non-integers, blank hold reasons, scores outside 0–100, oversized notes, and missing source references/reasons.

- [x] **Step 2: Run the focused tests and verify RED.**

  Run:

  ```powershell
  python manage.py test staff_panel.tests.JudgeControlHTTPTests
  ```

  Expected result: import or reverse/form failures because the C2 routes/forms do not exist yet. Fix only test setup errors until the failure is caused by the missing C2 contract.

- [x] **Step 3: Commit the failing contract tests.**

  ```powershell
  git add staff_panel/tests.py
  git commit -m "test: define m2-c2 staff judge controls"
  ```

### Task 2: Add request forms and route declarations

**Files:**

- Modify: `staff_panel/forms.py`
- Modify: `staff_panel/urls.py`
- Test: `staff_panel/tests.py`

**Interfaces:**

- `JudgePanelAttendanceForm`: `attending_judge_ids` as a required bounded list of integer strings, normalized to a unique `list[int]`.
- `JudgePerformanceActionForm`: `performance_id` as a positive integer and `reason` as a required string of at most 240 characters for hold actions.
- `JudgeBoundScoreForm`: `performance_id`, `seat_id`, `context_version`, `score`, `source_reference`, `reason`, and `command_id`; normalize numeric values, validate score with `validate_score`, and cap source reference at 120 and reason at 240 characters.
- URL names and paths must match the spec and point to named view functions, not a catch-all action dispatcher.

- [x] **Step 1: Implement only the forms and URL declarations.**

  Keep form cleaning deterministic and reject duplicate attendance IDs before a service call. Do not add view logic in this task.

- [x] **Step 2: Run the form and route tests.**

  ```powershell
  python manage.py test staff_panel.tests.JudgeControlHTTPTests
  ```

  Expected result: form/route assertions pass; view requests still fail until Task 3.

- [x] **Step 3: Commit the scoped contract implementation.**

  ```powershell
  git add staff_panel/forms.py staff_panel/urls.py
  git commit -m "feat: add m2-c2 staff judge control contracts"
  ```

### Task 3: Build the read-only control console and Panel preparation

**Files:**

- Modify: `staff_panel/views.py`
- Create: `templates/staff_panel/judge_control.html`
- Modify: `templates/staff_panel/dashboard.html`
- Test: `staff_panel/tests.py`

**Interfaces:**

- `judge_control(request, pk)` renders a `round`, `round_judges`, `panel_snapshot`, `panel_members`, `run_state`, `performances`, `attendance_form`, and `policy_state` context.
- `judge_prepare(request, pk)` passes the cleaned attendance IDs to `prepare_judge_panel()` and redirects back with a safe message.
- The page must show expected/actual/minimum counts and `INSUFFICIENT_JUDGES / HOLD` when no active panel can be prepared; it must not offer QR/performance/score controls in that state.

- [x] **Step 1: Add a failing GET and prepare POST test.**

  Assert anonymous users redirect, participants are denied, staff can see five prepared judges, a four-of-five submission creates a four-member ACTIVE snapshot, and a three-of-five submission returns a visible HOLD message without an active snapshot.

- [x] **Step 2: Run the test and confirm the expected view/template failure.**

  ```powershell
  python manage.py test staff_panel.tests.JudgeControlHTTPTests
  ```

- [x] **Step 3: Implement read-only context and prepare POST.**

  Use `get_object_or_404`, `staff_required`, `require_POST`, `prepare_judge_panel`, and `messages`. Build panel data from `RoundPanelSnapshot`/members for display only. Do not create a second panel service.

- [x] **Step 4: Add the dashboard link and render the console.**

  Include CSRF tokens on every form, use explicit disabled states for HOLD/LOCKED, show current performance labels from `Performance.singer.name` and `song_title`, and never render bearer or grant tokens as text.

- [x] **Step 5: Run the focused page tests and commit.**

  ```powershell
  python manage.py test staff_panel.tests.JudgeControlHTTPTests
  git add staff_panel/views.py staff_panel/tests.py templates/staff_panel/judge_control.html templates/staff_panel/dashboard.html
  git commit -m "feat: add staff judge control console"
  ```

### Task 4: Add Judge QR issuance with non-sensitive rendering

**Files:**

- Modify: `staff_panel/views.py`
- Modify: `staff_panel/tests.py`
- Modify: `templates/staff_panel/judge_control.html`

**Interfaces:**

- `judge_seat_qr(request, pk, seat_id)` calls `issue_judge_grant(seat_id, operator=request.user, ttl_seconds=...)` only after confirming the seat belongs to the URL round.
- The response renders `qr_data_uri`, `seat`, and `grant_expires_at` for the current request only, using a target such as `reverse("judge:terminal")#<quoted-token>`.

- [x] **Step 1: Add failing QR tests.**

  Assert a valid ACTIVE seat returns an image data URI and a terminal fragment target without placing the raw token in response text; a seat from another round, revoked seat, HOLD panel, and duplicate unredeemed grant are rejected.

- [x] **Step 2: Run the tests and observe RED.**

  ```powershell
  python manage.py test staff_panel.tests.JudgeControlHTTPTests
  ```

- [x] **Step 3: Implement in-memory QR generation.**

  Reuse the existing `qrcode`, `BytesIO`, and base64 pattern used by ticket QR generation. Keep token-bearing data only in the QR image payload. Do not log the token or pass it through `messages`.

- [x] **Step 4: Run focused QR tests and commit.**

  ```powershell
  python manage.py test staff_panel.tests.JudgeControlHTTPTests
  git add staff_panel/views.py staff_panel/tests.py templates/staff_panel/judge_control.html
  git commit -m "feat: issue judge qr from staff control"
  ```

### Task 5: Add performance and Panel HOLD controls

**Files:**

- Modify: `staff_panel/views.py`
- Modify: `staff_panel/tests.py`
- Modify: `templates/staff_panel/judge_control.html`

**Interfaces:**

- `judge_performance_advance` calls `advance_performance(round_id, performance_id, operator=...)`.
- `judge_performance_hold` calls `hold_performance(round_id, operator=..., reason=...)`.
- `judge_performance_resume` calls `resume_performance(round_id, operator=...)`.
- `judge_panel_hold` calls `hold_judge_panel(round_id, operator=..., reason=...)`.
- `judge_panel_resume` calls `resume_judge_panel(round_id, operator=...)`.

- [x] **Step 1: Add failing transition tests.**

  Assert valid transitions update `PerformanceRunState`, increment context version when the performance changes, render current singer/song, reject a performance from another round, and reject QR/score operations while Panel or performance is held.

- [x] **Step 2: Run the tests and verify RED.**

  ```powershell
  python manage.py test staff_panel.tests.JudgeControlHTTPTests
  ```

- [x] **Step 3: Implement thin POST wrappers and explicit action forms.**

  Catch only `PermissionDenied` and `ValidationError`, convert through `domain_error_messages`, and redirect to the control console. Never continue after an authority service exception.

- [x] **Step 4: Run transition tests and commit.**

  ```powershell
  python manage.py test staff_panel.tests.JudgeControlHTTPTests singer_contest.test_judge_authority
  git add staff_panel/views.py staff_panel/tests.py templates/staff_panel/judge_control.html
  git commit -m "feat: control judge performance lifecycle"
  ```

### Task 6: Add STAFF_PROXY and PAPER_DR forms

**Files:**

- Modify: `staff_panel/views.py`
- Modify: `staff_panel/tests.py`
- Modify: `templates/staff_panel/judge_control.html`

**Interfaces:**

- `judge_score_proxy` calls `submit_staff_proxy_score()` with cleaned current round, performance, seat, context version, score payload, source reference, and reason.
- `judge_score_paper` calls `submit_paper_score()` with the same binding and paper reference.
- Both views use fresh `command_id` values from the form and show only stable reason messages on failure.

- [x] **Step 1: Add failing score action tests.**

  Assert successful records have `STAFF_PROXY`/`PAPER_DR`, the correct panel snapshot and seat, and an audit row; assert missing reason/reference, stale context, duplicate score fact, held run state, foreign seat, and cross-round performance fail without partial records.

- [x] **Step 2: Run the focused tests and verify RED.**

  ```powershell
  python manage.py test staff_panel.tests.JudgeControlHTTPTests
  ```

- [x] **Step 3: Implement wrappers and render forms.**

  Use `JudgeBoundScoreForm`, map the selected action to exactly one existing service, and redirect after success. Do not call `ScoreRecord.objects.create()` from the view.

- [x] **Step 4: Run focused tests, type gates, and commit.**

  ```powershell
  python manage.py test staff_panel.tests.JudgeControlHTTPTests singer_contest.test_judge_authority
  npm run check:pyright
  npm run check:pyright:entry-access
  git add staff_panel/views.py staff_panel/forms.py staff_panel/tests.py templates/staff_panel/judge_control.html
  git commit -m "feat: add staff proxy and paper score controls"
  ```

### Task 7: Contract review, documentation, and full verification

**Files:**

- Modify: `docs/production-readiness.md`
- Modify: `docs/superpowers/specs/2026-09-08-m2-c2-staff-control-surface.md` only if review finds a contradiction
- Modify: `AGENTS.md` only if a permanent C2 gate/rule is missing

- [x] **Step 1: Perform authority review 1.**

  Inspect every new view for direct writes, cross-round object lookup, token leakage, CSRF coverage, and error continuation. Search for `RoundPanelSnapshot.objects.create`, `JudgeSeat.objects.create`, `PerformanceRunState.objects.create`, and `ScoreRecord.objects.create` in `staff_panel` and confirm none were introduced.

- [x] **Step 2: Perform authority review 2.**

  Check duplicate QR issuance, replayed POSTs, HOLD/LOCKED transitions, stale context, foreign IDs, and whether the page can claim readiness while `INSUFFICIENT_JUDGES` or HOLD is active. Add only isolated regression fixes with their own tests.

- [x] **Step 3: Run all gates.**

  ```powershell
  python manage.py check
  python manage.py makemigrations --check --dry-run
  python manage.py test
  pwsh -NoProfile -File scripts/check_docs.ps1
  npm run check:css
  npm run check:client
  npm run test:client
  npm run check:pyright
  npm run check:pyright:entry-access
  ```

- [x] **Step 4: Run Docker/PostgreSQL and browser verification.**

  Run the PostgreSQL acceptance contract with the already-running local web service or an explicit no-host-port Compose rehearsal, preserving source volumes. Run Playwright against the control console with a staff session and verify prepare → QR → advance → hold/resume → proxy/paper action; do not claim browser success if the service is merely an unrelated process.

- [ ] **Step 5: Commit isolated docs/verification fixes, push branch, merge, and push main.**

  ```powershell
  git status --short
  git diff --check
  git push origin feat/m2-c2-staff-control-surface
  git switch main
  git pull --ff-only origin main
  git merge --no-ff feat/m2-c2-staff-control-surface -m "merge: integrate m2-c2 staff judge control"
  git push origin main
  ```
