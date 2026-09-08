# M2-B Ticket / Check-in / Audience Entitlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production-shaped Ticket lifecycle from Staff issuance through check-in and short-lived ticket access to exactly one ticket-backed ballot per VoteSession, without weakening the existing authority baseline.
**Architecture:** Add a dedicated `tickets` Django app for non-PII Ticket state, secret-digest handling, access sessions, lifecycle services, Staff operations, and public body-only redemption. Extend `voting` through a narrow service call and guarded schema fields; keep `entry_access` as a separate M2-A capability. Centralize phase/action policy in `core.policies`, preserve database-enforced uniqueness and transaction locks, and make cleanup, audit, retention, and rehearsal paths explicit.
**Tech Stack:** Django ORM and TestCase, PostgreSQL/SQLite migrations, Python services with `secrets` and SHA-256 digests, Django JSON/form views, TypeScript client entry compiled by the pinned TypeScript toolchain, Playwright browser smoke, pytest, Ruff, mypy, Pyright, Docker Compose PostgreSQL acceptance.
**Spec:** `docs/superpowers/specs/2026-09-08-m2-b-ticket-checkin-design.md`

## Global Constraints

- Work directly in `C:\Users\16275\Desktop\ArtFlow`; do not create `.worktree`, `worktrees`, or linked worktrees, and do not spawn subagents for repository modifications.
- The feature branch is `feat/m2-b-ticket-checkin`; keep the existing approved design commit and make every logical change a small conventional commit. Separate test additions, security/behavior implementation, type-hygiene batches, and documentation/rule changes.
- Before each production-Python commit run `npm run check:pyright` and `npm run check:pyright:entry-access`; both must report zero diagnostics. Also run the focused Django tests, `python manage.py check`, `python manage.py makemigrations --check --dry-run`, `uv run ruff format --check .`, `uv run ruff check .`, and `uv run mypy` as applicable to the files changed.
- Preserve the existing M2-A `entry_access` models, URLs, semantics, and scoped Pyright configuration. Ticket sessions must not reuse `EphemeralSession`, `AccessGrant`, or their cookies.
- Never persist, log, audit, export, render, or put in a URL a raw Ticket Secret or raw Ticket session token. Only the controlled Staff issuance response may contain a raw Ticket Secret, once; the browser receives the session token only as an HttpOnly cookie.
- All formal Ticket, ballot, and vote-fact lifecycle writes go through audited services inside `transaction.atomic()` with `select_for_update()` on the activity and relevant source row. Existing formal rows are never deleted by test cleanup.
- Reject cross-activity references before mutation. Public failure responses remain generic; public endpoints do not infer authority from client-provided activity IDs, browser identity, IP address, or URL credentials.
- Do not use `docker compose down --volumes`, reset, or drop the running source PostgreSQL database or its volumes. Temporary restore targets only may be created and removed by the existing backup rehearsal scripts.
- Generated `static/dist/` and `static/css/app.css` changes must be produced by the pinned npm commands and committed only when the corresponding check passes.

---

## Task 1: Establish the Ticket data/authority contract with red tests

**Files:** `tickets/__init__.py`, `tickets/apps.py`, `tickets/models.py`, `tickets/services.py`, `tickets/views.py`, `tickets/urls.py`, `tickets/migrations/__init__.py`, `tickets/tests.py`, `common/authority.py`, `common/models.py`, `common/migrations/0012_alter_auditlog_action_type.py`, `config/settings.py`, `config/urls.py`.

**Interfaces consumed:** `core.Activity`, `accounts.User`, `common.authority.authority_write`, `common.authority.AuthorityQuerySetMixin`, `common.audit.client_ip`, `common.models.AuditLog`, and the existing rate-limit API.

**Interfaces produced:** `tickets.Ticket`, `tickets.TicketAccessSession`, `Ticket.State`, `TicketAccessSession` cookie constants, `TICKET_STATE` and `TICKET_SESSION_STATE` authority scopes, and Ticket-specific audit action types. The models expose only digests and derived metadata; raw secrets exist only as service return values.

