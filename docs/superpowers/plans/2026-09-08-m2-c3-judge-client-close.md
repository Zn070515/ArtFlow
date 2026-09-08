# M2-C3 Judge Client Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Close the Judge terminal loop with server-owned display context, loss-resistant local drafts, polling/stale recovery, and rubric criterion scoring that atomically materializes the authoritative total and criterion facts.

**Architecture:** Keep all writes inside `singer_contest.judge_authority`. Extend the existing `JudgeContext` and score service contracts, then keep HTTP views thin. Replace the one-field client draft with a bounded per-context draft store and a 2-second non-overlapping context poller. Render criteria from server context and submit criterion IDs/values; the server validates the exact bound rubric, computes the 0–100 total, and writes `ScoreRecord`, `CriterionScore`, receipt, and audit atomically.

**Tech Stack:** Django 6, existing Judge authority services, TypeScript compiled with the repository client compiler, Node client tests, Django `TestCase`, PostgreSQL focused tests, and existing Playwright smoke.

**Spec:** `docs/superpowers/specs/2026-09-08-m2-c3-judge-client-close.md`

## Global Constraints

- Do not use `.worktree/`, linked worktrees, or subagents; work directly on the current feature branch.
- Every logical change is a small conventional commit with its focused gate run first.
- Do not add a second ORM write path for score facts, criterion facts, receipts, panel state, or performance state.
- A Judge request may never select its own activity, round, judge, seat, singer, performance target, source, or panel. Expected context values are equality guards only.
- Do not trust client totals. For a rubric round, require the exact bound criterion set and compute the total in the authority service.
- Do not persist bearer tokens, QR fragments, complete context payloads, or unnecessary personal data in local storage, logs, templates, or audit values.
- Preserve the existing no-store, generic-error, origin, bearer, body-size, rate-limit, CSRF, and idempotency boundaries.
- Before commits containing production Python, run `npm run check:pyright` and `npm run check:pyright:entry-access`; both must remain zero-diagnostic.
- Push feature commits, merge with `--no-ff` into `main`, then push `main`; retry a timed-out push through `127.0.0.1:12334`.

---

### Task 1: Add failing authority and HTTP rubric contracts (RED)

**Files:**

- Modify: `singer_contest/test_judge_authority.py`
- Modify: `singer_contest/test_judge_http.py`

**Interfaces:**

- `JudgeContext` must expose round/performance display fields and criterion IDs/descriptions.
- A bound rubric with criterion max scores totaling 100 accepts a complete criterion payload and creates one total plus one `CriterionScore` per criterion.
- Total-only payloads on rubric rounds, incomplete/duplicate/foreign/out-of-range criteria, invalid precision, and forged totals must fail without partial writes.

- [ ] **Step 1: Extend test fixtures with a bound rubric and two criteria.**

  Keep existing total-only tests for no-rubric compatibility. Add explicit test data with max scores that sum to 100 and a performance song title.

- [ ] **Step 2: Add RED authority tests.**

  Cover context display fields, successful atomic materialization, rollback when a criterion write fails, exact-set validation, server-computed total, idempotent replay, payload conflict, and stale/HOLD/panel guards.

- [ ] **Step 3: Add RED HTTP tests.**

  Assert the new context JSON shape, generic errors, and the score endpoint keeps its exact top-level request contract while rejecting malformed rubric payloads.

- [ ] **Step 4: Run the focused tests and verify the failure is the missing C3 behavior.**

  ```powershell
  python manage.py test singer_contest.test_judge_authority singer_contest.test_judge_http
  ```

- [ ] **Step 5: Commit the RED contract tests.**

  ```powershell
  git add singer_contest/test_judge_authority.py singer_contest/test_judge_http.py
  git commit -m "test: define m2-c3 judge rubric contracts"
  ```

### Task 2: Extend the server authority payload and context

**Files:**

- Modify: `singer_contest/judge_authority.py`
- Modify: `singer_contest/test_judge_authority.py`
- Modify: `singer_contest/test_judge_http.py`

**Interfaces:**

- Add minimal display fields to `JudgeContext` and return them only for the current server-owned performance.
- Include `criterion_id` and `description` in rubric metadata.
- Keep `performance_id` nullable and avoid returning unrelated personal profile fields.

- [ ] **Step 1: Implement context fields and safe nullable display values.**

  Load the current performance only through the locked round/activity context. Use the existing `Performance.singer` and `ContestRound` relationships; do not accept client-selected IDs.

- [ ] **Step 2: Add exact context serialization tests and run them.**

  ```powershell
  python manage.py test singer_contest.test_judge_authority.JudgeAuthorityTests singer_contest.test_judge_http.JudgeRouteContractTests
  ```

