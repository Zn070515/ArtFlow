# M2 Toolchain Hardening Design

## Status

Approved direction: introduce the tooling at the M2-A to M2-B boundary, with
small commits and a gate that expands together with each new browser-facing
capability.

## Goal

Give the high-risk QR, temporary-session, ticket, and Judge Terminal flows a
typed client boundary and a real browser/runtime verification path without
rewriting the Django monolith or destabilising the already verified M1/M2-A
server behaviour.

## Current baseline

- The server remains a Django monolith backed by SQLite locally and PostgreSQL
  in the integration/Compose path.
- TypeScript already exists for `frontend/rapid_score.ts`, uses strict mode,
  and is compiled by `npm run check:client`.
- Pyright is installed, but its existing project scope covers selected legacy
  authority/scoring modules. The configured full check currently reports 60
  Django dynamic-attribute diagnostics; it is not a blocking CI gate.
- Playwright is not currently installed. Client tests use Node's built-in test
  runner and do not exercise a running browser or web server.
- M2-A exposes the first temporary access lifecycle endpoints, but no Judge
  Terminal or Ticket UI exists yet.

## Decisions

### 1. TypeScript is additive and surface-scoped

New interactive clients are written in TypeScript. Existing server-rendered
HTML, legacy JavaScript, and Django services are not migrated as a batch. The
first new TypeScript surface will be the Judge Terminal in M2-B; it will model
the server contract, session scope, draft state, retry state, and explicit
failure states rather than duplicating business authority in the browser.

### 2. Playwright verifies the deployed shape

Use the pinned `@playwright/test` package at `1.63.0` and Chromium only for the
initial gate. Playwright runs against the already-started local/CI web service
at `PLAYWRIGHT_BASE_URL`, defaulting to `http://127.0.0.1:8000`. The CI
integration job starts the existing Compose PostgreSQL stack before running the
browser smoke suite.

The first suite verifies service reachability and public HTML rendering. M2-B
adds the actual Judge/Ticket flows only after their UI and fixture contracts
exist. Credential-bearing tests must disable trace/video artifacts so raw
bearer tokens cannot enter CI artifacts.

### 3. Pyright is expanded through an explicit boundary

Add a dedicated `pyrightconfig.entry-access.json` for production code under
`entry_access/`, excluding tests and migrations. Add a named npm command and a
CI step for that scope. Do not turn the existing 60-diagnostic whole-project
Pyright baseline into a blocking gate during this change. New entry-access
production code must either type-check or carry a narrow, documented
framework-boundary suppression for Django-generated relation attributes.

The existing mypy gate must also include `entry_access`, because mypy is the
repository's blocking Python type gate. Test-only typing fixes are allowed;
changing runtime semantics to satisfy a type checker is not.

### 4. Gates grow with the capability matrix

| Capability | Required local/CI gate | Additional scenarios before Production |
| --- | --- | --- |
| M2-A temporary access foundation | scoped Pyright, mypy, Django tests, PostgreSQL tests, Playwright runtime smoke | real staff/public rehearsal, revoke/replay, recovery |
| JudgeSeat / JudgeSession | TypeScript client check, Playwright browser flow, PostgreSQL concurrency | absent judge, stale session, STAFF_PROXY, paper DR |
| Ticket / Check-in | TypeScript client check, Playwright eligibility flow, service tests | duplicate ticket, checked-in state, vote boundary, public failure DR |
| Direct electronic scoring | typed payload/state client, Playwright submit/retry flow, PostgreSQL race tests | lost ACK, duplicate command, wrong target, panel change HOLD |
| Production release | all preceding gates plus rehearsal scripts and security gates | real-role event rehearsal and backup/restore evidence |

Each later phase may add a gate, but must not silently remove an earlier one.

## Non-goals

- No Django-to-Node, Go, or Rust rewrite.
- No React migration or giant SPA.
- No Playwright dependency on an external production site or real credentials.
- No global Pyright cleanup as a prerequisite for M2-B.
- No browser test that mutates formal production data.

## Security and failure boundaries

- Browser tests use disposable local/CI data and loopback services only.
- Raw grant/session tokens may exist in an in-memory test variable only for the
  immediate request; they must not be logged, asserted into error text, or
  written to traces, videos, screenshots, or reports.
- Playwright smoke tests remain read-only until a disposable fixture protocol
  exists for the relevant feature.
- The browser never becomes an authority database; server services and
  PostgreSQL locks remain authoritative.
- A failed browser gate blocks the capability it covers; it does not justify
  weakening the server contract or marking that capability Production.

## Expected deliverables

- A pinned Playwright dependency and reproducible Chromium install command.
- `playwright.config.ts` with an explicit base URL and safe artifact policy.
- A minimal `tests/e2e/` smoke suite and a CI integration step.
- A scoped Pyright configuration/command that covers `entry_access` production
  code.
- Mypy and coverage configuration updated so the new app is not invisible to
  existing gates.
- Development documentation describing local commands and the capability gate
  matrix.