- [ ] Add failing `tickets/tests.py` model-contract tests before implementation. Cover Ticket fields and constraints, no PII fields, `activity`/vote foreign keys using `PROTECT` where required, conditional inventory uniqueness, CREATED invalidity, and session TTL/revocation fields. Assert a Ticket secret digest is 64 lowercase hex characters and no raw secret appears in model stringification.
- [ ] Add failing authority-matrix tests for `save`, `update`, `bulk_update`, `bulk_create(update_conflicts=True)`, `_base_manager`, relation moves, direct lifecycle/operator/timestamp/digest changes, and delete. Verify protected direct writes raise `ValidationError` outside the exact authority scopes. Verify only explicit expired test-session cleanup can delete access sessions.
- [ ] Add failing audit tests asserting Ticket lifecycle action types exist and raw secret/token values are absent from `AuditLog.target`, `old_value`, `new_value`, and `note`.
- [ ] Commit only the red contract tests with `test: define m2-b ticket authority contract`; run `python manage.py test tickets common.test_authority_matrix` and record the expected import/model failures.
- [ ] Implement the `tickets` app registration and model managers/querysets. Use `Ticket.activity = ForeignKey(..., on_delete=PROTECT)`, nullable `secret_digest` only while CREATED, unique/indexed digest, optional `batch_reference`/`serial_number`, lifecycle timestamps/operators, `is_test_data`, and conditional `(activity, batch_reference, serial_number)` uniqueness when both inventory values are non-null. Use `TicketAccessSession.ticket = ForeignKey(..., on_delete=PROTECT)`, unique/indexed digest, expiry, last-seen, revocation, creation timestamps, and derived `is_test_data`.
- [ ] Implement model-level guards that reject direct state, operator, timestamp, digest, activity, and ticket relation mutation; reject protected deletion; reject conflict upserts; and permit only the named authority scope for service writes. Do not make a broad `Any` suppression or disable a Pyright rule.
- [ ] Add `TICKET_STATE` and `TICKET_SESSION_STATE` to `common/authority.py`; extend `AuditLog.ActionType` with `TICKET_ISSUE`, `TICKET_CHECK_IN`, `TICKET_VOID`, `TICKET_REVOKE`, `TICKET_REDEEM`, and `TICKET_SESSION_REVOKE` using values that fit the existing field length. Generate the common migration.
- [ ] Add `tickets.apps.TicketsConfig` to `INSTALLED_APPS`, set `TICKET_ACCESS_SESSION_TTL_SECONDS` default to `1800`, and include the public Ticket URL namespace in `config/urls.py` without changing `entry-access/` routes.
- [ ] Generate `tickets/migrations/0001_initial.py`, run `python manage.py migrate --plan`, `python manage.py check`, and `python manage.py makemigrations --check --dry-run`.
- [ ] Run `python manage.py test tickets common.test_authority_matrix`, both Pyright commands, Ruff, mypy, and `git diff --check`; commit the implementation as `fix: add guarded ticket data model`.

## Task 2: Implement auditable lifecycle services and phase policy

**Files:** `tickets/services.py`, `tickets/tests.py`, `core/policies.py`, `core/tests.py`, `docs/production-readiness.md`.

**Interfaces consumed:** `Ticket`/`TicketAccessSession` from Task 1, `accounts.services.require_current_staff` and `require_current_admin`, `core.services.lock_activity_for_action`, `common.authority.authority_write`, and `AuditLog`.

**Interfaces produced:** `create_ticket`, `issue_ticket`, `check_in_ticket`, `void_ticket`, `revoke_ticket`, `redeem_ticket`, `authenticate_ticket_session`, `revoke_ticket_session`, and `purge_expired_ticket_sessions`. Define frozen return types `IssuedTicket(ticket, secret)` and `RedeemedTicketSession(session, token)`, plus request metadata containing only an optional IP address.

