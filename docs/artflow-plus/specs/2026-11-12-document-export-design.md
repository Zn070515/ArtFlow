# Controlled DOCX/XLSX Export Design

- Date: 2026-11-12
- Status: accepted for implementation
- Scope: the four existing controlled export datasets, plus DOCX/XLSX rendering
- Roadmap: [product-path gaps](../roadmap.md)

## Intent

Ops can already download four controlled CSV exports: registrations, materials,
scores, and audience votes. CSV is enough for data work but not for printing,
signing, or sharing a readable sheet. This slice adds DOCX and XLSX rendering for
the same four datasets without moving any authority out of the Node API.

The renderer is a separate .NET sidecar because no maintained Node library
produces both OOXML formats with the same fidelity. The sidecar is a pure
renderer: the Node API remains the only component that authenticates the actor,
reads the database, applies permissions, and writes the audit entry.

## Decisions

1. **Internal HTTP sidecar.** `plus/services/document-export/` exposes
   `POST /v1/render` on the internal compose network. It has no published port,
   no database credentials, and no file storage.
2. **Node passes structured rows.** The API sends the already-authorized
   `headers` and `rows` as JSON. The sidecar never queries PostgreSQL and never
   resolves activity, participant, or judge identities.
3. **Same four datasets.** `registrations`, `materials`, `scores`, and `votes`
   keep the existing permission mapping. Formats are `csv`, `docx`, and `xlsx`.
4. **Fail closed.** If the sidecar is not configured, unreachable, slow, or
   returns an unexpected type/size, the request returns `503 EXPORT_UNAVAILABLE`
   and no partial file. CSV stays available without the sidecar.
5. **Audit only successful exports.** The table is read, the file is rendered,
   and only then is the existing `export.<kind>` audit entry written. A failed
   render leaves no audit row that would suggest data left the system.

## Authority boundary

1. The API route keeps `config.access: "session"` and the per-kind permission
   check already implemented in `export-service.ts`.
2. The sidecar has no actor, no session, and no database. Its only credential is
   a shared bearer token configured on both sides.
3. The export remains a read: it never writes receipts, facts, or outbox events.
   The audit row is the only durable side effect.
4. Filenames are generated from server-defined values (`activity-<id>-<kind>`);
   the activity title is only a document heading, never a filesystem path.
5. Raw rows may contain personal data. The sidecar must not log request bodies,
   and the API must keep `cache-control: no-store` on every export response.

## HTTP contract (Node API)

`GET /api/activities/:id/exports/:kind?format=csv|docx|xlsx`

- `kind` stays `registrations | materials | scores | votes`.
- `format` defaults to `csv`.
- CSV returns `text/csv; charset=utf-8`.
- DOCX returns
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
- XLSX returns
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
- Every successful response carries
  `content-disposition: attachment; filename="activity-<id>-<kind>.<ext>"` and
  `cache-control: no-store`.

## Service contract

`POST /v1/render`

Request headers:

| Header | Value |
| --- | --- |
| `content-type` | `application/json` |
| `x-artflow-export-token` | shared token, compared in constant time |

Request body (TypeBox-validated on the Node side, re-validated by the service):

```json
{
  "format": "docx",
  "title": "2026 Singer Competition",
  "filenameStem": "activity-act_123-registrations",
  "headers": ["participantId", "name", "status"],
  "rows": [["p-1", "Alice", "approved"]]
}
```

Limits: `title` ≤ 200 chars; `filenameStem` matches `^[A-Za-z0-9._-]{1,120}$`;
`headers` 1–50 entries, each ≤ 100 chars; `rows` ≤ 50,000; every row length equals
`headers` length; cells are string ≤ 4,000 chars, finite number, or boolean.

Responses: `200` with the file bytes and the matching content type; `400`
`{"code":"INVALID_INPUT"}`; `401` `{"code":"UNAUTHORIZED"}`; `413` when the body
or row count exceeds the limit; `415` for a non-JSON body. The service never
returns stack traces or request content.

## Security controls

- The container runs as the non-root `app` user, with a read-only root
  filesystem, no shell entrypoint, and no outbound network dependency.
- Kestrel binds `0.0.0.0:8080` inside the container only; compose publishes no
  port. Caddy never routes to it.
- Request body limit is 8 MiB; per-field and per-row limits are enforced before
  rendering. The Node client also rejects responses over 20 MiB.
