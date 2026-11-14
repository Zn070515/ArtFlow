# Production Release Readiness Implementation Plan

> **For agentic workers:** Execute this plan inline in the current repository checkout. Do not spawn subagents or create worktrees. Use small conventional commits and run the focused gate before each commit.

**Goal:** Close all repository-addressable production-readiness findings from `ChatGPT.md` before one final non-fast-forward merge and `main` push.

**Architecture:** Keep the Django competition/authority core frozen. Add narrow boundary services for backup barriers, file inspection, retention, authentication lifecycle, deployment provenance, and operations. Prefer configuration and contract tests over broad refactors. External capabilities (OSS, DNS/TLS, school SSO/MFA, WAF/DDoS, ICP) receive explicit adapters/runbooks and remain marked external until real evidence is supplied.

**Tech Stack:** Django/PostgreSQL, Python 3.12, uv, pytest, mypy, Ruff, Pyright/Pylance, TypeScript client checks, Docker Compose, Caddy, PowerShell and POSIX shell.

**Spec:** `docs/superpowers/specs/2026-09-27-production-release-readiness.md`

## Global Constraints

- Follow `AGENTS.md`; work inline only, without `.worktree/` or subagents.
- TDD: add a focused failing test, observe RED, implement the smallest fix, then run GREEN.
- Never disable an existing authority, security, type, or documentation gate to make progress.
- Do not run `docker compose down --volumes`, reset, drop, or delete source data/volumes.
- Keep each logical change in an independently verifiable conventional commit.
- Do not push `main` until every repository-addressable item is closed, two self-review passes are complete, and all final gates have fresh evidence.
- Do not invent OSS/DNS/ICP/SSO/DDoS evidence; record external prerequisites explicitly.

## Phase 0 — Baseline and tracker

- [ ] Capture clean branch status, current SHA, Docker availability, and existing gate baseline.
- [ ] Add a release-readiness tracker to `docs/production-readiness.md` mapping every advice item to code, test, and external evidence.
- [ ] Commit the spec/plan/tracker separately with `docs:` and verify docs checks.

## Phase 1 — Backup correctness and recoverability

### 1A. Version/path/provenance

- [ ] Add failing tests for PG image drift and `/app/backups` default path.
- [ ] Make restore scripts derive/verify the production PostgreSQL image instead of hardcoding PG17.
- [ ] Make the PowerShell backup wrapper use the persistent mount and reject unsafe output paths.
- [ ] Validate every explicit `--git-sha` as a full non-placeholder SHA.
- [ ] Add baked OCI revision metadata and startup/runtime validation against `ARTFLOW_RELEASE_SHA`.

### 1B. Complete manifest and restore verification

- [ ] Add failing tests proving a missing file after the fifth reference fails verification.
- [ ] Verify every DB-referenced file; include complete critical-model counts and digests.
- [ ] Make restore compare manifest database/media digests before unpack/restore.
- [ ] Require the manifest image identity for restore, or fail with an actionable mismatch rather than silently using the current image.

### 1C. Consistent snapshot barrier

- [ ] Add failing tests for concurrent writes during backup and for failed barrier acquisition.
- [ ] Implement a fail-closed application-wide maintenance/write barrier with an admin-visible/audited state.
- [ ] Wrap DB dump, media archive, and manifest generation in that barrier; preserve all existing authority services.
- [ ] Add a documented recovery procedure for an interrupted barrier.

### 1D. Off-host operations

- [ ] Add private/encrypted/lifecycle OSS-compatible sync and restore-verification entry points with environment-only credentials.
- [ ] Add POSIX and PowerShell wrappers; add an isolated local compatible-store rehearsal when Docker/network permits.
- [ ] Document the exact external prerequisite for an ECS/OSS failure-domain restore and do not mark it PASS without evidence.

## Phase 2 — Upload and resource safety

### 2A. Content inspection