- [ ] Add failing service tests for the full state machine: CREATED→ISSUED, ISSUED→CHECKED_IN, CREATED/ISSUED→VOID, ISSUED/CHECKED_IN→REVOKED, terminal-state rejection, duplicate check-in idempotency, void-after-check-in rejection, and revoke idempotency. Assert every successful transition creates one redacted audit row with operator and non-secret metadata.
- [ ] Add failing tests for generated 256-bit secrets, digest-only persistence, one-time issuance response, lost-secret replacement by voiding the old Ticket, session expiry/revocation, generic invalid/replay behavior, configured 30-minute default TTL, and cleanup of only expired sessions.
- [ ] Add failing phase-policy tests for `MANAGE_TICKETS` in `REGISTRATION_OPEN`, `REGISTRATION_CLOSED`, `REHEARSAL`, and `LIVE`; `CHECK_IN` in `REGISTRATION_CLOSED`, `REHEARSAL`, and `LIVE`; and both actions in test-mode `TESTING`. Assert DRAFT, REVIEWING, RESULTS_PENDING, RESULTS_PUBLISHED, and ARCHIVED reject them. Assert views cannot bypass `ensure_activity_action_allowed`.
- [ ] Commit lifecycle/policy red tests as `test: cover m2-b ticket lifecycle policy`; run the focused tests and confirm the failures are from missing service behavior.
- [ ] Add `MANAGE_TICKETS` and `CHECK_IN` to `core.policies.ActivityAction` and the single `_PHASE_ACTIONS` source of truth. Ensure the existing formal/test-mode phase semantics are explicit rather than duplicated in views.
- [ ] Implement service transitions in `transaction.atomic()` by locking the Activity first and the Ticket/session second, reloading authoritative values from the database, checking actor role and action phase, and writing only the permitted fields within the exact authority scope. `secrets.token_urlsafe(32)` is generated only at issuance/replacement; store only `sha256(raw_secret.encode("ascii")).hexdigest()`.
- [ ] Implement `authenticate_ticket_session` by hashing the presented cookie token, locking the session, checking expiry/revocation/activity and Ticket state, and updating `last_seen_at` under `TICKET_SESSION_STATE`. Return a generic `ValidationError` for unknown, expired, revoked, wrong-activity, and wrong-state sessions.
- [ ] Implement `purge_expired_ticket_sessions(now=None)` with an explicit service scope that deletes only `TicketAccessSession` rows whose `expires_at` is in the past; the short-lived session retention policy applies to both TEST and FORMAL sessions, while formal Tickets, accepted ballots, and audit rows are never deleted. Record aggregate cleanup metadata without credentials.
- [ ] Update production-readiness documentation with the Ticket transition/replay/concurrency scenarios and the boundary that WAF, DDoS mitigation, TLS flood handling, connection caps, and school approval remain deployment ownership.
- [ ] Run focused tests, both Pyright commands, Ruff, mypy, Django checks/migration check, and docs tests; commit behavior as `fix: enforce audited ticket lifecycle`.

## Task 3: Add Staff issuance, check-in, void/revoke, and reconciliation HTTP flows

**Files:** `tickets/staff_urls.py`, `tickets/views.py`, `tickets/forms.py`, `templates/staff_panel/ticket_list.html`, `templates/staff_panel/ticket_issue.html`, `templates/staff_panel/ticket_check_in.html`, `templates/staff_panel/ticket_detail.html`, `config/urls.py` or `staff_panel/urls.py`, `tickets/tests.py`, `staff_panel/tests.py`.

**Interfaces consumed:** Task 2 lifecycle services, existing `staff_required`/admin decorators, `Activity` query patterns, Django CSRF/form handling, and the existing Staff template base/navigation.

**Interfaces produced:** CSRF-protected Staff pages/endpoints for single/batch issue, body-only secret check-in, void/revoke, and non-personal operational reconciliation by activity/batch/serial/state. Lists and reconciliation never include raw secrets or session tokens.

