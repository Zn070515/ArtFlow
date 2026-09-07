# Client Tooling Micro-Refactor Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. This repository rule requires inline execution without subagents or worktrees.

**Goal:** Generalize the TypeScript client boundary, enforce strict indexed-access checks, partition Rapid Score drafts by operator, and add a bounded Pyright evaluation without changing server authority or introducing a browser test stack.

**Architecture:** Django templates and WhiteNoise continue serving tracked classic JavaScript artifacts from static/dist. All frontend TypeScript files compile from frontend/**/*.ts into static/dist, and Node tests execute the emitted artifact. Pyright is added as a local, explicitly scoped static-analysis command alongside the existing mypy/Ruff toolchain; Playwright remains a documented future trigger rather than part of this micro-refactor.

**Tech Stack:** Python 3.12–3.13, Django 6, Node 22 in CI, npm, TypeScript 7.0.2, tsc, Pyright, node:test, PostgreSQL, Docker Compose, WhiteNoise.

**Spec:** docs/superpowers/specs/2026-09-07-client-tooling-micro-refactor-design.md

## Global Constraints

- Work directly in the repository checkout; never create or use .worktree, worktrees, or linked worktrees.
- Do not spawn subagents; execute edits and reviews directly in this session.
- Start implementation from a clean, up-to-date main and retain the feature branch until merge and push are verified.
- Track static/dist/*.js because the Docker runtime does not build frontend assets.
- Preserve the Rapid Score payload, command_id, base_version, CSRF, same-origin API behavior, 409 handling, retry policy, and server authority.
- Use operator identity only as a local-storage partition key; it is not authorization and must not be trusted by the backend.
- Keep TypeScript strict, avoid any, narrow unknown values, and fail closed when required DOM/data attributes are missing.
- Do not implement score-clearing semantics, AudienceScore migration, Judge/Gate/Ticket/Vote changes, or server-side authority/lock/audit/receipt changes.
- Do not add Playwright, esbuild, Vite, React, Vue, Next.js, ESM runtime delivery, or another bundler in this micro-refactor.
- Do not run Pyright over the whole repository, make it a CI gate, or replace mypy.
- Do not commit staticfiles, media, node_modules, caches, local databases, secrets, or unrelated generated files.

---

### Task 1: Lock operator-isolated client behavior with a failing test

**Files:**
- Move: tests/rapid_score_client.test.mjs to tests/client/rapid_score.test.mjs
- Modify: tests/client/rapid_score.test.mjs
- Read-only reference: frontend/rapid_score.ts, templates/staff_panel/rapid_score_entry.html

**Interfaces:**
- Consumes the current classic-script bootstrap contract exposed by static/dist/rapid_score.js.
- Produces a test contract requiring a data-operator-id value to partition pending drafts.

- [ ] Step 1: Rename the client test directory and file.

Run:
~~~powershell
New-Item -ItemType Directory -Force tests/client | Out-Null
git mv tests/rapid_score_client.test.mjs tests/client/rapid_score.test.mjs
~~~

- [ ] Step 2: Update the emitted-artifact path in the moved test.

Change the test's readFileSync path from ../static/dist/rapid_score.js to ../../static/dist/rapid_score.js. Preserve its vm filename and all existing assertions.

- [ ] Step 3: Make the test boot helper provide an operator identity.

Extend boot options with operatorId defaulting to "7", and add operatorId to the fake root dataset. Change the pending-key expectation to:

~~~text
artflow:rapid-score:pending:44:55:7:/staff/rounds/55/scores/api/
~~~

- [ ] Step 4: Add the exact operator-isolation regression test.

Append this test to tests/client/rapid_score.test.mjs:

~~~javascript
test("pending drafts are isolated by operator identity", () => {
  const storage = new FakeStorage();
  const firstOperator = boot({ storage, operatorId: "7" });
  firstOperator.input.value = "91";
  firstOperator.input.dispatch("input");
  assert.equal(storage.records().length, 1);
  assert.equal(storage.records()[0].cells[0].score, "91");

  const secondOperator = boot({ storage, operatorId: "8" });
  assert.equal(secondOperator.input.value, "");
  assert.equal(secondOperator.pendingCount.textContent, "0");
});
~~~

- [ ] Step 5: Add a fail-closed test for a missing operator identity.

Extend boot to accept an operatorId value and create a runtime with operatorId set to an empty string. Dispatch an edit and assert that storage.records() remains empty and pendingCount.textContent remains "". This test proves that an absent server-rendered identity cannot create or restore a draft.

- [ ] Step 6: Run the test and verify it fails for the intended reason.

Run: npm run test:client

Expected: the new isolation assertion fails because the production key is still unscoped by operator; existing assertions should remain informative. Do not change production code in this task to hide the failure.

- [ ] Step 7: Commit the red test.

Run:
~~~powershell
git add tests/client/rapid_score.test.mjs
git commit -m "test: scope rapid score drafts by operator"
~~~

### Task 2: Generalize the TypeScript build boundary and strict compiler flags

**Files:**
- Modify: tsconfig.client.json
- Modify: package.json
- Modify: .gitignore

**Interfaces:**
- Consumes all TypeScript files under frontend/**/*.ts.
- Produces static/dist/*.js with noEmitOnError and the npm commands build:client, check:client, and test:client.

- [ ] Step 1: Replace the single-entry TypeScript include with the approved compiler configuration.

tsconfig.client.json must contain:

~~~json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noEmitOnError": true,
    "module": "ES2020",
    "rootDir": "frontend",
    "outDir": "static/dist",
    "declaration": false,
    "sourceMap": false,
    "newLine": "lf",
    "forceConsistentCasingInFileNames": true
  },
  "include": ["frontend/**/*.ts"],
  "exclude": ["frontend/**/*.d.ts"]
}
~~~

