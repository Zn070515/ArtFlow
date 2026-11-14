# Client Tooling Micro-Refactor Design

**Status:** Approved for implementation planning

**Date:** 2026-09-07

## Goal

Make the existing high-risk browser boundary easier to extend and safer to
validate, without turning ArtFlow into a frontend application. The refactor
will generalize the current TypeScript build, tighten its compiler checks,
partition browser drafts by authenticated operator, and add a bounded Pyright
evaluation for Python authority code. Playwright is recorded as a future
browser-acceptance trigger, not installed in this change.

## Context and current facts

- ArtFlow is a Django monolith with server-rendered templates and WhiteNoise
  manifest static files.
- `frontend/rapid_score.ts` is currently the only TypeScript entry and emits
  the tracked `static/dist/rapid_score.js` artifact through local `tsc`.
- The Rapid Score API already records the authenticated operator in
  `ScoreWriteReceipt` and rejects an idempotency replay by another operator.
- The browser pending key currently contains activity, round, and endpoint,
  but not the operator identity. A shared browser can therefore expose one
  operator's draft to another operator before the server rejects the request.
- `pyproject.toml` already contains mypy and django-stubs, but no Pyright
  configuration or explicit type-check gate.
- CI already runs CodeQL for Python, Gitleaks, and pip-audit. This change does
  not duplicate those security gates.

## Scope

### In scope

1. Generalize the client build from one hard-coded TypeScript file to all
   direct `frontend/**/*.ts` entries, while preserving one classic JavaScript
   artifact per page and no runtime module imports.
2. Check the complete tracked `static/dist/` output for stale generated files.
3. Enable `noUncheckedIndexedAccess`, `noImplicitReturns`, and
   `noFallthroughCasesInSwitch`; fix the resulting Rapid Score boundary
   errors without changing its protocol or state-machine semantics.
4. Move the Node client harness under `tests/client/` and keep its assertions
   against the compiled artifact rather than the TypeScript source.
5. Add a server-rendered `operator_id` data attribute to the Rapid Score page
   and include it in the pending-draft storage key. This value partitions
   local convenience state only; it is never treated as an authorization
   claim, and the server remains authoritative.
6. Add project-local Pyright, lock it through the existing `uv` environment,
   and configure an initial evaluation scope for the authority and scoring
   boundaries. Pyright is initially an explicit local report, not a second
   whole-repository blocking type gate alongside mypy.
7. Update CI and documentation so the commands and artifact contract are
   reproducible on CI Node 22 and the local Windows environment.

### Out of scope

- No database migration, API payload change, new server-side authorization
  rule, or change to `ScoreWriteReceipt`.
- No formal score deletion semantics. An empty Rapid Score input remains a
  client draft/no-operation under the current API; formal clearing requires a
  separate audited service contract that deletes or tombstones the score and
  increments the authoritative version.
- No AudienceScore migration, Judge Terminal, Gate Scanner, ticket flow, or
  audience-vote client migration.
- No Playwright dependency, browser installation, or CI browser job in this
  refactor. Playwright becomes in scope when Judge Terminal or Gate Scanner
  introduces real refresh, mobile, camera, or browser-storage acceptance
  requirements.
- No esbuild, Vite, React, Vue, Next, SPA router, shared runtime library, or
  ESM runtime dependency.
- No replacement of mypy with Pyright during this change.

## Design

### 1. Multi-entry TypeScript without a bundler

`tsconfig.client.json` will use an `include` pattern rooted at `frontend` and
emit into `static/dist`. Each entry remains an independent classic browser
script. The current source has no imports or exports, so the compatible
TypeScript 7 `module: "ES2020"` setting continues to emit a browser-safe IIFE
without a module loader.

The package scripts will follow this contract:

```text
npm run build:client
npm run check:client
```

`check:client` will compile and fail if any tracked file under `static/dist/`
changes. The generated JavaScript remains committed because the Docker image
copies `static/` and does not install Node.