- [ ] Add failing HTTP tests for Staff-only access, CSRF enforcement, activity phase rejection, cross-activity ID rejection, single and batch issue, one-time secret response/rendering, body-only check-in, duplicate check-in, void/revoke permissions, and list redaction. Use `assertNotContains` for raw secrets in lists, audit pages, and error responses.
- [ ] Add failing tests that malformed JSON, oversized bodies, query/path secret attempts, and arbitrary client `activity_id` values cannot cause state mutation. Assert invalid input responses contain reason codes but no secret material.
- [ ] Commit the red HTTP tests as `test: cover ticket staff operations`; run `python manage.py test tickets staff_panel`.
- [ ] Implement `tickets/forms.py` for normalized non-PII batch/serial input and operator notes with bounded lengths. Implement `staff_urls.py` under `/staff/tickets/` and decorate every mutation with the existing Staff/admin checks and CSRF protection.
- [ ] Implement issue responses so the raw Ticket Secret is returned/rendered exactly once from `issue_ticket`; build every QR payload as `/tickets/scan#<opaque-payload>`, never as a query/path credential. Do not include the raw value in redirect URLs, Referer-bearing pages, HTML lists, audit rows, or logs.
- [ ] Implement body-only check-in and void/revoke endpoints that call the service layer, return the fixed generic invalid response for malformed/unknown credentials, and preserve duplicate check-in idempotency. Reconciliation must query by non-personal batch/serial/state and show counts and timestamps only.
- [ ] Add navigation links and templates using the existing Staff layout and escaping conventions; keep public scan and Staff operations separate.
- [ ] Run focused tests, both Pyright commands, Ruff, mypy, Django checks, and `git diff --check`; commit as `feat: add staff ticket operations`.

## Task 4: Add public scan/redeem with fragment credentials and secure cookie sessions

**Files:** `tickets/views.py`, `tickets/urls.py`, `frontend/ticket_scan.ts`, `tsconfig.client.json` if a new entry requires it, `static/dist/ticket_scan.js`, `templates/tickets/scan.html`, `tickets/tests.py`, `tests/e2e/runtime-smoke.spec.ts`, `tests/client/ticket_scan.test.mjs`.

**Interfaces consumed:** Task 2 `redeem_ticket`/`authenticate_ticket_session`, `common.rate_limit.allow`, `common.audit.client_ip`, Django CSRF exemption conventions for non-authority public redeem, and the pinned TypeScript build.

**Interfaces produced:** Read-only `/tickets/scan/`, body-only `POST /tickets/redeem/`, HttpOnly `artflow_ticket_session` cookie, strict JSON cap, per-IP rate limit with `429` and `Retry-After`, and a browser flow that consumes a fragment without putting the secret in history or network URLs.

- [ ] Add failing Django tests for GET scan, redeem success, unknown/CREATED/expired/void/revoked secret, replay, cookie attributes, oversized/malformed/non-object JSON, URL/query/path/cookie-as-initial-credential rejection, generic error shape, and rate-limit `429 Retry-After`.
- [ ] Add failing tests proving a successful public redeem does not transition Ticket state, does not create a Ballot, and writes no raw credential to AuditLog or response JSON. Test production cookie flags (`Secure`, `HttpOnly`, `SameSite=Lax`) and development test behavior separately.
- [ ] Add failing client tests for fragment extraction, immediate `history.replaceState` scrubbing, POST body-only redemption, successful cookie-based navigation, and no token in query/path/console-visible error text.
- [ ] Commit the red public/client tests as `test: cover ticket redeem boundary`; run the focused Django and client tests.
- [ ] Implement scan HTML and `frontend/ticket_scan.ts` with a typed payload/state union. Read the fragment once, scrub it before any navigation, POST JSON to the redeem endpoint, and render only generic success/failure messages. Do not copy the credential into hidden inputs, analytics, URLs, or logs.
- [ ] Implement the public redeem view with a route-specific body limit, strict JSON object validation, IP rate limiting, generic invalid responses, `Cache-Control: no-store`, and a session cookie set only after service success. The cookie contains the opaque raw session token and is never returned in JSON or HTML.
- [ ] Add the TypeScript entry to the existing compiler map, run `npm run check:client`, and commit generated `static/dist/` only when it is current.
- [ ] Add the Playwright runtime smoke for scan/redeem against the already-running local/Compose service. Assert the browser URL has no fragment after redemption, no secret appears in the URL, and the session cookie is HttpOnly. Keep traces/screenshots free of credential-bearing pages.
- [ ] Run focused tests, both Pyright commands, client build/test, Playwright (when the service is running), Ruff, mypy, and Django checks; commit as `feat: add secure public ticket redemption`.