- [ ] Step 2: Add the client build, freshness, and test scripts.

In package.json, use these exact script values:

~~~json
"build:client": "tsc -p tsconfig.client.json",
"check:client": "npm run build:client && git diff --exit-code -- static/dist/",
"test:client": "node --test tests/client/*.test.mjs"
~~~

Do not add a bundler or browser dependency.

- [ ] Step 3: Keep only emitted JavaScript artifacts explicitly trackable.

After the existing dist/ ignore rule in .gitignore, add:

~~~text
!static/dist/
!static/dist/*.js
~~~

- [ ] Step 4: Run the generalized compiler and capture the strict diagnostics.

Run: npm run build:client

Expected: compiler diagnostics identify concrete indexed-access or return-path issues in the current client source, and no artifact is emitted when compilation fails because noEmitOnError is enabled.

- [ ] Step 5: Commit the build-boundary changes.

Run:
~~~powershell
git add tsconfig.client.json package.json .gitignore
git commit -m "build: generalize TypeScript client boundary"
~~~

### Task 3: Implement operator-scoped Rapid Score storage and strict narrowing

**Files:**
- Modify: templates/staff_panel/rapid_score_entry.html
- Modify: frontend/rapid_score.ts
- Modify: tests/client/rapid_score.test.mjs
- Regenerate: static/dist/rapid_score.js

**Interfaces:**
- Consumes the root data attributes activity-id, round-id, api-url, and operator-id.
- Produces the same Rapid Score API request and response behavior, with pendingStorageKey additionally scoped by operatorId.
- Keeps the classic-script global/bootstrap behavior used by the template and Node harness.

- [ ] Step 1: Add the operator identity data attribute to the Rapid Score root.

Add this attribute to the existing root element without removing or renaming any current attribute:

~~~html
data-operator-id="{{ request.user.pk }}"
~~~

- [ ] Step 2: Read and validate operatorId before constructing the storage key.

In frontend/rapid_score.ts, read container.dataset.operatorId and fail closed unless it matches a positive decimal user id:

~~~typescript
const operatorId = container.dataset.operatorId || "";
if (!/^[1-9]\d*$/.test(operatorId)) {
  return;
}
~~~

Place this guard before pending storage initialization. Do not use this value for permission decisions or API authorization.

- [ ] Step 3: Construct the exact operator-scoped storage key.

Use:

~~~typescript
const pendingStorageKey =
  "artflow:rapid-score:pending:" +
  activityId +
  ":" +
  roundId +
  ":" +
  operatorId +
  ":" +
  apiUrl;
~~~

Do not read the old unscoped key. Do not modify the API URL, request payload, command_id, base_version, CSRF, retry, conflict, or server-error behavior.

- [ ] Step 4: Resolve every strict compiler diagnostic with local narrowing.

Use explicit checks for parts[0] and parts[1], rows[index], the target column, and cols[index]. Treat parsed JSON and local-storage values as unknown until validated. Guard nullable DOM lookups and state.cells/state.conflicts before use. Add explicit returns for all branches required by noImplicitReturns. Do not introduce any, innerHTML, eval, new Function, or document.write.

- [ ] Step 5: Rebuild the tracked runtime artifact.

Run: npm run build:client

Expected: PASS and static/dist/rapid_score.js is regenerated from frontend/rapid_score.ts. The artifact remains a classic script and contains no sourceMappingURL.

- [ ] Step 6: Run focused client tests.

Run: npm run test:client

Expected: PASS, including the operator-isolation test and all existing behavior assertions.

- [ ] Step 7: Verify deterministic output and freshness.

Run:
~~~powershell
npm run build:client
Copy-Item static/dist/rapid_score.js "$env:TEMP/rapid_score.first.js"
npm run build:client
$comparison = Compare-Object (Get-Content -Raw "$env:TEMP/rapid_score.first.js") (Get-Content -Raw static/dist/rapid_score.js)
if ($comparison) { $comparison; exit 1 }
npm run check:client
~~~

Expected: the second build produces byte-identical output and check:client passes.

- [ ] Step 8: Commit the implementation and generated artifact.

Run:
~~~powershell
git add templates/staff_panel/rapid_score_entry.html frontend/rapid_score.ts tests/client/rapid_score.test.mjs static/dist/rapid_score.js
git commit -m "fix: isolate rapid score drafts by operator"
~~~

Only include static/dist files actually generated by the approved TypeScript inputs; do not add unrelated generated files.

### Task 4: Add a bounded Pyright evaluation beside mypy

**Files:**
- Modify: pyproject.toml
- Modify: uv.lock
- Modify: package.json
- Create: pyrightconfig.json

**Interfaces:**
- Consumes the existing uv-managed development environment and the explicitly selected high-risk Python modules.
- Produces npm run check:pyright as a local, non-CI-blocking evaluation command.

- [ ] Step 1: Add Pyright through the locked development dependency workflow.

Run:

~~~powershell
uv add --dev "pyright>=1.1,<2"
~~~

Confirm pyproject.toml and uv.lock change consistently and no global Python package is installed.

- [ ] Step 2: Create the exact bounded Pyright configuration.

Create pyrightconfig.json:

~~~json
{
  "include": [
    "common/authority.py",
    "core/services.py",
    "staff_panel/views.py",
    "singer_contest/services.py"
  ],
  "exclude": [
    "**/migrations",
    "**/tests.py",
    "**/test_*.py",
    "tests",
    "static",
    "staticfiles",
    "media"
  ],
  "typeCheckingMode": "standard",
  "pythonVersion": "3.12",
  "venvPath": ".",
  "venv": ".venv"
}
~~~

