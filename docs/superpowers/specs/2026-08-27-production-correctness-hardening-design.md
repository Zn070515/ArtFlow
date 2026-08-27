# ArtFlow Production Correctness Hardening Design

**Date:** 2026-08-27

**Status:** Approved for implementation planning by the repository owner.

## Goal

Make ArtFlow safe for a real student arts event by enforcing business invariants at the model/service/view boundaries, making destructive or state-changing workflows atomic and auditable, and adding operational safeguards for files, assets, voting, test data, and PostgreSQL recovery.

This is a correctness hardening release. It does not redesign the whole Django app topology, add a licensing decision, or introduce unrelated product features.

## Constraints and contracts

- Development happens directly in the checkout on `feat/production-correctness-hardening`; no `.worktree`, `worktrees`, or linked worktree is allowed.
- All state-changing HTTP endpoints use POST, CSRF protection, and server-side authorization; GET endpoints remain read-only.
- Production data is never silently treated as test data, deleted as part of a test reset, or included in a formal result when it is marked as test data.
- A formal contest result cannot be locked while any expected judge/singer score cell is missing or invalid.
- A score submission or import is all-or-nothing: validation completes before mutation, and mutation plus recalculation plus audit is one transaction.
- Every cross-domain relation that carries an activity must refer to objects belonging to that same activity.
- Private uploaded files remain available only through controlled access views; uploads are bounded by purpose-specific size and content policy.
- Existing data must remain migratable. New constraints include remediation for existing invalid rows before enforcement.
- The repository's existing commands, CI gates, PostgreSQL acceptance workflow, and 75% coverage floor remain green.

## Workstream A: business correctness and auditability

### A1. Permission synchronization

`accounts.User.save()` will derive `is_staff` from the role and superuser state in both directions. A role changed from staff/admin to participant immediately loses the Django staff flag on normal saves. A data migration or management command will remediate stale rows already stored with a non-staff role and `is_staff=True`; the remediation is idempotent and preserves superusers. Regression tests cover promotion, demotion, and stale historical rows.

### A2. Scoring service boundary

Create `singer_contest/services.py` as the single application boundary for score validation, expected-cell calculation, score application, recalculation, locking, and score audit payloads. The service will:

1. Define eligible singers as approved registrations belonging to the round's activity.
2. Define expected judges as active judges belonging to the round's activity.
3. Reject non-finite, non-numeric, or out-of-range values outside 0 through 100 with at most two decimal places.
4. Parse all manual or workbook input before opening the write transaction.
5. Apply the complete score set in `transaction.atomic()` using the existing unique score key.
6. Recalculate only complete, eligible score rows and update rank/advancement consistently.
7. Produce an audit change list containing singer, judge, old score, and new score for changed cells.

Missing score reporting will return concrete cells, not a nullable-score query. Round locking will reject incomplete results for ordinary staff. Any emergency override must be an explicit admin-only POST with a non-empty reason and an audit record; no silent bypass is added.

Manual entry and Excel import views become thin adapters. Excel import uses parse/validate/apply phases, so any validation error leaves every pre-existing score untouched.

### A3. State-changing endpoint safety

Apply `require_POST` to round lock/unlock, activity lock/unlock, activity test-mode transitions, vote session open/lock/unlock/toggle, and any other endpoint found by the mutation audit. Templates will submit CSRF-protected forms and include an unlock reason where required. Tests assert GET is rejected and POST remains authorized.

### A4. Activity ownership invariants

All forms and POST handlers will scope singers, judges, programs, vote options, awards, incidents, notes, and related files to the selected activity. The database will gain constraints where the schema can express them directly; service/view validation will cover relations spanning two foreign keys, such as `Award.activity == Award.singer.activity` and `VoteOption.singer.activity == VoteOption.vote_session.activity`. Existing invalid rows will be detected by a diagnostic command/test fixture before constraints are enforced.

### A5. Audit semantics

Score changes will store a structured JSON-compatible diff in `AuditLog.new_value` or the established audit payload field while retaining the round target and operator. Unlock and relock actions include the reason, actor, and resulting state. Audit records are created in the same transaction as the mutation so a rolled-back score change cannot leave a false audit trail.

## Workstream B: test data, files, and voting