## Task 5: Extend VoteSession configuration and VoteBallot authority

**Files:** `voting/models.py`, `voting/migrations/0008_votesession_requires_ticket_and_ballot_ticket.py`, `voting/tests.py`, `staff_panel/forms.py`, `staff_panel/views.py`, `staff_panel/tests.py`, `ruleset/models.py`, `ruleset/services.py`, `ruleset/compiler.py`, `ruleset/test_compiler.py`, `common/authority.py`, `docs/production-readiness.md`.

**Interfaces consumed:** `tickets.Ticket`, `VoteSession` configuration mutability guard, `VoteBallotQuerySet`, existing freeze/lock services, and Django conditional constraints.

**Interfaces produced:** `VoteSession.requires_ticket` as frozen configuration and `VoteBallot.ticket` as a nullable `PROTECT` relation, with database uniqueness for one Ticket per VoteSession. No-ticket sessions keep the existing browser-session compatibility path.

- [ ] Add failing model/service tests for default `requires_ticket=False`, creation/configuration updates before open/lock, rejection after open/lock, rejection after relevant ruleset freeze/binding, and inclusion in the effective binding/freeze contract.
- [ ] Add failing tests for nullable Ticket relation, `PROTECT` behavior, partial unique `(ticket_id, vote_session_id) WHERE ticket_id IS NOT NULL`, Ticket/VoteSession activity mismatch, direct relation moves, queryset/bulk paths, and locked-ballot mutation rejection.
- [ ] Add failing compatibility tests proving no-ticket sessions still deduplicate by browser session and never attach a supplied Ticket session to a ballot.
- [ ] Commit red voting tests as `test: define ticket vote entitlement contract`.
- [ ] Add `requires_ticket` to the VoteSession configuration field set and model comparison in `voting/models.py`, the creation form in `staff_panel/forms.py`, Staff create/detail/list handling in `staff_panel/views.py` and `staff_panel/tests.py`, and the frozen binding/signature and vote-source validation in `ruleset/models.py`, `ruleset/services.py`, and `ruleset/compiler.py`. Extend `ruleset/test_compiler.py` with matching-purpose and matching-entitlement cases. Keep all existing `is_open`/`is_locked` mutation guards intact.
- [ ] Add `VoteBallot.ticket = ForeignKey("tickets.Ticket", on_delete=PROTECT, null=True, blank=True, related_name="ballots")`, the conditional unique constraint, and model/queryset guards that verify ticket activity equals session activity and prevent post-lock relation changes, bulk updates, conflict upserts, or deletion.
- [ ] Generate the voting migration with dependencies on the latest `tickets` migration, run the migration plan on SQLite and PostgreSQL, and ensure the partial constraint is represented for supported database backends.
- [ ] Update the Staff VoteSession form to make the entitlement an explicit purpose/configuration choice with a clear immutable-after-open explanation; never default formal data to ticket-required accidentally.
- [ ] Run focused voting/staff tests, both Pyright commands, Ruff, mypy, Django checks, and migration checks; commit as `fix: guard ticket vote configuration`.