- [ ] Step 3: Add the local command without adding it to CI.

In package.json add:

~~~json
"check:pyright": "uv run pyright"
~~~

Keep mypy and existing CI type checks unchanged. Do not add a Pyright workflow invocation.

- [ ] Step 4: Run Pyright and record the actual baseline.

Run: npm run check:pyright

Expected: the command runs against only the four listed modules. If it reports existing diagnostics, preserve the full command output in the implementation handoff and do not broaden scope or suppress errors; the command is informational in this micro-refactor.

- [ ] Step 5: Commit the bounded evaluation toolchain.

Run:
~~~powershell
git add pyproject.toml uv.lock package.json pyrightconfig.json
git commit -m "build: add scoped Pyright evaluation"
~~~

### Task 5: Document commands and verify existing consumers

**Files:**
- Modify: AGENTS.md
- Read-only verification: .github/workflows/ci.yml, .github/workflows/integration.yml, templates/staff_panel/rapid_score_entry.html, config/tests.py, package-lock.json

**Interfaces:**
- Documents the three new local commands and the distinction between tracked runtime artifacts, mypy, and scoped Pyright.
- Preserves the current CI, integration, and static smoke contracts.

- [ ] Step 1: Add the client and Pyright commands to the repository command list.

Add these commands to AGENTS.md's Build, Test, and Development Commands block:

~~~text
npm run check:client
npm run test:client
npm run check:pyright
~~~

Document that check:client and test:client are required client checks, while check:pyright is a local scoped evaluation and is not a CI-blocking gate. Retain the Node 22 artifact rule and the existing mypy command.

- [ ] Step 2: Confirm CI already builds and tests the tracked client artifact.

Inspect .github/workflows/ci.yml and verify Node 22 setup, npm ci, npm run check:client, and npm run test:client are present in the existing client/static verification path. Do not add duplicate workflow jobs.

- [ ] Step 3: Confirm integration serves the expected hashed asset.

