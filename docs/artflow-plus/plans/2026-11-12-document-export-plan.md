# Controlled DOCX/XLSX Export Implementation Plan

- Date: 2026-11-12
- Design: [document-export-design](../specs/2026-11-12-document-export-design.md)
- Status: implemented (2026-11-12)

## Objective

Add DOCX and XLSX downloads for the four existing controlled exports without
moving authentication, data access, or auditing out of the Node API. The .NET
sidecar is a pure renderer reached over the internal compose network.

## Order of work

Work is ordered prove-first: the shared table shape and the failure boundary come
before the renderer, so the renderer cannot quietly redefine the data.

### 1. Extract one table shape (Node)

- Refactor `packages/runtime/src/export-service.ts` so the four kinds build one
  `TableExport` value (`kind`, `title`, `headers`, `rows`) and the CSV serializer
  consumes it.
- Keep `exportActivityCsv` as a thin wrapper so existing callers and tests do not
  fork.
- Move the audit write to after a successful render; a failed render must leave
  no audit row.
- Add `packages/runtime/test/export-table.test.ts` proving all four kinds share
  the same headers/row shape and that the CSV output is unchanged.

### 2. Add the outbound adapter (Node)

- Add `packages/runtime/src/document-export-client.ts`:
  - `DocumentExporter` interface (`render(input): Promise<RenderedDocument>`);
  - `createHttpDocumentExporter({ baseUrl, token, timeoutMs, maxBytes })`;
  - a TypeBox request schema shared with the route contract;
  - explicit `EXPORT_UNAVAILABLE` failures for unset config, non-2xx, timeout,
    wrong content type, and oversize responses.
- Export the adapter from the runtime index.
- Tests: local `node:http` server asserting path, token header, JSON body, and
  each failure class; no real sidecar required.

### 3. Extend the API route and composition

- `apps/api/src/routes/exports.ts`: accept `format`, build the table, call the
  exporter for `docx`/`xlsx`, set the content type, filename, length, and
  `cache-control`.
- `apps/api/src/app.ts`: accept `documentExporter?: DocumentExporter | null`;
  default to the env-configured client when URL and token are present, otherwise
  `null`. Map `EXPORT_UNAVAILABLE` to `503`.
- `apps/api/test/exports.test.ts`: disposable schema; CSV still works with no
  sidecar; DOCX/XLSX call the fake exporter with the exact table; failures return
  `503` with no audit and no body; permission denial stays `403`.
- `apps/web/src/components/ops/ExportCard.tsx`: add CSV/DOCX/XLSX links per kind.
  Add a component test for the three formats and permission filtering.

### 4. Build the .NET sidecar

- `plus/services/document-export/`:
  - minimal ASP.NET Core app with `GET /healthz` and `POST /v1/render`;
  - `ExportRequest` validation (format, stem regex, header/row/cell limits);
  - `WordDocumentRenderer` and `WorkbookRenderer` using
    `DocumentFormat.OpenXml`;
  - constant-time token check, body limit, no-store/nosniff headers, logging of
    status/duration/bytes only;
  - `Directory.Packages.props` and `packages.lock.json` for reproducible
    restores;
  - multi-stage Dockerfile pinned by tag, non-root user, `EXPOSE 8080`.
- `plus/services/document-export/tests/`: xUnit tests that re-open the produced
  packages and assert the fixture values, plus validation and token tests.
- Run `dotnet restore --locked-mode` and `dotnet test`.

### 5. Wire deployment and repository checks

- `deploy/compose.production.yml`: add `plus-export` on `artflow_internal`, no
  published port, `ARTFLOW_PLUS_EXPORT_IMAGE` pinned by digest, read-only root
  filesystem, healthcheck on `/healthz`; give `plus-api` the URL and token.
- `.env.production.example`: document the new image and token.
- `.github/workflows/gates.yml`: add a `.NET` job that runs
  `dotnet restore --locked-mode` and `dotnet test`.
- `.github/dependabot.yml`: add a `nuget` entry for the service directory.
- `.gitignore` / `.dockerignore`: exclude `bin/`, `obj/`, and test artifacts.
- `AGENTS.md`: add the service to the layout and its verification command.
- `.env.example`: document the API-side knobs for development.

### 6. Verification

- `dotnet test plus/services/document-export/tests`
- `pnpm -C plus run check`
- `REQUIRE_DB=1 pnpm -C plus run test`
- `pnpm -C plus run build:prod`
- `uv run pytest tests/gates -q`
- `uv run python tests/golden/validate_fixtures.py`
- `pnpm --filter @artflow-plus/contract-tools run audit:check`
- `pnpm --filter @artflow-plus/contract-tools run graph:check`
- `pwsh -NoProfile -File scripts/check_docs.ps1`

## Test architecture (required section)

- **Contracts/capabilities:** export read path, API boundary, runtime outbound
  adapter. No schema, command, event, or capability changes.
- **Consumers:** Ops `ExportCard`, the export route, the existing read queries,
  and the audit table.
- **Lifecycle/mode:** no aggregate or mode; test the three transport outcomes
  (success, unavailable, invalid output) and the "no audit on failure" rule.
- **Adapters:** `DocumentExporter` (Node, fake in tests, real HTTP client against
  a local server) and the .NET render endpoint (xUnit, no web factory needed).
- **Faults:** unset sidecar, 401/500, refused connection, timeout, wrong content
  type, oversize response, malformed row. Assert `503`, no audit, no bytes.
- **Independent expectations:** one shared `TableExport` fixture; CSV and OOXML
  output are compared against the fixture values, never against each other's
  output.
- **Anti-bloat:** one table builder, one serializer, one HTTP client, one render
  endpoint, two renderers, one xUnit project, one Node contract test file. No
  per-kind formats, no template assets, no binary fixtures.
- **Gates:** `dotnet test`, the focused export tests, the full Plus suite,
  `audit:check`, `graph:check`, and `check_docs` before merge.
- **Proof before scale:** the failure boundary tests run before the .NET
  renderer is wired into compose, and the full suite must stay green at every
  commit.
