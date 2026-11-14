# Plus Release Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Make the ArtFlow-Plus release path publish three immutable, source-identifiable images and make production deployment reject Plus images that do not match the deployed commit.

**Architecture:** Keep the v1 release job intact and add a separate Plus release job to the tag-authorized workflow. The Plus multi-stage Dockerfile will bake the same full Git SHA into API, Worker, and Web artifacts; API and Worker will fail closed when the runtime SHA differs from the baked SHA. The production deploy validator will render the Plus profile and validate all three Plus image references and runtime provenance.

**Tech Stack:** GitHub Actions, Docker Buildx, Node 24, Fastify/TypeScript, Bash, Python pytest, Docker Compose.

**Spec:** \`docs/artflow-plus/self-build-checklist.md\`, \`docs/invariants/deployment.md\`, \`docs/artflow-plus/cutover-runbook.md\`.

## Global Constraints

- The \`v*\` tag remains the only release authority.
- \`plus-api\`, \`plus-worker\`, and \`plus-web\` must be built from the same tagged commit SHA.
- Production must use immutable image digests; mutable Plus tags are rejected by the deployment validator.
- The Plus API and Worker fail closed in production when the host release SHA is missing or differs from the baked SHA.
- Do not change v1 runtime behavior or require a real-activity rehearsal.
- Every production-code change has a test that failed before implementation.
- Keep each logical change independently verifiable with a conventional commit.

---

### Task 1: Add failing gates for the Plus release contract

**Files:**

- Modify: \`tests/gates/test_release_artifacts.py\`
- Modify: \`scripts/tests/test_posix_operations_contract.py\`

**Interfaces:**

- Consumes: \`publish.yml\`, \`deploy/plus/Dockerfile\`, \`deploy/compose.production.yml\`, and \`scripts/deploy.sh\`.
- Produces: assertions for the three Plus publish targets, baked SHA contract, digest-pinned Plus deployment, and runtime SHA validation.

- [ ] **Step 1: Write failing publish and Dockerfile assertions**

Require \`publish.yml\` to contain a Plus job with three \`docker/build-push-action\` invocations using \`file: deploy/plus/Dockerfile\`, targets \`api\`, \`worker\`, and \`web\), and the same tagged SHA build argument for every target. Require the Dockerfile to declare \`ARG ARTFLOW_BUILD_SHA\`, OCI revision labels, and a baked \`ARTFLOW_RELEASE_SHA\` marker for API, Worker, and Web.

- [ ] **Step 2: Write failing deployment assertions**

Require the deployment contract to read \`ARTFLOW_PLUS_API_IMAGE\`, \`ARTFLOW_PLUS_WORKER_IMAGE\`, and \`ARTFLOW_PLUS_WEB_IMAGE\`, validate each with the digest pattern for the Plus profile, and require the Plus API and Worker to receive the full release SHA.

- [ ] **Step 3: Run the focused tests and verify the expected red state**

Run:

~~~powershell
uv run pytest tests/gates/test_release_artifacts.py scripts/tests/test_posix_operations_contract.py -q
~~~

Expected: FAIL because the current workflow only builds the root Dockerfile, the Plus Dockerfile has no release marker, and \`scripts/deploy.sh\` validates only the v1 image set.

- [ ] **Step 4: Commit the red tests**

~~~powershell
git add tests/gates/test_release_artifacts.py scripts/tests/test_posix_operations_contract.py
git commit -m "test: define plus release provenance gates"
~~~

### Task 2: Bake and verify the Plus release SHA

**Files:**

- Create: \`plus/packages/runtime/src/release-provenance.ts\`
- Create: \`plus/packages/runtime/test/release-provenance.test.ts\`
- Modify: \`plus/packages/runtime/src/index.ts\`
- Modify: \`plus/apps/api/src/main.ts\`
- Modify: \`plus/apps/worker/src/main.ts\`
- Modify: \`deploy/plus/Dockerfile\`

**Interfaces:**

- Consumes: \`process.env.ARTFLOW_RELEASE_SHA\` and \`/app/ARTFLOW_RELEASE_SHA\`.
- Produces: \`assertReleaseProvenance(options?: { releaseFile?: string; env?: NodeJS.ProcessEnv }): void\` exported by \`@artflow-plus/runtime\`.

- [ ] **Step 1: Write failing runtime provenance tests**

Create tests for matching values, missing configured SHA in production, mismatched values in production, and absent marker in development:

~~~typescript
it("accepts matching baked and configured release SHAs", () => {
  expect(() => assertReleaseProvenance({
    releaseFile: "abc123",
    env: { NODE_ENV: "production", ARTFLOW_RELEASE_SHA: "abc123" },
  })).not.toThrow();
});

it("rejects a missing configured SHA in production", () => {
  expect(() => assertReleaseProvenance({
    releaseFile: "abc123",
    env: { NODE_ENV: "production" },
  })).toThrow(/ARTFLOW_RELEASE_SHA/);
});

it("rejects a mismatch in production", () => {
  expect(() => assertReleaseProvenance({
    releaseFile: "abc123",
    env: { NODE_ENV: "production", ARTFLOW_RELEASE_SHA: "def456" },
  })).toThrow(/does not match/);
});

it("allows a missing marker in development", () => {
  expect(() => assertReleaseProvenance({
    releaseFile: "",
    env: { NODE_ENV: "development" },
  })).not.toThrow();
});
~~~

- [ ] **Step 2: Run the test and verify the expected red state**

Run:

~~~powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/release-provenance.test.ts
~~~

Expected: FAIL because the helper and export do not exist.

- [ ] **Step 3: Implement the minimal provenance helper**

Use \`node:fs\` and \`node:path\`, defaulting to \`/app/ARTFLOW_RELEASE_SHA\`. In production require both values and exact equality. In non-production allow an absent marker, but reject an explicit mismatch when both values exist. Export the helper from the runtime package.

- [ ] **Step 4: Wire API and Worker startup**

Call \`assertReleaseProvenance()\` after environment/database prerequisites and before API listen or Worker relay startup, so a mismatched image cannot serve traffic or consume outbox work.

- [ ] **Step 5: Add the marker to every Plus target**

In \`deploy/plus/Dockerfile\`, pass \`ARTFLOW_BUILD_SHA\` into the build stage, write \`/src/ARTFLOW_RELEASE_SHA\`, redeclare the argument in API, Worker, and Web, add \`org.opencontainers.image.revision\` labels, copy the marker to \`/app/ARTFLOW_RELEASE_SHA\` for API/Worker, and copy it to \`/usr/share/nginx/html/ARTFLOW_RELEASE_SHA\` for Web.

- [ ] **Step 6: Run focused runtime verification**

Run:

~~~powershell
pnpm -C plus --filter @artflow-plus/runtime exec vitest run test/release-provenance.test.ts
pnpm -C plus run check
~~~

Expected: PASS.

- [ ] **Step 7: Commit the runtime provenance implementation**

~~~powershell
git add plus/packages/runtime plus/apps/api/src/main.ts plus/apps/worker/src/main.ts deploy/plus/Dockerfile
git commit -m "fix: verify plus runtime release provenance"
~~~

### Task 3: Publish all Plus targets from the tag workflow

**Files:**

- Modify: \`.github/workflows/publish.yml\`
- Modify: \`tests/gates/test_release_artifacts.py\`

**Interfaces:**

- Consumes: the existing tag trigger, GHCR login, metadata labels, and \`deploy/plus/Dockerfile\` targets.
- Produces: a tag-authorized job publishing \`plus-api\`, \`plus-worker\`, and \`plus-web\), with all three digests recorded in the GitHub summary.

- [ ] **Step 1: Add the Plus publish job**

Keep the v1 job unchanged. Add a \`publish-plus\` job with checkout, Buildx, GHCR login, metadata, provenance mode, and cache policy. Publish these image names:

~~~text
ghcr.io/<lowercase-repository>/plus-api
ghcr.io/<lowercase-repository>/plus-worker
ghcr.io/<lowercase-repository>/plus-web
~~~

Run one build-push action per target with \`file: deploy/plus/Dockerfile\`, its target, and the literal GitHub Actions build argument \`ARTFLOW_BUILD_SHA=\${{ github.sha }}\`. Record all three output digests and the source SHA.

- [ ] **Step 2: Run the release artifact gate**

~~~powershell
uv run pytest tests/gates/test_release_artifacts.py -q
~~~

Expected: PASS, including assertions that all three Plus images are published from the same SHA.

- [ ] **Step 3: Commit the publish workflow**

~~~powershell
git add .github/workflows/publish.yml tests/gates/test_release_artifacts.py
git commit -m "fix: publish immutable plus release images"
~~~

### Task 4: Make production deployment enforce the Plus profile

**Files:**

- Modify: \`scripts/deploy.sh\`
- Modify: \`scripts/tests/test_posix_operations_contract.py\`
- Modify: \`.env.production.example\`
- Modify: \`deploy/compose.production.yml\`
- Modify: \`docs/artflow-plus/cutover-runbook.md\`

**Interfaces:**

- Consumes: rendered Compose JSON, \`ARTFLOW_SITE_PROFILE=v2\`, the three Plus image variables, the Plus release marker, and Compose's explicit \`plus\` service profile.
- Produces: fail-closed Plus digest and release-SHA validation while preserving v1-only behavior.

- [ ] **Step 1: Add failing profile-aware deploy tests**

Require the deploy validator to read all three Plus service images and validate them with \`is_digest_image\` when \`ARTFLOW_SITE_PROFILE=v2\`. Require rendered Plus API and Worker environments to contain the full release SHA. Keep v1 assertions unchanged.

- [ ] **Step 2: Update the production manifest contract**

Set \`ARTFLOW_RELEASE_SHA\` on \`plus-api\` and \`plus-worker\`. Change Plus example values to registry references ending in \`@sha256:replace-me-with-the-verified-digest\`, and document that the Plus images and release SHA belong to the same tag build.

- [ ] **Step 3: Implement profile-aware validation**

Extend \`scripts/deploy.sh\` to read the site profile before rendering Compose. When the site profile is \`v2\`, add the Docker Compose \`--profile plus\` service profile to every invocation, read the three Plus image references and API/Worker release values from rendered Compose JSON, require all three digest references, and require all three image OCI revisions plus both service values to equal the full \`ARTFLOW_RELEASE_SHA\`. Keep the v1-only path unchanged.

- [ ] **Step 4: Update the Plus cutover runbook**

Document consumption of the three workflow-emitted digests, \`ARTFLOW_RELEASE_SHA\`, and the canonical deployment validator. State that acceptance is isolated and automated; it does not require a real activity rehearsal.

- [ ] **Step 5: Run the red-green verification**

~~~powershell
uv run pytest scripts/tests/test_posix_operations_contract.py tests/gates/test_release_artifacts.py -q
bash -n scripts/deploy.sh
~~~

Expected: PASS with no v1 regressions. The repository-wide workflow verifier is not part of
this task because its current baseline rejects the existing release workflow's intentional
\`cancel-in-progress: false\` and the local PostgreSQL service credentials in the Plus gates.

- [ ] **Step 6: Commit the deployment contract**

~~~powershell
git add scripts/deploy.sh scripts/tests/test_posix_operations_contract.py .env.production.example deploy/compose.production.yml docs/artflow-plus/cutover-runbook.md
git commit -m "fix: enforce plus production image provenance"
~~~

### Task 5: Final verification and handoff

**Files:**

- Verify: all files changed by Tasks 1–4
- No new production files beyond the explicitly listed provenance helper and test

- [ ] **Step 1: Inspect the complete diff**

~~~powershell
git diff --check
git status --short
git diff --stat
~~~

Confirm only release/provenance scope changed and every new TypeScript source is covered by its package tsconfig.

- [ ] **Step 2: Run the Plus-focused verification set**

~~~powershell
pnpm -C plus run check
pnpm -C plus run test
pnpm -C plus run build:prod
uv run pytest tests/gates/test_release_artifacts.py scripts/tests/test_posix_operations_contract.py -q
~~~

Use \`ARTFLOW_PLUS_DATABASE_URL\` and \`REQUIRE_DB=1\` for the Plus test command. Do not run the v1 full suite or perform a real activity rehearsal.

- [ ] **Step 3: Review requirements before claiming completion**

Confirm from fresh output that all three Plus workflow targets exist, all three receive the same SHA, all three production Plus images require digests, API and Worker reject mismatches, and the worktree contains only intended commits.

- [ ] **Step 4: Plan the next independent debt**

After this scope is verified, create a separate plan for Plus backup/restore covering PostgreSQL, archive, and media volumes; do not combine it with proxy or authentication changes.