Inspect .github/workflows/integration.yml and config/tests.py. Confirm the template resolves static/dist/rapid_score.js, the integration check accepts the pattern ^/static/dist/rapid_score\.[0-9a-f]+\.js$, and the resolved asset returns HTTP 200 while a missing asset returns HTTP 404. Do not change integration behavior unless the inspected contract is actually broken.

- [ ] Step 4: Check for stale paths and forbidden dependencies.

Run:

~~~powershell
rg -n "static/js/rapid_score|js/rapid_score\.js" --glob '!staticfiles/**' --glob '!media/**' .
rg -n "playwright|esbuild|vite|react|vue|next" package.json package-lock.json pyproject.toml uv.lock frontend templates .github
~~~

Expected: no stale Rapid Score path and no forbidden new dependency introduced by this plan.

- [ ] Step 5: Commit the documentation update.

Run:
~~~powershell
git add AGENTS.md
git commit -m "docs: document client tooling checks"
~~~

### Task 6: Run full verification and perform two self-review passes

**Files:**
- Read-only verification: all modified files, .github/workflows, scripts, Docker Compose configuration
- Modify only if a review defect is found: the smallest affected scoped file, followed by a focused fix commit

**Interfaces:**
- Verifies the client build, emitted artifact, local Python analysis, Django checks, repository tests, workflow contracts, static collection, and Docker acceptance path.
- Produces a clean diff with no contract, semantic, or security regression.

- [ ] Step 1: Install the locked JavaScript dependencies.

Run: npm ci

Expected: success using package-lock.json; do not commit node_modules.

- [ ] Step 2: Run local client and Python quality gates.

Run each command:

~~~powershell
npm run check:css
npm run check:client
npm run test:client
npm run check:pyright
$env:DEBUG = "False"
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run ruff check .
uv run ruff format --check .
uv run python scripts/verify_workflows.py .github/workflows --require ci.yml --require integration.yml --require security.yml --require workflow-lint.yml
uv run pytest -q --cov --cov-report=term-missing
~~~

Expected: every command except a pre-existing Pyright diagnostic baseline exits zero. Report any Pyright diagnostics exactly and do not call the overall verification green if a newly introduced diagnostic is present.

- [ ] Step 3: Rehearse static collection and restore the checkout safely.

Run the following PowerShell sequence from the repository root. It moves an existing ignored staticfiles directory to an explicit temporary location, collects and checks the manifest, moves the newly collected output to the same temporary location, restores the original directory, and removes only the explicitly named temporary rehearsal directory:

~~~powershell
$repoRoot = (Get-Location).Path
$rehearsalRoot = Join-Path $repoRoot ".artflow-static-rehearsal"
$sourceStaticRoot = Join-Path $repoRoot "staticfiles"
$originalStaticRoot = Join-Path $rehearsalRoot "staticfiles-original"
$collectedStaticRoot = Join-Path $rehearsalRoot "staticfiles-collected"
New-Item -ItemType Directory -Force -Path $rehearsalRoot | Out-Null
$hadOriginal = Test-Path -LiteralPath $sourceStaticRoot
try {
  if ($hadOriginal) {
    Move-Item -LiteralPath $sourceStaticRoot -Destination $originalStaticRoot
  }
  $env:DEBUG = "False"
  uv run python manage.py collectstatic --noinput
  uv run python manage.py shell -c "from django.contrib.staticfiles.storage import staticfiles_storage; assert staticfiles_storage.url('dist/rapid_score.js').startswith('/static/')"
  Move-Item -LiteralPath $sourceStaticRoot -Destination $collectedStaticRoot
} finally {
  if (Test-Path -LiteralPath $sourceStaticRoot) {
    Move-Item -LiteralPath $sourceStaticRoot -Destination $collectedStaticRoot
  }
  if ($hadOriginal -and (Test-Path -LiteralPath $originalStaticRoot)) {
    Move-Item -LiteralPath $originalStaticRoot -Destination $sourceStaticRoot
  }
  if (Test-Path -LiteralPath $rehearsalRoot) {
    Remove-Item -LiteralPath $rehearsalRoot -Recurse -Force
  }
}
~~~

The command must leave the original staticfiles directory exactly where it was, or leave no staticfiles directory if none existed before. It must not delete source static assets, media, Docker volumes, or any broad workspace path.

- [ ] Step 4: Run focused Rapid Score and operator regression tests.

Run:

~~~powershell
$env:DEBUG = "False"
uv run pytest -q staff_panel/tests.py staff_panel/tests_operator_e2e.py -k "rapid or score or operator"
npm run test:client
~~~

