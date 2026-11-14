# M7-M13 High Review Findings Fixes Implementation Plan

> For agentic workers: execute this plan task by task, keeping each task small and verifiable.

**Goal:** Close the ten open findings in the 2026-10-27 M7-M13 audit without weakening the ArtFlow-Plus authority, lifecycle, storage, or deployment contracts.

**Architecture:** Keep the production outbox relay as a separately deployed worker, make proxy trust and upload ceilings explicit at the deployment boundary, preserve imported history as closed/read-only, add an audited round correction seam that composes with result unlock, reject definition-release drift once a round exists, and make export/archive/live ranking use their canonical representations without silent loss.

**Tech Stack:** TypeScript 7, Node 24, Fastify 5, Kysely/PostgreSQL, React/Vite, Vitest, Docker Compose/Caddy/Nginx, Django management-command tests.

**Spec and audit sources:**

- `docs/artflow-plus/reviews/2026-10-27-m7-m13-high-review.md`
- `GOAL.md`
- `docs/invariants/lifecycle.md`
- `docs/invariants/concurrency.md`
- `docs/architecture/adr/0015-archive-package-and-storage.md`
- `docs/artflow-plus/cutover-runbook.md`
- `docs/development-baseline.md`

## Global Constraints

- Work on the current `fix/m7-m13-high-findings` branch; do not merge `main` into the v2 line and do not create a linked worktree or delegate work.
- Use the existing command/service authority seams. Do not add direct ORM writes to HTTP handlers or UI code.
- Write a failing regression test before each production-code change, then implement the narrowest fix and run the focused test.
- Preserve traversal rejection, optimistic concurrency, event/audit records, result-consumption guards, and the distinction between historical read-only imports and operational adoption.
- Update the relevant deployment/spec/runbook contract whenever behavior changes; do not make tests encode an undocumented deployment assumption.

## Task 1: Establish the production relay and proxy/body-size boundaries

**Tests first:**

1. Add deployment contract checks that production Compose declares `plus-worker`, its image/database/volume dependencies, and keeps `ARTFLOW_PLUS_INLINE_RELAY` absent or explicitly disabled on `plus-api`.
2. Add a Fastify regression test proving that, with proxy trust disabled, two different forwarded addresses still share the real socket bucket, and with an explicit trusted proxy configuration they receive separate buckets.
3. Add config checks that the Plus Nginx and Caddy upstream limits are at least the API’s 128 MiB ceiling.

**Implementation:**

1. Extend `deploy/plus/Dockerfile` with a worker production target that runs the compiled worker and its workspace dependencies; add the worker image/build command to the Plus deployment documentation.
2. Add `plus-worker` to the `plus` profile in `deploy/compose.production.yml`, sharing the Plus database and archive/media volumes as required by the runtime, and add its health/startup dependency. Keep the API’s inline relay opt-in only.
3. Add an explicit `ARTFLOW_PLUS_TRUST_PROXY` parser/configuration to the API, defaulting to no trusted proxy, and pass it to Fastify. Document the trusted internal proxy/CIDR setting in the production env example and Compose profile.
4. Raise `deploy/plus/nginx.conf` and `deploy/caddy/sites/v2.caddy` request-body ceilings to 128 MiB, while leaving domain-level material policies authoritative.

**Verification:** focused API tests, Compose/config tests, Dockerfile syntax/static checks, and `pnpm -C plus run check`.

## Task 2: Restore archive-key compatibility for imported public codes

**Test first:** Extend the archive storage test with a real imported-style key such as `legacy-act-AB7K2Q9Z/v1.zip`, asserting write/read/digest success and traversal rejection.

**Implementation:** Broaden only the safe archive activity-segment character class to include uppercase ASCII. Keep the two-segment shape, `v<number>.zip` filename rule, absolute-root check, and traversal protections unchanged. Update ADR/spec wording and the archive contract fixture to document the accepted key shape.

**Verification:** archive-package focused tests and runtime type-check.

## Task 3: Make historical imports closed and write-failing

**Test first:** Add a no-active-result legacy bundle fixture. Assert its imported activity is closed, its public registration read reports `registrationOpen: false`, reads remain available, and representative registration/material/finalization/close commands fail with the existing inactive-activity domain guard.

**Implementation:** In `legacy-import-service.ts`, make the historical branch always materialize `status: "closed"` and a final registration artifact. Preserve operational adoption’s active lifecycle and existing roster/release semantics. Ensure no read fallback reopens a missing lifecycle on the historical path.

