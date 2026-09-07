# Task 9 — Award rehearsal contracts and Admin authority surfaces

## Status

Implemented on `build/m1-authority-goal-v4`. Production rehearsal documentation now
uses the confirmed-stage award authority, and Django Admin exposes protected facts for
observation without acting as a second business write path.

## Changed files

- `docs/production-readiness.md`, `docs/production-rehearsal-runbook.md`
  - Replace the obsolete vote-lock popularity-award rehearsal with
    `AWARD → StageAwardDecision → CONFIRM → Award`.
  - Distinguish a vote-backed stage dependency from Award authority: locking a
    VoteSession never creates an Award, and an AWARD that does not consume votes needs
    no VoteSession.
  - Cover candidate visibility, idempotent confirm retry, stale candidate rejection,
    unlock/recompute behavior, and `source_vote_session` as legacy provenance only.
- `singer_contest/admin.py`
  - Make ContestRound, round snapshots, raw score facts, score summaries, and Award
    rows observation-only.
  - Keep singer/judge profile fields and draft rubric configuration editable; existing
    singer/judge identity fields remain read-only on change.
- `ruleset/admin.py`
  - Make RulesetVersion observation-only.
  - Keep only descriptive/availability maintenance fields editable on templates and
    descriptive naming editable on contest rulesets; freeze, capability, definition,
    binding, provenance, and lifecycle fields are read-only.
- `core/admin.py`
  - Prevent direct Activity creation/deletion while retaining edits to presentation
    metadata; state and lifecycle fields remain read-only.
- `voting/admin.py`
  - Register VoteSession, VoteOption, VoteBallot, and VoteRecord as observation-only.
- `files/admin.py`
  - Make file-version/current-state rows and material review decisions observation-only.
  - Keep StaffNote and MaterialRequirement operational metadata editable.
- `tests/test_check_docs.py`, `singer_contest/test_m1_core_final.py`,
  `ruleset/test_compiler.py`, `common/test_authority_matrix.py`
  - Add the docs/Admin contracts and align the shared Admin authority matrix.

## TDD evidence

### RED

`python -m pytest tests/test_check_docs.py singer_contest/test_m1_core_final.py ruleset/test_compiler.py -k "award or readiness or rehearsal or admin_authority_surface or observation_only or maintenance_metadata" -q`

Result before implementation: **13 failed, 6 passed, 101 deselected, 5 subtests
passed**. Failures identified the obsolete award wording, writable ContestRound,
round-snapshot, Award, SubmissionFile, MaterialCheck, and ruleset Admin paths, plus the
absence of voting Admin observation registrations.

### GREEN

The same command after implementation: **9 passed, 101 deselected, 15 subtests
passed**.

Broader scoped regression:

`python -m pytest singer_contest/test_m1_core_final.py singer_contest/test_core_raw_close.py common/test_authority_matrix.py tests/test_check_docs.py -q`

Result: **47 passed, 85 subtests passed**. This includes the domain contracts that a
VoteSession lock creates no Award and a READY StageAwardDecision remains only a
candidate until confirmed-stage materialization.

`python -m pytest ruleset/test_compiler.py -k "award or admin_authority_surface" -q`

Result: **2 passed, 77 deselected**.

## Verification

- `python manage.py check` — passed: `System check identified no issues (0 silenced).`
- `python manage.py makemigrations --check --dry-run` — passed: `No changes detected`.
- `pwsh -NoProfile -File scripts/check_docs.ps1` — passed for 11 user-facing Markdown
  files.
- Changed-file Ruff lint — passed for Task 9 files. Existing E501/I001 baseline in
  `common/test_authority_matrix.py` was excluded; the changed Admin assertion itself is
  covered by the passing matrix.
- `git diff --check` — passed; Git emitted only existing CRLF normalization notices.

## Self-review

- The docs do not claim that VoteSession lock is Award authority. A vote-backed AWARD
  still truthfully requires consumed raw input to be at rest before StageResult confirm.
- READY candidates remain distinct from official Award rows and official list/export
  visibility is tied to a CONFIRMED source stage.
- Retry, stale result-version/input-fingerprint, and unlock/recompute behavior match the
  current services; no new service or data authority was introduced.
- `source_vote_session` is documented as historical evidence only; no migration or new
  write path uses it.
- Protected Admin rows retain view permission but reject add/change/delete. Editable
  surfaces are limited to non-authoritative maintenance metadata or draft configuration,
  with account authority fields remaining read-only under the existing account Admin.
- No models, migrations, public file serving, vote identity rules, or unrelated cleanup
  changed.

## Residual concerns / inherited baseline

- A full `ruleset/test_compiler.py` run currently has 27 pre-existing fixture failures:
  older tests directly create privileged Users or non-DRAFT Activities outside the
  authority scopes added by earlier tasks. The Task 9-selected compiler contracts pass;
  repairing those historical fixtures is outside this task.
- The legacy confirm/stale/unlock selections in `singer_contest/tests.py` similarly stop
  in their pre-existing direct STAFF-user setup before reaching domain logic. The
  focused award authority tests and shared mutation matrix pass.
- `source_vote_session` remains in the schema until real historical rows are audited;
  this task deliberately does not guess whether data migration/removal is safe.

## Fix round 1 — Activity discriminator and documentation contract

### Changes

- Added `activity_type` to `ActivityAdmin.readonly_fields`; title, subtitle,
  description, and cover-image presentation metadata remain editable.
- Strengthened the rehearsal documentation contract to require literal
  `StageResult.status == CONFIRMED` authority for stage-sourced awards and the
  official Staff/`award_list` export visibility rule. Existing no-VoteSession-lock,
  retry, stale-candidate, and unlock assertions remain in place.
- Clarified both production rehearsal documents with the existing visibility rule:
  official views include historical awards without a stage source and stage-sourced
  awards only while their source StageResult is `CONFIRMED`.
- No model or business-service authority changed.

### TDD and focused verification

- RED: the two new regression contracts failed for the expected reasons: missing
  `activity_type` Admin protection and missing explicit confirmed-stage/visibility
  documentation (`2 failed`).
- GREEN: the exact two regressions passed (`2 passed`).
- Task 9 selector passed: `9 passed, 101 deselected, 15 subtests passed`.
- Scoped authority regression passed: `47 passed, 85 subtests passed`.
- Per the final handoff instruction, no additional broad tests or gates were run
  before commit; the final `git diff --check` was run after this appendix was added.