### B1. Test-mode state transition

Replace a blind boolean toggle with an explicit transition service. Turning test mode off is blocked while marked test rows remain, unless an admin explicitly chooses the tested cleanup transition. Cleanup deletes only activity-owned rows marked as test data, removes associated stored files, and records counts and operator in an audit entry. Formal exports and result queries consistently exclude test rows. Tests cover nested dependent rows, file deletion, production-row preservation, repeated cleanup, and failed transitions.

### B2. File policy and current-version semantics

Add purpose-specific upload policy with extension/content-type checks and explicit maximum sizes. `FILE_UPLOAD_MAX_MEMORY_SIZE` remains a memory-spooling setting, not the business limit. Upload handlers reject oversize or disallowed files before persistence.

For each owner and material purpose, add a current-file marker/version semantics: exactly one file is current, older files remain historical, and replacing the current file is auditable. UI and exports identify the current formal accompaniment/media. Deleting a `SubmissionFile` also removes its storage object after the database row is safely removed; test cleanup uses the same deletion path and has orphan regression coverage.

### B3. Vote ballot integrity

Introduce `VoteBallot` and `VoteChoice` (or an equivalent single ballot aggregate) so one browser session can submit only one ballot per session, enforced by a database uniqueness constraint. Existing `VoteRecord` rows will be migrated without losing counts. The hard identity is the session cookie plus vote session; IP is retained as a soft abuse signal and never as the person identity. Ballot creation and choices are atomic and handle concurrent duplicate submissions without a 500.

Vote session and option creation validates that every option belongs to the session activity. Locking/relocking popularity awards is deterministic: one session's generated award is replaced or reconciled when the winner changes, with no duplicate formal award. Relevant lock/unlock and concurrent submission tests are required.

## Workstream C: production delivery and recovery

### C1. Local static CSS

Remove the runtime Tailwind Play CDN and inline Tailwind compiler from `templates/base.html`. Add a pinned build-time CSS toolchain and commit the generated CSS used by Django `collectstatic`; the deployed HTML must have no dependency on a public CDN. CI checks that the asset exists and the base template references only local static assets.

### C2. PostgreSQL backup and restore

Add a documented, non-destructive workflow using `pg_dump`/`pg_restore` (or the corresponding custom-format commands) that creates a backup, verifies it is non-empty and inspectable, restores it into a separate database/container, runs Django checks and a read-only integrity query, and leaves the source database and Compose volumes intact. Provide a PowerShell wrapper compatible with the existing Windows workflow and a CI acceptance path where Docker is available. The workflow must never reset or drop the source database.

### C3. Release and incident rehearsal

Add regression tests and documentation for the event-day failure matrix: missing judge score, malformed/partial import, unauthorized role downgrade, forged cross-activity IDs, GET mutation, duplicate/concurrent ballot, test-data leakage, wrong current media file, unlock-edit-relock, and backup restore. Update `AGENTS.md` only where the new commands or contracts differ from the existing repository rules.

## Migration and compatibility strategy

Schema migrations are additive first. Data migrations or explicit diagnostics identify invalid legacy activity relations and stale permission flags. Existing `VoteRecord` data is preserved during ballot migration. Existing non-current submission files become historical files; no uploaded object is deleted solely because it is old. A deployment checklist runs migrations, static collection, data remediation, and the backup/restore rehearsal before production use.

## Verification strategy

Each behavior is implemented test-first with a regression test observed failing before production code is written. Verification is layered:

1. Focused Django tests for each workstream and migration.
2. Full Django suite, coverage gate, Ruff, mypy, `check`, and migration check.
3. Documentation and script checks, including static asset checks and backup/restore acceptance where Docker exists.
4. Two explicit self-review passes: contract/semantic consistency, then security/data-integrity/logic review.
5. Final merged-`main` verification and remote GitHub workflow checks before reporting completion.

## Explicit non-goals

- Do not split `staff_panel` into a new app topology during this release.
- Do not add `LICENSE` or make an open-source/commercial licensing decision in this release.
- Do not use IP address as a vote identity.
- Do not delete production or unmarked rows during test cleanup or seed reset.
- Do not make the source database destructive backup verification depend on a reset command.
