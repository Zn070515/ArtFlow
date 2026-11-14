# Rapid Score TypeScript Migration Design

**Status:** Approved for implementation planning

**Date:** 2026-09-07

## Goal

Introduce TypeScript only at the existing Rapid Score browser state-machine boundary so that the highest-risk client behavior gains strict compile-time contracts and a reproducible build, while Django remains the routing, authentication, authority, and scoring source of truth.

## Context and constraints

ArtFlow is a Django server-rendered application. The Rapid Score page currently loads `static/js/rapid_score.js` directly from `templates/staff_panel/round_score_entry.html`. That script owns browser-only behavior for score-cell validation, local pending storage, retry scheduling, `beforeunload` protection, stale-version rebase, and explicit conflict display. The server owns score validation, CSRF, idempotency, `score_version`, locking, permissions, and final persistence.

The repository currently has a pinned Tailwind build and a Node test that evaluates the served Rapid Score script in a small DOM/fetch/storage harness. Docker copies `static/` into the runtime image and does not install Node, so the browser artifact must be present in the checkout used to build the image. The generic `dist/` ignore rule must therefore be narrowed with an explicit tracked-artifact exception for `static/dist/rapid_score.js`.

The local machine has Node 26 and global TypeScript 7, but CI uses Node 22. The project must pin TypeScript as a local npm dev dependency and must not depend on the global installation.

## Chosen architecture

Use the TypeScript compiler directly, with no Vite, esbuild, React, Vue, Next, or SPA migration:

```text
frontend/rapid_score.ts
        │  tsc --strict --noEmitOnError
        ▼
static/dist/rapid_score.js   (tracked, deterministic runtime artifact)
        │
        ├── Django template static tag + WhiteNoise manifest
        └── Node regression harness executes this exact artifact
```

The TypeScript source remains a browser script with the current self-invoking entrypoint. It will not export a public application API or introduce a module loader. The first migration should preserve the current runtime behavior and DOM selectors; structural cleanup is allowed only when it does not alter the established protocol.

TypeScript 7 does not support the historical `module: "none"` compiler value. The client boundary therefore uses `module: "ES2020"`; because the source has no imports or exports, this preserves a classic browser script and the existing IIFE entrypoint.

The generated JavaScript is tracked because Docker must be able to serve a fresh checkout without a Node build stage. CI will rebuild it and fail if the tracked artifact changes, making source/artifact drift visible before merge. Source maps and nondeterministic banners are not generated.

## File responsibilities and interfaces

### New source and configuration

- `frontend/rapid_score.ts`: typed implementation of the existing Rapid Score browser state machine.
- `tsconfig.client.json`: strict, browser-oriented compiler boundary. It must include only `frontend/rapid_score.ts`, emit into `static/dist`, use a stable ES target supported by the existing browser assumptions, and set `noEmitOnError`.
- `static/dist/rapid_score.js`: deterministic compiled artifact consumed by production templates and tests.

The TypeScript boundary should define explicit types for:

- score cell keys and editable score values;
- grid rows/cells returned by the API;
- pending records stored in `localStorage`;
- stale-version conflict records;
- API response envelopes used by ACK, non-ACK, network failure, and HTTP 409 paths;
- the small DOM/storage/fetch surface the state machine uses.

Unknown JSON and `localStorage` values must be narrowed and validated before entering state. The migration must not use `any` as a shortcut for API or persisted data. The existing behavior of discarding malformed or foreign pending records must remain explicit.

### Existing files to modify

- `.gitignore`: allow the tracked `static/dist/rapid_score.js` artifact while retaining the general `dist/` ignore rule.
- `package.json` and `package-lock.json`: pin the project-local TypeScript compiler and add `build:client`, `check:client`, and the existing `test:client` dependency on the built artifact.
- `templates/staff_panel/round_score_entry.html`: load `dist/rapid_score.js` through the Django `{% static %}` tag.
- `tests/rapid_score_client.test.mjs`: read and execute `static/dist/rapid_score.js`, so tests exercise exactly what the template serves.
- `tests/test_static_smoke.py`: check the hashed `dist/rapid_score.js` URL in the existing `DEBUG=False` manifest smoke.
- `.github/workflows/ci.yml`: run the deterministic client build check before the Node regression; retain the current pinned Node 22 setup.
- `.github/workflows/integration.yml`: update the production Compose static smoke to resolve and fetch `dist/rapid_score.js`.

No Django view, model, score API, authority service, or database schema changes are part of this migration.

## Runtime and protocol compatibility

The migration must preserve these existing contracts exactly:

- `data-api-url`, `data-activity-id`, `data-round-id`, and `data-locked` DOM inputs;
- `rapid-grid-data` initial payload and the current grid/cell shape;
- `score_version`/`version` optimistic concurrency semantics;
- command/submission idempotency fields and retry reuse;
- HTTP 409 `STALE_SCORE_VERSION` handling, including preserving both server and local values for divergent cells;
- ACK clearing of only the matching pending record;
- network/non-ACK failure retention, reload recovery, manual/online retry, and capped exponential retry;
- CSRF token lookup and same-origin fetch behavior;
- current Chinese operator-facing conflict/error text unless a test requires a wording-preserving equivalent.

The output path changes from `js/rapid_score.js` to `dist/rapid_score.js`; the logical asset remains the same and WhiteNoise will continue to add its manifest hash at collection time.

## Security and authority boundaries

- TypeScript is a client reliability/type-safety layer, not an authority layer.
- Client validation must remain advisory; the Django API remains authoritative for score ranges, lock state, permissions, activity ownership, and idempotency.
- Do not embed secrets, permission decisions, or trusted user/role data in the client artifact.
- Treat DOM datasets, embedded JSON, API responses, and `localStorage` as untrusted input; validate before state mutation and render conflict text with `textContent`-equivalent behavior, never HTML interpolation.
- Preserve the current same-origin CSRF request and do not broaden fetch destinations.
- Build output must fail closed on type errors through `noEmitOnError` and the CI drift check.

## Testing and acceptance gates

Implementation must follow TDD in this order:

1. Change the client harness to target the desired artifact contract and add the smallest type/build contract test; verify the test/build gate fails before implementation.
2. Migrate the existing behavior to `frontend/rapid_score.ts` with the smallest typed implementation; run the Node suite against the compiled artifact.
3. Add/adjust the static manifest assertion for `dist/rapid_score.js` and run it after a clean `collectstatic`.
4. Run Django Rapid Score API regression and the operator E2E acceptance path.

Required commands before integration:

```text
npm ci
npm run check:css
npm run check:client
npm run test:client
uv run pytest -q tests/test_static_smoke.py
uv run pytest -q staff_panel/tests.py
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run ruff check .
uv run ruff format --check .
uv run python scripts/verify_workflows.py .github/workflows --require ci.yml --require integration.yml --require security.yml --require workflow-lint.yml
```

The final acceptance must also include the existing PostgreSQL acceptance script and Docker production static smoke. The generated artifact must be present in a clean checkout and no untracked `staticfiles/` output may be committed.

## Non-goals

- No TypeScript migration of all existing JavaScript.
- No SPA or client-side routing.
- No QR, Ticket, Judge Direct Scoring, PPT, or new business features.
- No change to Django authority, scoring, locking, or API semantics.
- No bundler or framework introduction unless this first boundary demonstrates a concrete requirement that `tsc` cannot satisfy.
