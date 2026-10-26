# ADR-0021: Two-step legacy import with reconciliation

- **Status**: accepted
- **Date**: 2026-10-26

## Decision

Cutover imports v1 activities through a versioned JSON bundle. A v1 Django
management command (`export_plus_bundle`) writes the bundle from formal rows
only; a v2 runtime command (`activity.legacy.import`) validates it, writes the
activity, release, registrations, roster, materials metadata, competition facts,
vote sessions/ballots, and published results in **one transaction**, then
recomputes counts and hashes from v2 and refuses to commit on any mismatch. The
Node runtime never connects to the v1 database, and the bundle is a durable,
auditable intermediate artifact that can be dry-run and reused as a test fixture.

The importer translates **facts, not rules**. The v2 release's competition
artifact is built from the v1 rounds and rubric; constructs v2 cannot express
(group-chorus stages, multiple rubrics, brackets, composite scoring) are listed
in `unsupported` and their facts stay in v1. Published results are imported as
the frozen v1 snapshot, not recomputed.

Deterministic ids are prefixed with the activity public code
(`legacy-<publicCode>-<entity>-<v1 id>`), so two bundles cannot collide and a
replay of the same bundle is refused by the command receipt. Test rows
(`is_test_data` / `is_test_mode`) are skipped and counted; historical ballots
are anonymous; materials keep metadata only with `storage_key = legacy:<id>`.

## Alternatives rejected

- Node connecting directly to v1 SQLite/PostgreSQL: couples the v2 runtime to
  the v1 schema and gives the import unreviewable reach into production.
- Re-deriving v2 rules from the v1 ruleset: the two models differ; inventing a
  translation would produce results nobody can explain. Imported snapshots stay
  authoritative for history.
- Importing test rows or media bytes: they are not authority, and v2 has no
  media read gateway yet.
- Writing without reconciliation: a partially understood v1 activity would
  silently become a v2 authority.

## Consequences

- Import is two commands and one intermediate file; the report is the cutover
  evidence.
- An unrepresentable activity fails closed instead of importing a half-model.
- Imported historical activities are `closed`; their public results are served
  from the frozen snapshot. Imported current activities remain operable, subject
  to `unsupported` gaps (for example group-chorus stages).
- Re-importing the same bundle replays the receipt; importing a changed bundle
  for an existing public code is refused.
- Dry-run validates references and declared counts without writing; full
  reconciliation runs only in the real import.
