# ADR-0015: Archive packages, local-volume storage, and formal-only publishing

- **Status**: accepted
- **Date**: 2026-10-26

## Decision

`archive` owns the sealed archive package and the archive/unarchive commands.
An activity must be `closed` with no running session, every enabled
`competition` round locked, no unsettled score correction, every enabled
`voting` session closed, and at least one ACTIVE release when `publishing` is
enabled. Failure is a domain error; no package and no state change are written.

The package is a local-volume ZIP (`ARTFLOW_PLUS_ARCHIVE_DIR`, key
`{activityId}/v{version}.zip`) containing JSON, CSV, and a README. Only
whitelisted fields are exported: no fingerprint, authority hash, token,
questionnaire answer, ballot identity, storage path, or staff note.
Registration/material/vote/score detail is deliberately excluded because those
fact tables have no mode column yet; the package carries activity identity,
publishing stage results/releases, formal execution sessions, and an event
summary.

The activity segment of the storage key accepts `[A-Za-z0-9_-]` so historical
imports whose public codes contain uppercase letters remain downloadable. The
two-segment shape, versioned ZIP filename, and root-containment check remain
mandatory.

The file write happens inside the command transaction with reverse compensation:
if the command or commit fails, the written file is removed. A crash between
rename and commit may leave an orphan; a retry computes the same version and
overwrites it. Downloads verify size and SHA-256 and fail closed with
`ARCHIVE_INTEGRITY_FAILED`.

Publishing commands are formal-only. `TEST`/`REHEARSAL` sessions cannot confirm,
release, revoke, unlock, or edit a publication. Without this guard a rehearsal
could become the public result because capability fact tables do not carry a
mode column.

Unarchive is a separate audited authority: it demotes the current package, keeps
the file/history, and returns the activity to `closed`. `ARCHIVED` remains
terminal for every other command.

## Alternatives rejected

- Storing the package only as JSONB would avoid file I/O but would not produce a
  human-openable artifact.
- A public archive URL would violate the controlled-media rule; the download is
  permission-checked and integrity-checked.
- Including registration/vote/score detail now would put unproven, possibly
  test-mode facts into a permanent record.