## Task 6: Enforce ticket entitlement inside the ballot transaction

**Files:** `voting/services.py`, `voting/views.py`, `voting/tests.py`, `tickets/tests.py`, `templates/voting/vote_entry.html`, `templates/voting/vote_cast.html`, `docs/production-readiness.md`.

**Interfaces consumed:** Task 2 `authenticate_ticket_session`, Task 5 `requires_ticket`/`VoteBallot.ticket`, existing vote option validation and browser-session idempotency, activity lock service, and standard CSRF on vote submission.

**Interfaces produced:** `submit_ballot(vote_session, *, browser_session_key, option_ids, ip_address, ticket_session: TicketAccessSession | None = None)` with one authoritative path for both ticket and no-ticket voting. Ticket-required submission authenticates/locks the Ticket and session in the same transaction, checks activity/state/expiry/open window/options, then creates exactly one ballot and its VoteRecords.

- [ ] Add failing service tests for required-ticket happy path, missing/invalid/expired/revoked session, wrong activity, ISSUED-but-not-checked-in, VOID/REVOKED Ticket, closed/locked/out-of-window VoteSession, wrong options, duplicate same Ticket/session, and duplicate browser session. Assert every failure leaves Ballot and VoteRecord counts unchanged.
- [ ] Add failing concurrency tests using two database connections/threads on PostgreSQL for simultaneous check-in and simultaneous same-Ticket/same-VoteSession submission. Assert one check-in transition and one ballot, with no partial VoteRecords. Add a cross-activity race test that cannot create a relation.
- [ ] Add failing compatibility tests for `requires_ticket=False`: existing browser-session behavior remains, any supplied ticket context is ignored, and `VoteBallot.ticket_id` remains null.
- [ ] Commit red transaction tests as `test: cover ticket-backed ballot concurrency`.
- [ ] Refactor `submit_ballot` so authoritative reload/locks happen before duplicate return: lock Activity, VoteSession, and Ticket session/Ticket in a deterministic order; verify the ticket session belongs to the same Activity and its Ticket is CHECKED_IN; then validate VoteSession state/time and scoped options; then create Ballot with `ticket=...` and VoteRecords. Catch only the existing database uniqueness race and return the single existing ballot after reloading its records.
- [ ] Keep browser session and IP as compatibility/idempotency/abuse signals only. Never use them as Ticket authority and never mutate an accepted ballot after Ticket revocation.
- [ ] Update vote views to obtain the opaque Ticket session from the HttpOnly cookie, pass it to the service only for `requires_ticket=True`, preserve standard CSRF on the vote POST, and return generic invalid/forbidden responses without credential material. Do not accept a client activity ID to select the Ticket.
- [ ] Update vote templates to communicate “已检票票据” without showing secrets or session values; keep the no-ticket form unchanged for legacy sessions.
- [ ] Run focused voting/ticket/staff tests, PostgreSQL concurrency tests via the existing acceptance environment, both Pyright commands, Ruff, mypy, Django checks, and migration checks; commit as `fix: enforce ticket vote entitlement atomically`.

## Task 7: Integrate test-data cleanup, retention, backup verification, and operational diagnostics

**Files:** `common/test_data.py`, `common/management/commands/seed_demo_data.py`, `common/management/commands/doctor.py`, `common/management/commands/backup_artflow.py`, `common/management/commands/verify_app_backup.py`, `tickets/services.py`, `tickets/tests.py`, `tests/test_production_compose_config.py`, `docs/deployment-production.md`, `docs/development-baseline.md`, `docs/postgres-backup-restore.md`.

**Interfaces consumed:** `clear_activity_test_data`, test markers, `SeedRecord`, existing backup manifest/verification commands, `doctor`, and the Ticket cleanup service.

**Interfaces produced:** Test Ticket/session counts and safe reset behavior; seed/demo Ticket fixtures with explicit ownership; expired-session retention purge; backup manifest classification; doctor output that reports only non-secret Ticket counts and stale sessions.