- [ ] Add adversarial failing tests for renamed/random bytes and malformed image/audio/video/PDF/ZIP/DOCX.
- [ ] Implement server-side signature/structure checks with bounded reads and safe error messages.
- [ ] Keep purpose-specific allowlists and ensure the checks run before persistence.

### 2B. Quota/rate/disk/version lifecycle

- [ ] Add failing tests for per-owner/purpose quota, version retention, upload burst limits, and low disk.
- [ ] Implement configurable quotas and bounded historical versions without deleting an authority fact.
- [ ] Implement upload low-water rejection and database-backed rate limits consistent with trusted proxy IP handling.
- [ ] Change production Caddy request body limit to 120 MB; keep event/rehearsal limits explicit and separately tested.

## Phase 3 — Privacy, audit, archive, retention

### 3A. PII-safe audit and archives

- [ ] Add failing tests showing singer/farewell contact edits never copy old/new PII into AuditLog.
- [ ] Replace those payloads with changed field names/boolean flags.
- [ ] Split permanent archive exports from operational contact exports and strip phone/wechat/student ID/contact phone from permanent packages.

### 3B. Privacy and retention

- [ ] Add privacy route, policy text, footer/link, and pre-submit notice tests.
- [ ] Add policy-backed, admin-only retention/anonymization command with dry-run/report mode.
- [ ] Prove cleanup preserves scoring/result authority and does not cascade-delete required audit/provenance rows.

## Phase 4 — Account and public security boundary

### 4A. Password and abuse controls

- [ ] Add failing tests for authenticated password change and audited admin reset.
- [ ] Implement password-change flow and admin second-factor reset using existing admin login key/authority; do not add fake email recovery.
- [ ] Add IP+username login buckets plus higher aggregate IP limits; define registration abuse handling and test NAT-safe behavior.

### 4B. Brand, privacy metadata, HSTS

- [ ] Add failing template/settings tests for neutral public identity, optional ICP fields, and no fake number.
- [ ] Update public title/H1 and configurable footer metadata while preserving configurable organization name.
- [ ] Make HSTS seconds/subdomain/preload environment-configurable with safe staged defaults and tests.

## Phase 5 — Deployment and operations

### 5A. Proxy, images, and release build

- [ ] Add proxy healthcheck and an external HTTPS smoke command that fails clearly when DNS/TLS is not available.
- [ ] Add explicit image variables/digest documentation and tests; record the web image release SHA and OCI revision.
- [ ] Add a reproducible release build/export script that builds the exact clean SHA and supports save/load or registry publication without hidden Docker Hub assumptions.

### 5B. POSIX operations and observability

- [ ] Add `scripts/deploy.sh`, `scripts/backup.sh`, and `scripts/restore-verify.sh` with strict mode and safe argument handling.
- [ ] Add Docker log rotation guidance/configuration, host/app monitoring checklist, backup-age/TLS/restart/5xx probes, and deployment-profile separation docs.
- [ ] Add syntax and static contract tests for all scripts.

## Phase 6 — Verification and release

- [ ] Run focused tests after each phase and commit only green scoped changes.
- [ ] Run two independent self-review passes: (1) contract/authority and semantic consistency; (2) security, PII, operational safety, and failure paths.
- [ ] Run the complete local gate: Django checks/migrations/tests/coverage, Ruff, mypy, both Pyright gates, client/CSS/tests, docs, Compose/PostgreSQL acceptance, backup/restore, and script checks.
- [ ] Run available Docker black-box rehearsal without resetting source volumes; quantify HTTP status, timeout, latency, and leakage results.
- [ ] Mark any external evidence honestly as `HOLD` and stop before `main` push if a claimed release requirement still lacks required owner evidence.
- [ ] If all required evidence is present, merge the branch into `main` with `--no-ff`, push `main` (retry through `127.0.0.1:12334` only on timeout), wait for CI, and verify the exact pushed SHA and all workflows.

