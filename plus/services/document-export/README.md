# ArtFlow Document Export sidecar

A renderer-only .NET 9 service behind the Node API. It turns an authorized
`TableExport` into DOCX or XLSX. It has no database credentials, no file
storage, and no public port.

Design: [document-export-design](../../../docs/artflow-plus/specs/2026-11-12-document-export-design.md).
Plan: [document-export-plan](../../../docs/artflow-plus/plans/2026-11-12-document-export-plan.md).

## Endpoints

`GET /healthz` returns `{"status":"ok"}`. It is anonymous because the container
healthcheck uses it; it exposes no configuration.

`POST /v1/render` requires `content-type: application/json` and
`x-artflow-export-token: <token>`:

```json
{
  "format": "docx",
  "title": "2026 Singer Competition",
  "filenameStem": "activity-act_1-registrations",
  "headers": ["participantId", "name", "score"],
  "rows": [["p-1", "Alice", 90]]
}
```

`format` is `docx` or `xlsx`. Limits: title ≤ 200 characters, stem
`^[A-Za-z0-9._-]{1,120}$`, 1–50 headers, ≤ 50,000 rows, every row length equal
to the header count, cells are text ≤ 4,000 characters, finite numbers, or
booleans. Control characters are rejected. A body over 8 MiB is rejected by
Kestrel; an over-limit row or header count returns `413`.

Success returns the OOXML bytes with the matching content type and
`content-disposition`. Failures return a small JSON body; request content and
the token are never logged.

## Run locally

```powershell
$env:ARTFLOW_PLUS_EXPORT_TOKEN = "local-export-token"
dotnet run --project plus/services/document-export/src/ArtFlow.DocumentExport
```

Then point the API at it:

```powershell
$env:ARTFLOW_PLUS_EXPORT_SERVICE_URL = "http://127.0.0.1:8080"
$env:ARTFLOW_PLUS_EXPORT_TOKEN = "local-export-token"
```

Without both variables the API keeps CSV available and returns
`503 EXPORT_UNAVAILABLE` for DOCX/XLSX.

## Verify

```powershell
dotnet restore plus/services/document-export/ArtFlow.DocumentExport.sln --locked-mode
dotnet test plus/services/document-export/ArtFlow.DocumentExport.sln
docker build -t artflow-plus-export:local plus/services/document-export
```

The xUnit suite generates both formats, re-opens them with the OpenXML SDK, and
runs `OpenXmlValidator`, so a missing table grid or malformed style fails the
build rather than a user's Word or Excel.

## Security invariants

- The service never reads the database and never resolves an identity; the Node
  API is the only author of the rows.
- The token is compared with `CryptographicOperations.FixedTimeEquals`; an empty
  configured token rejects every request.
- No template files, caller-provided paths, or relationship targets exist.
- Logs contain only the format and response size.
- Compose runs it read-only, non-root, on the internal network, with no
  published port and no proxy route.