- [ ] Add failing cleanup tests proving test Tickets, test sessions, and their test ballots are removed in dependency-safe order; formal Tickets and all formal ballots/audits remain; cleanup refuses mixed formal dependents; raw secrets never appear in returned count dictionaries or audit notes.
- [ ] Add failing seed/reset idempotency tests for Ticket inventory, check-in, void/revoke states, and session expiry without creating formal-looking rows or duplicate inventory.
- [ ] Add failing retention/doctor/backup tests for expired session purge, technical redeem log retention, secret-digest classification, no raw credentials in manifests/exports, and restore verification on a separate target.
- [ ] Commit red cleanup/retention tests as `test: cover ticket rehearsal and retention boundaries`.
- [ ] Extend `get_test_data_counts`, mixed-marker checks, and `clear_activity_test_data` to include TicketAccessSession before Ticket/ballot deletion, then delete only explicitly test-marked eligible sessions/Tickets in dependency order under `TEST_DATA_CLEANUP` and `TICKET_SESSION_STATE`. Do not cascade-delete formal data.
- [ ] Extend demo seeding with `SeedRecord`-owned test inventory and a controlled issuance/check-in path whose raw secrets are used only in-memory for that command's output contract; do not write them to seed records, logs, or fixture files.
- [ ] Add a management command or documented scheduled invocation for expired TicketAccessSession purge and integrate non-secret counts into `doctor`. Extend backup manifests and verification to classify Ticket digests/status/operator metadata and explicitly reject raw credential fields.
- [ ] Update deployment/development/backup docs with data classification, retention/purge ownership, cookie/secret/key handling, reconciliation, manual paper check-in/vote DR, trace hygiene, and the explicit boundary between application throttles and edge WAF/DDoS controls.
- [ ] Run focused tests, backup/restore script tests, both Pyright commands, Ruff, mypy, Django checks, docs checks, and the non-destructive PostgreSQL backup rehearsal; commit as `fix: make ticket rehearsal and retention safe`.

## Task 8: Expand end-to-end and security gates, then perform two implementation reviews

**Files:** `tests/e2e/runtime-smoke.spec.ts`, `tests/client/ticket_scan.test.mjs`, `tests/test_production_compose_config.py`, `docs/production-readiness.md`, `.github/workflows/integration.yml`, `README.md`.

**Interfaces consumed:** all M2-B endpoints/services, existing CI jobs, pinned Playwright config, PostgreSQL acceptance script, production rehearsal runbook, and the repository gate commands in `AGENTS.md`.

**Interfaces produced:** CI coverage for Ticket authority, public abuse boundaries, browser redemption, ticket-backed voting, PostgreSQL races, and production-shaped retention/recovery evidence.