Expected: all selected Django and Node tests pass.

- [ ] Step 5: Run the PostgreSQL and Docker acceptance checks.

Run:

~~~powershell
pwsh -NoProfile -File scripts/verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
docker compose up --build --wait
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/healthz/
~~~

Resolve the container's hashed CSS and JS URLs and verify they return HTTP 200; verify a missing static asset returns HTTP 404. Leave source services and volumes intact. Never run docker compose down --volumes.

- [ ] Step 6: Perform the first self-review for contract and semantic consistency.

Inspect git diff and verify all of these points:
- operatorId changes only the browser storage partition;
- API URL, payload, command_id, base_version, CSRF, retries, and 409 handling are unchanged;
- empty score remains the current no-op behavior and no clear-score contract was added;
- all existing authority, lock, audit, receipt, and migration paths are unchanged;
- static/dist/rapid_score.js is the exact deterministic output of the TypeScript source;
- no ESM runtime delivery or stale static/js path exists;
- no unapproved feature area was touched.

- [ ] Step 7: Perform the second self-review for security and code logic.

Run:

~~~powershell
rg -n "\bany\b|innerHTML|outerHTML|document\.write|eval\(|new Function|sourceMappingURL|http://|https://" frontend static/dist tests/client
git diff --check
git status --short --untracked-files=all
~~~

Confirm that local-storage and JSON values are narrowed from unknown, DOM output uses textContent, missing operator identity fails closed, same-origin behavior remains intact, compiler errors cannot emit artifacts, and no secrets, uploads, databases, caches, or generated staging output are in the diff.

- [ ] Step 8: Fix any review defect with a focused commit and repeat the affected checks.

If either review finds a defect, modify only the smallest affected scoped file, run its focused test plus npm run check:client and npm run test:client when client code is involved, then repeat both self-review passes and commit with the appropriate conventional prefix. Do not weaken a test or suppress a diagnostic to make a check pass.

### Task 7: Push the branch, merge non-fast-forward into main, and push main

**Files:**
- Git state only; no source files are intentionally changed in this task

**Interfaces:**
- Consumes a verified feature branch with all scoped commits.
- Produces origin/main containing the verified non-fast-forward merge, while retaining the feature branch.

- [ ] Step 1: Rename the planning branch to the implementation branch before publishing it.

Run:

~~~powershell
git branch --show-current
git branch -m build/client-tooling-micro-refactor
~~~

Expected: current branch is build/client-tooling-micro-refactor and the working tree is clean except for no uncommitted intended changes.

- [ ] Step 2: Review the final feature diff.

Run:
~~~powershell
git diff --name-only main...
git status --short --branch
git diff --check
~~~

Expected: only the approved spec/plan and micro-refactor files appear; no worktree path, secret, upload, database, cache, or unrelated generated file appears.

- [ ] Step 3: Push the feature branch with the configured proxy fallback.

Try direct push first:

~~~powershell
git push -u origin build/client-tooling-micro-refactor
~~~

If the direct push times out, retry the same operation through the local proxy:

~~~powershell
git -c http.proxy=http://127.0.0.1:12334 -c https.proxy=http://127.0.0.1:12334 push -u origin build/client-tooling-micro-refactor
~~~

- [ ] Step 4: Update main with fast-forward-only pull.

Run:

~~~powershell
git switch main
git pull --ff-only origin main
~~~

If the pull times out, retry through the same local proxy:

~~~powershell
git -c http.proxy=http://127.0.0.1:12334 -c https.proxy=http://127.0.0.1:12334 pull --ff-only origin main
~~~

Do not reset or discard incoming or local changes.

- [ ] Step 5: Merge the verified branch with a non-fast-forward merge.

Run:

~~~powershell
git merge --no-ff build/client-tooling-micro-refactor -m "merge: add client tooling micro-refactor"
~~~

Expected: the merge succeeds without conflicts and preserves a merge commit.

- [ ] Step 6: Push main, using the proxy only if the direct push times out.

Try:

~~~powershell
git push origin main
~~~

On timeout, retry:

~~~powershell
git -c http.proxy=http://127.0.0.1:12334 -c https.proxy=http://127.0.0.1:12334 push origin main
~~~

- [ ] Step 7: Confirm remote state and retain the feature branch.

Run:

~~~powershell
git fetch origin
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
git branch --list build/client-tooling-micro-refactor
~~~

Expected: HEAD equals origin/main, the working tree is clean, and build/client-tooling-micro-refactor remains available locally and remotely.
