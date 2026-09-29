# Questionnaire Rehearsal Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan inline in the current repository checkout. Do not spawn subagents or create worktrees.

**Goal:** Close the ruleset-driven questionnaire path from public registration entry through submission, material review, supplement, and the private rehearsal loader, then remove the highest-risk questionnaire validation gaps.

**Architecture:** Keep the questionnaire as the current frozen-ruleset authority for new singer registrations. Route every public/staff/QR entry through the existing registration resolver, while retaining the legacy form only when no frozen questionnaire exists. Enforce write authority in services and views using activity phase, question identity, and schema hash; never rely on template visibility.

**Tech Stack:** Django, PostgreSQL/SQLite test matrix, Django TestCase, TypeScript client, Playwright, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-28-private-test-data-usage.md` and the current questionnaire/ruleset contracts in `GOAL.md`.

## Global Constraints

- Participant writes require the current frozen questionnaire schema hash.
- Participant routes may access only FORMAL singer-contest activities; staff may preview TEST activities.
- `REGISTRATION_OPEN` allows the owner to edit submitted answers; after close, only question-keyed `NEEDS_SUPPLEMENT` material is writable.
- Questionnaire material identity is `registration + question_key`; do not reintroduce purpose-only cross-round matching.
- All score, ballot, ticket, round, file, and result mutations continue through their existing authority services.
- Private rehearsal data remains `SYNTHETIC_TEST_ONLY`; raw source Excel, ZIPs, credentials, and uploaded media never enter Git.
- Every logical change is a small conventional commit with a focused gate; no worktree or subagent is used.

### Task 1: Establish the P0 baseline and clean the current working set

**Files:**
- Modify: `questionnaire/views.py`
- Test: `questionnaire/test_form.py`
- Do not commit: `logs_s6.txt`

**Interfaces:**
- Preserve `questionnaire:form`, `questionnaire:autosave`, `questionnaire:submit`, and `questionnaire:upload` URL contracts.
- Use the existing `schema_hash()` and `ParticipantBoundaryTests` contracts.

- [x] Run the focused questionnaire boundary/form tests and record the actual failure set.
- [x] Keep only current test/view changes that are needed for FORMAL/TEST scoping, schema-hash enforcement, and staff write rejection.
- [x] Run `uv run python manage.py test questionnaire.test_form questionnaire.test_entry files.test_questionnaire_uploads`.
- [x] Commit the focused boundary changes as `fix: close questionnaire participant write boundaries`.

### Task 2: Prove the private fixture package reaches a complete rehearsal

**Files:**
- Modify: `common/private_test_loader.py`
- Modify: `common/test_private_test_loader.py`
- Modify: `docs/private-test-data-runbook.md`

**Interfaces:**
- Keep `load_private_test_fixture --dry-run` and `--apply` unchanged.
- `--apply` must create a TEST activity, freeze the questionnaire/ruleset with a non-empty roster, submit/approve questionnaire responses, reconcile material checks, execute the four-round judge/vote/ticket/media flows, and confirm all result stages.

- [x] Add a failing package-level test that loads the v3 fixture through the loader and asserts 15 registrations, 60 question-keyed media files/checks, 555 criterion rows, 280 tickets, 310 ballots, and three confirmed stage results.
- [x] Run the test and confirm it fails at the first real integration blocker rather than a fixture parser error.
- [x] Fix only the loader lifecycle/authority boundary exposed by the failing test.
- [x] Re-run the package-level test, duplicate apply idempotency, and formal-activity rejection.
- [x] Commit as `test: exercise private questionnaire rehearsal orchestration` and `fix: complete private questionnaire rehearsal lifecycle` when separate changes are needed.

### Task 3: Complete question-keyed material authority and supplement flow

**Files:**
- Modify: `files/services.py`
- Modify: `questionnaire/services.py`
- Modify: `questionnaire/registration.py`
- Modify: `questionnaire/views.py`
- Modify: `staff_panel/views.py`
- Test: `files/test_questionnaire_uploads.py`
- Test: `questionnaire/test_form.py`
- Test: `staff_panel/tests.py` or the owning questionnaire test module

**Interfaces:**
- Add or use `reconcile_questionnaire_material_checks(registration, version, plan)`.
- A supplement write must identify `question_key`; it must not fall back to `file_purpose` alone.

- [x] Add failing tests for check creation on first questionnaire registration, per-question reset after replacement upload, closed-phase denial for ordinary edits, and success for a `NEEDS_SUPPLEMENT` question.
- [x] Add the minimal reconciliation call at the authoritative registration/freeze/submit boundary.
- [x] Make participant form rendering read-only after close except for question keys with an active `NEEDS_SUPPLEMENT` check.
- [x] Hide/disable legacy singer material requirements and staff purpose-only upload for registrations bound to a frozen questionnaire.
- [x] Run focused file/questionnaire/staff tests and commit as `fix: enforce questionnaire material authority`.

### Task 4: Validate questionnaire answers at the server boundary

**Files:**
- Modify: `questionnaire/compiler.py`
- Modify: `questionnaire/registration.py`
- Modify: `questionnaire/services.py`
- Modify: `questionnaire/views.py`
- Modify: `frontend/questionnaire_form.ts`
- Modify: `static/dist/questionnaire_form.js`
- Test: `questionnaire/test_registration.py`
- Test: `questionnaire/test_form.py`

**Interfaces:**
- Introduce one shared normalization/validation path for autosave, submit, and loader input.
- Enforce participant-only questions, declared choice values, scalar/list shape, length/domain constraints, and safe handling of duplicate student IDs without HTTP 500.

- [x] Add failing tests for invalid single/multiple choice values, max length, required values, duplicate student ID, and `audience=staff` exposure/write attempts.
- [x] Implement the smallest shared validator and map expected integrity conflicts to bounded client errors.
- [x] Fix checkbox collection and replay for `multiple_choice` as a list of selected values.
- [x] Run Python and client gates, then commit as `fix: validate questionnaire answers at write boundary`.

### Task 5: Close compiler and file-slot identity gaps

**Files:**
- Modify: `questionnaire/compiler.py`
- Modify: `files/services.py`
- Modify: `questionnaire/successor.py` or the current successor module
- Test: `questionnaire/test_compiler.py`
- Test: `files/test_questionnaire_uploads.py`
- Test: successor tests beside the owning module

**Interfaces:**
- Duplicate binding claims must raise a validation error.
- Delete/replacement must use the same `(owner, question_key, purpose)` slot filter as upload/current-file selection.
- Successor compatibility fingerprint must include type, binding, round, audience, choice values, validation domain, and file purpose while ignoring presentation-only label/description.

- [x] Add failing tests for duplicate binding, cross-round delete replacement, choice-domain changes, and validation-domain changes.
- [x] Implement the narrow guards and run the focused compiler/file/successor tests.
- [x] Commit as `fix: preserve questionnaire question identity contracts`.

### Task 6: Verify the complete browser rehearsal and gates

**Files:**
- Modify: `tests/e2e/auth-entry.spec.ts` or add a questionnaire-owned E2E spec
- Modify: `docs/private-test-data-runbook.md`

- [ ] Run a real browser flow through the canonical entry: open → draft → autosave → upload → submit → edit while open → close → supplement.
- [ ] Run desktop and mobile Playwright smoke against the Docker/PostgreSQL service.
- [ ] Run `uv run python manage.py check`, `uv run python manage.py makemigrations --check --dry-run`, focused Django tests, both Pyright gates, client checks, CSS check, docs check, and the relevant PostgreSQL/backup gate.
- [ ] Perform two self-reviews: authority/contract consistency, then security/error-boundary/data-lifecycle consistency.
- [ ] Commit only verified documentation/evidence changes, then hand off for non-fast-forward merge to `main`.

## Self-Review Checklist

- [ ] Every advice P0 has a test proving the real HTTP/service boundary, not only a direct service call.
- [ ] No participant path can write TEST activity data or bypass schema hash/current ruleset version.
- [ ] No closed ordinary edit can mutate a question without explicit supplement authority.
- [ ] No legacy singer material path can create a second authority for a frozen questionnaire.
- [ ] No raw private source data or secrets are committed.
- [ ] All changed production Python is covered by the repository Pyright baseline.