- [ ] **Step 3: Run Pyright and commit the isolated context contract.**

  ```powershell
  npm run check:pyright
  npm run check:pyright:entry-access
  git add singer_contest/judge_authority.py singer_contest/test_judge_authority.py singer_contest/test_judge_http.py
  git commit -m "feat: expose server-owned judge display context"
  ```

### Task 3: Add shared rubric normalization and atomic criterion materialization

**Files:**

- Modify: `singer_contest/judge_authority.py`
- Modify: `singer_contest/test_judge_authority.py`
- Modify: `singer_contest/models.py` only if a narrow `TYPE_CHECKING` declaration is required

**Interfaces:**

- Normalize no-rubric total payloads and bound-rubric criterion payloads into one internal representation.
- Require rubric max-score sum of exactly 100 for electronic criterion submission.
- Validate criterion IDs, duplicate/missing sets, decimal precision, bounds, unknown keys, notes length, and server-computed total.
- Materialize `ScoreRecord` and `CriterionScore` under the existing `_authorized_score_fact_write()` scope, then complete the existing receipt under `JUDGE_SCORE_SUBMISSION`.
- Reuse the normalization/materialization path for direct judge, STAFF_PROXY, and PAPER_DR without changing their source provenance rules.

- [ ] **Step 1: Implement pure normalization helpers with bounded input.**

  Never use a client-supplied `score` as the authoritative total for rubric payloads. Preserve the existing no-rubric compatibility path and stable validation reason semantics.

- [ ] **Step 2: Replace direct-only materialization with the shared authority helper.**

  Keep transaction boundaries, row locks, duplicate fact checks, payload hashing, receipt replay, and audit output intact. Criterion rows must be created only after all validation succeeds.

- [ ] **Step 3: Add success, rollback, source, and authority regression tests.**

  Verify no `ScoreRecord` or `CriterionScore` survives any failed submission and that locked-round direct ORM protections remain unchanged.

- [ ] **Step 4: Run focused tests, Pyright, and commit.**

  ```powershell
  python manage.py test singer_contest.test_judge_authority singer_contest.test_core_raw_close common.test_authority_matrix
  npm run check:pyright
  npm run check:pyright:entry-access
  git add singer_contest/judge_authority.py singer_contest/test_judge_authority.py singer_contest/models.py
  git commit -m "feat: atomically materialize judge rubric scores"
  ```

### Task 4: Close HTTP error and request contracts

**Files:**

- Modify: `singer_contest/judge_views.py`
- Modify: `singer_contest/test_judge_http.py`

**Interfaces:**

- Keep the exact top-level score request keys and body-size/rate-limit/origin/bearer checks.
- Map new validation reason codes to stable generic response codes without leaking criterion internals or server exceptions.
- Context and score responses remain no-store.

- [ ] **Step 1: Add/adjust stable rubric error mapping tests.**
- [ ] **Step 2: Implement only the mapping and leave authority decisions in `judge_authority.py`.**
- [ ] **Step 3: Run HTTP focused tests and commit.**

  ```powershell
  python manage.py test singer_contest.test_judge_http
  git add singer_contest/judge_views.py singer_contest/test_judge_http.py
  git commit -m "fix: harden judge rubric http contract"
  ```

### Task 5: Add client RED tests for drafts, polling, and rubric UI

**Files:**

- Modify: `tests/client/judge_terminal.test.mjs`

**Interfaces:**

- Input before submit persists a bounded draft after debounce.
- Drafts are isolated by context fingerprint and do not include bearer/fragment/extra personal data.
- Polling updates current performance and HOLD state without overlapping requests.
- Stale response triggers context refresh and retains the old draft under the old fingerprint.
- No-rubric and rubric payloads are both serialized correctly; rubric total is display-only.

- [ ] **Step 1: Add deterministic fake timers or controllable timeout hooks to the client harness.**
- [ ] **Step 2: Add RED tests for immediate draft persistence, context change isolation, poll updates, retry command reuse, and criterion payload serialization.**
- [ ] **Step 3: Run the client test and verify RED.**

  ```powershell
  npm run test:client
  ```

- [ ] **Step 4: Commit the client RED tests.**

  ```powershell
  git add tests/client/judge_terminal.test.mjs
  git commit -m "test: define m2-c3 judge terminal behavior"
  ```

### Task 6: Implement TypeScript Judge terminal and template

**Files:**

- Modify: `frontend/judge_terminal.ts`
- Modify: `templates/singer_contest/judge_terminal.html`
- Generated: `static/dist/judge_terminal.js`
- Modify: `tests/client/judge_terminal.test.mjs` only for harness corrections discovered during implementation

