# ADR-0033: Participant and material cutover closure

- Status: accepted
- Date: 2026-10-27
- Supersedes: none; completes ADR-0032

## Context

Semantic adoption fixed the competition and registration definitions, but the
last mile of a real v1 activity still lost facts and files:

- the exporter only emitted `SubmissionFile` rows, so a `MaterialCheck` with
  `needs_supplement` and no file (the missing lyric) disappeared;
- adoption produced `document + */*` file slots, while material purposes came
  from MIME types, so real audio could not be accepted;
- registration lifecycle `review/final` blocked supplements as well as new
  signups, contradicting the business rule "free signup closes, staff-specified
  supplements remain possible";
- imported participants are `legacy-user:<id>` and cannot act as a Plus
  `participant:<uuid>` account;
- metadata was inserted as current before bytes existed, so a failed content
  upload removed the previous good file from the current authority;
- the production compose file had no persistent Plus media volume and no
  read-only v1 media mount;
- a global 26 MiB body limit was smaller than a stage-show release that allows
  100 MiB;
- media path segments were ASCII-only, which rejects real Chinese filenames.

## Decision

### Material checks are first-class bundle facts

The v1 exporter emits `materialChecks` for every singer `MaterialCheck`,
including slots with no `SubmissionFile`. Adoption imports them into
`material_check` (slot key, item name, purpose(s), status, required, note) and
adds each slot to the adopted questionnaire as a file question with explicit
extensions and purposes. Existing files remain `material` rows; missing slots
remain missing facts instead of disappearing.

### Registration lifecycle keeps a supplement seam

`registration.supplement.issue` is a staff command. It sets the registration to
`need_supplement` and stores `supplementKeys`; it issues an opaque capability
token bound to that registration and those slots. The public supplement
endpoints (`claim`, `context`, material content, `submit`) let a v1 participant
supplement without migrating a v1 account. In `review/final`, new registration
and normal edits are refused; only slots in `supplementKeys` may be written.

### Material upload is staged and atomic

`materials.upload` creates a non-current, `content_ready=false` staging row.
`PUT /materials/:id/content` writes bytes first, then retires the old current row
and activates the new one in one transaction. A failed content write leaves the
old current material untouched. `materials.review` refuses to approve a row whose
content is not ready. The same command updates the matching `material_check`
status.

### Deployment and transport

Production compose mounts a persistent `plus_media_data` at
`ARTFLOW_PLUS_MEDIA_DIR` and the v1 `media_data` read-only at
`ARTFLOW_PLUS_LEGACY_MEDIA_DIR`; `.env.production.example` documents both. The
octet-stream parser limit is 128 MiB, while the released materials policy remains
the authority (up to 100 MiB for stage shows).

### Media paths

Material storage allows Unicode segments (NFC-normalized) and rejects only
separators, control characters, and traversal. A legacy `submissions/伴奏.mp3`
is served through the controlled content route.

### Readiness naming

The adoption report field is `semanticReady`, not `rehearsalReady`: it proves
definition/fact compatibility. Production cutover uses the automated activity
acceptance journey, isolated operational smoke, and owner acceptance; a real
activity rehearsal is not a prerequisite.

## Consequences

- Existing adopted activities must be re-adopted to gain material checks, real
  file slots and the staged upload path.
- Supplement grants expire and are revoked on submit; they never become a
  general account.
- A pending metadata row that never receives content is not current and is
  invisible; the previous file stays authoritative.
- Grouping→result dependency propagation and moving registration lifecycle from
  the release artifact to runtime state remain future architecture work.

## Verification

- `material-cutover.test.ts` adopts a bundle with an approved accompaniment and
  a missing lyric, reads the legacy bytes through the bridge, issues a
  supplement capability, uploads the lyric, keeps the old current on a failed
  replacement, switches atomically on success, reviews the replacement, submits,
  and reads both files from a fresh storage instance.
- Registration tests upload metadata plus content before submit/review.
- API activity-shape tests attach content through the HTTP route.
- Full suites, E2E, structural gates and documentation checks stay green.