- Token comparison uses `CryptographicOperations.FixedTimeEquals`; a missing,
  empty, or mismatched token fails before parsing the body.
- No user-supplied templates, file paths, or relationship targets. Documents are
  built from primitives with `DocumentFormat.OpenXml`, so external entities and
  template injection are not part of the input surface.
- Logs contain method, status, duration, and response bytes only. No headers,
  token, filename, rows, or cell values.
- The Node client sends the token from `ARTFLOW_PLUS_EXPORT_TOKEN` and never
  accepts it from a request.

## Configuration

| Variable | Used by | Meaning |
| --- | --- | --- |
| `ARTFLOW_PLUS_EXPORT_SERVICE_URL` | API | base URL, for example `http://plus-export:8080` |
| `ARTFLOW_PLUS_EXPORT_TOKEN` | API, sidecar | shared secret; empty disables DOCX/XLSX |
| `ARTFLOW_PLUS_EXPORT_MAX_BYTES` | API | response ceiling, default `20971520` |
| `ARTFLOW_PLUS_EXPORT_TIMEOUT_MS` | API | request timeout, default `10000` |

The sidecar reads only `ARTFLOW_PLUS_EXPORT_TOKEN` and
`ASPNETCORE_URLS`. A production deployment pins
`ARTFLOW_PLUS_EXPORT_IMAGE` in `.env.production` by digest, like the other three
images.

## Non-goals

- PDF, PPTX, or template-based mail merge.
- Exporting files or archives; this slice stays with the four table datasets.
- Asynchronous export jobs or stored artifacts.
- Letting the sidecar read the database or resolve identities.
- Exposing the sidecar to the browser or the public proxy.

## Test architecture

**Contracts and capabilities touched.** The export read path and the API route
boundary. No migration, command, event, or capability manifest changes. The
existing `export.<kind>` audit detail gains `format`.

**Consumers and read models.** `GET /api/activities/:id/exports/:kind`, the Ops
`ExportCard`, and the existing registration/material/score/vote read queries.
The change must not alter the rows those queries return.

**Lifecycle and isolation.** Export has no aggregate or mode. The transport has
three states: success, unavailable (no sidecar, non-2xx, timeout), and invalid
output (wrong type or oversize). A failed render must leave no audit row, and no
response bytes must be sent before the full document is validated.

**Adapters.** A new outbound `DocumentExporter` adapter in
`packages/runtime/src/document-export-client.ts` owns the HTTP call, timeout,
response type, and size ceiling. The route receives it from `buildApp` options so
tests inject a fake. The .NET side has one renderer per format and one request
validator; the xUnit suite parses the produced files back with the OpenXML SDK.

**Independent expectations.** The CSV serializer and the DOCX/XLSX renderers
consume the same `TableExport` fixture. Tests assert exact headers and cell
values from that fixture, not from the renderer output. The .NET tests open the
generated package and assert the values, then the Node tests assert the HTTP
boundary separately.

**Fault cases.** Sidecar unset, sidecar returns 401/500, connection refused,
timeout, wrong content type, oversize body, and a malformed row (mismatched cell
count). Each is asserted to produce `503 EXPORT_UNAVAILABLE`, no audit row, and
no partial response. CSV is asserted to keep working while the sidecar is down.

**Anti-bloat decision.** Extend the existing `ExportKind` path with one
`TableExport` builder and one serializer; do not add a kind-specific route or
renderer. One HTTP client, one .NET render endpoint, two pure renderers, one
xUnit project, and one API contract test file. No Word/Excel template assets, no
generated binary fixtures in git, and no mocking of the database.

**Gates.** `dotnet restore --locked-mode`, `dotnet test`, `pnpm -C plus run
check`, the focused API export tests, the full Plus suite with `REQUIRE_DB=1`,
`pnpm -C plus run build:prod`, `uv run pytest tests/gates -q`,
`uv run python tests/golden/validate_fixtures.py`, `audit:check`, `graph:check`,
and `pwsh -NoProfile -File scripts/check_docs.ps1`.

## Observability

The API maps every sidecar failure to `503` with the generic message
`The document export service is unavailable.` and logs one structured line with
the kind, format, and failure class. The sidecar logs one line per request with
status, duration, and response bytes. Neither side logs rows or the token.