- [ ] Add Playwright coverage for Staff issue → controlled secret/QR display → public fragment scan → redeem → cookie-backed vote entry → one successful ballot → replay/second ballot rejection. Assert no credential is present in URL, page source after redemption, trace metadata, or client console output.
- [ ] Add Playwright negative coverage for invalid/expired/revoked/unchecked Ticket, wrong VoteSession/activity, missing cookie, cookie revocation, rate-limit response, and no-ticket VoteSession compatibility.
- [ ] Add client and Python abuse tests for oversized JSON, malformed Unicode, repeated redemption, query/path leakage, spoofed forwarding IP behavior, CSRF on Staff/vote mutations, authorization boundary, conflict-upsert/direct ORM bypass, cross-activity IDs, and concurrent duplicate submission.
- [ ] Update CI to run the new focused Ticket tests alongside the existing Django, client, CSS, docs, Pyright, PostgreSQL acceptance, and Playwright gates. Do not remove or downgrade any existing gate.
- [ ] Run the complete local gate set in this order: `uv sync --locked --extra dev`; `python manage.py migrate`; `python manage.py check`; `python manage.py makemigrations --check --dry-run`; `uv run ruff format --check .`; `uv run ruff check .`; `uv run mypy`; `npm run check:pyright`; `npm run check:pyright:entry-access`; `npm run check:client`; `npm run test:client`; `npm run check:css`; `pwsh -NoProfile -File scripts/check_docs.ps1`; `python manage.py test`; PostgreSQL acceptance with `-StartCompose -VerifyResetSafety`; `npm run test:e2e`; and the non-destructive backup/restore rehearsal.
- [ ] Perform implementation self-review round one against every numbered requirement in `docs/superpowers/specs/2026-09-08-m2-b-ticket-checkin-design.md`: trace each mutation from HTTP/service to locked ORM write, verify no raw credential sink, verify phase and role gates, verify formal/test cleanup separation, and record findings in the implementation commit/PR notes.
- [ ] Perform implementation self-review round two as an adversarial pass: inspect all ORM entry points (`save`, `update`, `bulk_update`, `bulk_create`, `_base_manager`, relation assignment, deletes), replay/race behavior, cookie and Referer exposure, audit/export/backup output, cross-activity paths, and CI command coverage. Fix findings in separate small commits and rerun the affected gates.
- [ ] Update `docs/production-readiness.md` with the actual M2-B rehearsal date, command results, skipped prerequisites, residual deployment ownership, and manual DR evidence. Do not claim SSO/MFA, WAF, DDoS, TLS, or institutional approval from application tests.
- [ ] Commit the gate/test/documentation batch as `test: close m2-b ticket readiness gates`.

## Task 9: Verify, merge, push, and preserve an auditable handoff

**Files:** no new source files; Git state and final verification artifacts only.

**Interfaces consumed:** the verified feature branch, `origin/main`, all gates from Task 8, and the repository branch policy in `AGENTS.md`.

**Interfaces produced:** a non-fast-forward merge commit on `main`, pushed to `origin/main`, with the feature branch retained until remote verification completes.

- [ ] Confirm `git status --short --branch` is clean, `git diff --check` is clean, migrations are present, and all Task 8 gates have fresh passing output.
- [ ] Push the feature branch. If the normal push times out, retry with `git -c http.proxy=http://127.0.0.1:12334 -c https.proxy=http://127.0.0.1:12334 push origin feat/m2-b-ticket-checkin`.
- [ ] Switch to `main`, run `git pull --ff-only origin main`, merge with `git merge --no-ff feat/m2-b-ticket-checkin`, and resolve no unrelated changes.
- [ ] Push `main`; if it times out, retry through `127.0.0.1:12334` using the exact proxy form above. Confirm `origin/main` contains the merge commit and the local working tree is clean.
- [ ] Only after remote verification, delete the feature branch if desired; report the merge commit, verification commands/results, migrations, and any explicitly unfulfilled external deployment prerequisites.

## Completion Criteria

- Ticket secrets are 256-bit random, digest-only at rest, emitted once under Staff control, absent from logs/audits/exports/backups/traces/URLs, and never accepted from query/path/cookie-as-initial-source.
- Ticket lifecycle and TicketAccessSession writes are authority-guarded at model and queryset levels, audited at service boundaries, transactionally locked, and cross-activity safe.
- `MANAGE_TICKETS` and `CHECK_IN` are centrally phase-gated; checked-in Ticket state—not IP, browser session, or client IDs—authorizes ticket-backed voting.
- `VoteSession.requires_ticket` is immutable at the established freeze/open/lock boundaries; one Ticket can create at most one ballot per VoteSession by database constraint and service transaction; existing no-ticket voting remains compatible.
- Public redemption is bounded and rate-limited, uses secure HttpOnly cookie sessions, and does not mutate Ticket state. Staff operations are CSRF-protected and redact secrets.
- Test cleanup, retention, seed, doctor, backup/restore, CI, Playwright, PostgreSQL concurrency, and two adversarial implementation reviews all have evidence, with external WAF/DDoS/SSO/MFA/institutional approval explicitly outside the code claim.