This deliberately stops before bundling. When multiple entries begin sharing
real imports, esbuild can later bundle each entry into one final page asset;
until then, a bundler adds dependency and manifest complexity without solving
a current problem. See the [esbuild entry-point and bundling documentation](https://esbuild.github.io/api/).

### 2. Strictness as a focused source gate

The stricter compiler flags will be applied to the client project, not the
Python repository. Rapid Score will explicitly narrow:

- `record[key]`, `rows[index]`, and `cols[index]` results;
- dataset values and DOM query results;
- parsed JSON and localStorage records;
- response branches and optional fields.

The migration must retain `unknown` at untrusted boundaries and must not add
`any` to bypass the new checks. `noUncheckedIndexedAccess` is appropriate
because TypeScript adds `undefined` to undeclared indexed properties, forcing
the caller to establish that the item exists. `noImplicitReturns` checks all
function paths for a return value. See the [TypeScript TSConfig reference](https://www.typescriptlang.org/tsconfig/).

### 3. Operator-scoped pending drafts

The server-rendered Rapid Score root will expose the authenticated user's
stable primary-key identifier:

```html
data-operator-id="{{ request.user.pk }}"
```

The client will validate that the value is present and incorporate it into
the local key:

```text
artflow:rapid-score:pending:<activity>:<round>:<operator>:<endpoint>
```

Old keys without an operator segment will not be restored. This is an
intentional fail-closed compatibility boundary: an old browser draft may be
orphaned, but it cannot cross an authenticated operator boundary. The API
request remains unchanged; `request.user` and the existing server receipt
continue to determine authority and audit provenance.

The Node harness will test that the same activity/round/endpoint with a
different operator does not restore or submit the first operator's pending
record, while the same operator still gets reload/retry behavior.

### 4. Pyright evaluation

Pyright will be installed as a project-local development dependency through
`uv`, with the version captured in `uv.lock`. A `pyrightconfig.json` will
select the existing high-risk authority/scoring modules and exclude generated,
migration, test, and static directories. The initial mode will be an
  evaluation-friendly `standard` mode so the report describes actionable
gaps instead of pretending the dynamically typed Django monolith is already
strict.

The implementation will add a named `check:pyright` developer command and
record its command and result in the handoff. CI will not call this command in
this change, so it cannot fail on unrelated whole-repository annotation debt.
After the report is
reviewed, a separate change can promote selected paths to a blocking gate or
decide whether Pyright should replace the existing mypy role. Pyright is a
standards-based Python static type checker; its official project documents
installation and configuration separately from the VS Code editor.

### 5. Future Playwright trigger

Playwright is intentionally not installed here. When the first browser-stateful
high-risk flow arrives, the next design will add `@playwright/test`, a stable
server/data fixture, and a small browser suite. The first cases should cover
real login, page reload, localStorage draft retention, server acknowledgement,
and stale/conflict feedback. The official Playwright guidance recommends
`@playwright/test` for end-to-end tests and supports a configured web server.
See the [Playwright library documentation](https://playwright.dev/docs/library)
and [web-server configuration](https://playwright.dev/docs/test-webserver).

## Verification contract

The implementation is complete only when all of the following hold:

- `npm ci`, `npm run check:css`, `npm run check:client`, and the relocated
  Node client tests pass.
- Rapid Score's existing pending, retry, reload, stale-version, conflict,
  and retry-cap tests remain green, with new operator-isolation coverage.
- The client build is deterministic and emits no source map or untracked
  runtime dependency.
- `uv run pyright` produces the documented scoped evaluation result.
- Django check, migration check, Ruff, workflow verification, static manifest
  smoke, and the existing PostgreSQL/Docker acceptance gates remain green.
- Two review passes confirm that no authority, API, lock, audit, or clear-score
  semantics changed; no untrusted JSON/storage value bypasses narrowing; and
  no generated or secret files are staged.

## Rollout and follow-up

This is a single feature-branch refactor with no production migration. The
feature branch is pushed for provenance, merged into `main` with a non-fast-
forward merge, and `main` is pushed only after the merged tree passes the
verification contract. The feature branch remains available after merge.

Follow-up order:

1. Review the Pyright report and promote only useful scopes to blocking checks.
2. Formalize score clearing as a separate server-authoritative, audited
   contract if operators need deletion.
3. Migrate AudienceScore only after its API/idempotency behavior is specified.
4. Add Playwright with Judge Terminal or Gate Scanner.
5. Introduce esbuild only after multiple entries genuinely share imports.