**Verification:** focused legacy-import/read/write tests, then runtime check.

## Task 4: Add the audited round reopen-for-correction seam

**Test first:** Add runtime integration coverage for a formal round that is locked and has no confirmed consuming result: a correction command with actor, reason, and expected revision reopens it, increments revision, appends an audit event, and permits score correction. Add rejection coverage for consumed rounds, wrong revision, missing reason, and non-formal/non-authorized command sessions. Add API contract coverage for the route and error mapping.

**Implementation:**

1. Add a domain error/code for an immutable or invalid round correction transition and bind it to HTTP 409 where appropriate.
2. Add a runtime command/service that locks the activity then round in the documented order, requires the competition-management capability and formal session, checks no result consumer remains, updates the round from `locked` to `scoring` with OCC, records reason/operator/expected revision and the new revision in an event, and invalidates dependent live/projection state through the existing event path.
3. Add an API route/schema and a small Live/Ops control that calls the service with an explicit reason. Keep result publication/unlock as its own audited command; after publication unlock the same round can be corrected, re-resolved, re-confirmed, and released as a new release while the old release is superseded.
4. Add/adjust lifecycle documentation to state that correction is a narrow LIFE-04 seam and not a general raw state edit.

**Verification:** focused runtime/API/web tests, including the unlock → reopen → edit → resolve → confirm → release chain and the independent unconsumed-round path.

## Task 5: Prevent definition-release drift after competition rounds exist

**Test first:** Add a definition-service regression where a round already exists but no session is running; releasing a new definition must fail with the new clear domain error, while release before any round remains valid.

**Implementation:** In the release command, reject any new definition release once any activity round exists. Do this under the existing activity lock and before inserting the release; do not attempt an implicit round migration.

**Verification:** focused definition-service tests, domain error/status mapping tests, and runtime check.

## Task 6: Preserve legacy result identities in the Plus exporter

**Test first:** Add a Django exporter fixture with `result_snapshot=None` and fallback decisions/awards in the camelCase shape emitted by Plus. Assert exported registrations/results use the actual contestant IDs and never `legacy-user:None`.

**Implementation:** Normalize fallback decision/award contestant identity by accepting canonical camelCase and legacy snake_case/participant forms before applying the defensive legacy fallback. Keep result snapshot precedence and existing source/award fields.

**Verification:** focused Django exporter test and relevant Python checks.

## Task 7: Page all archive events instead of silently truncating

**Test first:** Seed more than 100,000 formal outbox events for one activity and assert the archive manifest/event summary includes the exact total and the packaged archive remains readable.

**Implementation:** Page `readEventsSince` with a bounded page size and the last event sequence until the returned page is short/empty. Preserve event ordering, mode filtering, and manifest counts; do not raise the page size to hide the issue.

**Verification:** focused archive-service test, archive integrity/readback test, runtime check.

## Task 8: Render tie ranks from canonical tie groups

**Test first:** Add a pure web ranking test for scores `[90, 90, 80]` yielding display ranks `[1, 1, 3]`, plus a no-tie case.

**Implementation:** Derive display ranks from the published tie-group snapshot in `LiveRoundPanel` (or a small pure helper), not from the row index. Leave ranking computation/authority in the domain snapshot; the UI only renders the published rank.

**Verification:** focused web test, web type-check, and client check.

## Task 9: Update operational docs and cutover smoke contracts

1. Update the Plus cutover design/runbook/development baseline with the worker service, image target, trusted-proxy setting, and 128 MiB reverse-proxy ceiling.
2. Extend `scripts/cutover-smoke.mjs` operational checks so the deployment exposes a relay health/lag signal or an equivalent API-observable outbox-head advancement check, and document how to run it with the worker stopped as a negative smoke.
3. Add audit references to the new historical read-only and correction behavior where the existing contracts describe import and lifecycle.

## Task 10: Full verification and handoff

1. Run focused tests after each task, then run `pnpm -C plus run check`, `pnpm -C plus run test` with `REQUIRE_DB=1`, the relevant Django exporter test, `uv run pytest tests/gates -q`, and `git diff --check`.
2. Review the configuration sweep: TypeScript includes, Compose/env variables, proxy configs, and relevant docs all match the implemented tree.
3. Run the verification-before-completion checklist with fresh command output, inspect the final diff/status, and report any environment-limited checks explicitly.
4. Commit only the scoped changes with a conventional `fix:` message. Keep the feature branch until verification and remote state are confirmed; do not merge/push without the repository workflow’s explicit final integration step.