**Interfaces:**

- Parse and render the expanded context with strict runtime guards.
- Render criterion inputs from server metadata using safe DOM APIs; calculate a read-only display total.
- Store a bounded per-context draft collection with a 200ms debounce; clear only the matching command on success.
- Poll every 2 seconds with no overlap and bounded backoff; update display/state while never auto-applying an old draft to a new performance.
- Disable scoring for no-performance/HOLD/non-scoring state and surface generic session/network/stale messages.
- Reuse the same command ID for network retry and disable duplicate click submissions.
- Never log or persist the session token or URL fragment.

- [ ] **Step 1: Implement parse/render helpers and add the display/criterion markup.**
- [ ] **Step 2: Implement draft persistence and input listeners before submit handling.**
- [ ] **Step 3: Implement non-overlapping context polling and stale recovery.**
- [ ] **Step 4: Implement no-rubric and rubric score payload serialization.**
- [ ] **Step 5: Compile and run the client checks.**

  ```powershell
  npm run check:client
  npm run test:client
  ```

- [ ] **Step 6: Commit source and generated output together.**

  ```powershell
  git add frontend/judge_terminal.ts templates/singer_contest/judge_terminal.html static/dist/judge_terminal.js tests/client/judge_terminal.test.mjs
  git commit -m "feat: close judge terminal client loop"
  ```

### Task 7: Extend operational coverage and update readiness documentation

**Files:**

- Modify: `tests/e2e/judge_terminal.spec.ts` or the existing Playwright smoke file selected by repository layout
- Modify: `docs/production-readiness.md`
- Modify: `docs/superpowers/specs/2026-09-08-m2-c3-judge-client-close.md` only if implementation review finds a contract correction

- [ ] **Step 1: Add read-only browser assertions for current performance, rubric display, HOLD state, and no-store/context behavior.**

  Do not put bearer tokens in test output or screenshots. Keep credentialed submit coverage within the existing safe test boundary.

- [ ] **Step 2: Record M2-C3 verification scope and any remaining school/deployment HOLDs.**

  Explicitly distinguish local client/authority coverage from PostgreSQL race, real credential flow, TLS/WAF/DDoS, school IdP/MFA, and data-retention acceptance.

- [ ] **Step 3: Run focused browser/docs gates and commit.**

  ```powershell
  npm run test:e2e
  pwsh -NoProfile -File scripts/check_docs.ps1
  git add docs/production-readiness.md tests/e2e
  git commit -m "test: rehearse m2-c3 judge terminal"
  ```

### Task 8: Two-round review and full verification

- [ ] **Step 1: Self-review round one — contract and authority.**

  Inspect the diff and search for direct writes or target trust:

  ```powershell
  rg -n "ScoreRecord\.objects\.create|CriterionScore\.objects\.create|singer_id|judge_id|seat_id|performance_id" singer_contest/judge_views.py frontend/judge_terminal.ts templates/singer_contest/judge_terminal.html
  git diff --check
  ```

  Confirm every mutation is service-owned, every rubric criterion is bound to the server rubric, total score is server-computed, context changes cannot retarget a draft, and no token reaches storage/logs/UI text.

- [ ] **Step 2: Self-review round two — failure, concurrency, privacy, and semantic consistency.**

  Review malformed JSON, oversized input, missing/expired bearer, cross-origin requests, duplicate clicks, retry after lost ACK, simultaneous Staff advance, HOLD, panel change, no current performance, localStorage failure/quota, polling overlap, generated JS freshness, and all source paths. Add isolated regression fixes with their own tests and commits.

- [ ] **Step 3: Run the complete local gates.**

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

- [ ] **Step 4: Run Docker/PostgreSQL focused verification without destroying source state.**

  Use the already-running Compose database or a separate temporary target. Never run `docker compose down --volumes`, reset the source database, or drop source volumes. Run PostgreSQL authority/race tests and the backup/restore rehearsal when host-port conditions permit; record any environmental HOLD accurately.

- [ ] **Step 5: Verify final Git state, push feature, merge non-fast-forward, and push main.**

  ```powershell
  git status --short
  git diff --check
  git push origin feat/m2-c3-judge-client-close
  git switch main
  git pull --ff-only origin main
  git merge --no-ff feat/m2-c3-judge-client-close -m "merge: integrate m2-c3 judge client close"
  git push origin main
  ```

  If a push times out, retry with `git -c http.proxy=http://127.0.0.1:12334 -c https.proxy=http://127.0.0.1:12334 push ...`. Keep the feature branch until remote main and final clean status are verified.

