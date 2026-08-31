# Changelog

## 2026-09-01

### M1-R9 — Authoritative Result Snapshot Closure

Closed the remaining integrity gaps between the resolver engine and production so a
result board reflects exactly what the authoritative ruleset produced.

- `ruleset` — added `vote_keys` / `group_keys` binding fields on `ContestRuleset` and a
  minimal `ruleset_bind` staff editor, so `recompute_activity_result` can auto-source
  audience votes and group membership from the database instead of needing hand-injected
  kwargs.  Added `ManualDecision` (singer_contest) so `MANUAL_SELECT` picks persist and
  re-read under a formal service path.
- `singer_contest` — `recompute_activity_result` now sources `vote_scores`, `group_of`, and
  `manual` from the DB; `run_ruleset(preview=True)` is an isolated in-memory comparison that
  never persists a `StageResult`, so a superseded frozen version cannot pollute the board.
- `staff_panel` — a result-board fix kept tests green under the new per-stage publication
  number.

## 2026-08-31

### M1-R5 / M1-R6 / M1-R7 — Authority closure, stage finality, resolver truthfulness

- `RulesetVersion` closed three authority gaps: a canonical binding hash, exact version
  identity, and a single-activity constraint.  `confirm_stage_result` finally locks a result
  only when it is grounded on the current FROZEN authority; unlock (`unlock_stage_result`)
  reverts a CONFIRMED result with an audited admin verifier.
- `StageResult`/`StageDecision`/`CompositeResult` became immutable once CONFIRMED; a result's
  `result_version` is pinned at publication time so two concurrent recomputes cannot mint the
  same number.
- Checkpoint decisions now carry their own stage output; the honest `golden_xiaofeng` was
  re-labelled as a control-flow demo rather than a historical Golden.

## 2026-08-29

### M1-B → M1-J — Contest domain, resolver, golden simulations, operations

- `singer_contest` / `ruleset` — a generic contest-fact model decoupled `Performance` from
  `SingerRegistration`, plus a versioned typed ruleset schema (`ContestRuleset` /
  `RulesetVersion`), a compiler/validator that rejects a ruleset before freeze, and a
  `resolve_to_checkpoint` scoped resolve.
- Added the deterministic stage resolver engine (`M1-E`), the 2025 院十佳 golden simulation
  (`M1-F`), the group-scoped `SELECT`/`by` + 2025 校十佳屏峰 golden (`M1-G`), and the
  backstage rapid-score-entry + result board (`M1-H`).
- `M1-I` — a staff ruleset template library, editor (create/validate/preview/freeze), and
  "clone last year + instantiate template" flow.
- `M1-J` — strict score-workbook snapshot fingerprint with all-or-nothing reject, an oversized
  video direct-upload ban in production UI, and rehearsal report templates.

## 2026-08-28

### M0 hardening + M1-A

Hardened the system invariants that the contest domain builds on, then shipped M1-A:

- Activity-first authority and transaction lock hierarchy (Activity → child → dependent), with
  phase and lifecycle enforced as authorization policy.
- Explicit, literal activity phase-transition graph; ARCHIVED readonly and re-openable only by
  an audited admin operation.
- TEST/FORMAL strict isolation; runtime rows carry a lifecycle marker; test cleanup refuses a
  cascade that would touch formal data.
- Immutable round snapshots with a prepared-round workflow; `RoundEntry` snapshot pairs; round
  preparation guard rails (base-manager and bulk-mutation guards).
- Activity-scoped personal-data exports with a uniform EXPORT audit; production user/role
  administration via an audited domain service; complete material-review and
  participant-editing loops; formal execution/archive packages.

## 2026-08-27

### Production correctness hardening + competition domain hardening

- Added the PostgreSQL/Compose acceptance contract, expose-data scope rules, and a backup/
  restore drill; closed the production business invariants that a live run depends on.
- Added the competition-domain hardening plans and specs (round snapshots, vote state service,
  advancement finality, registration uniqueness).

## 2026-08-18

### Engineering baseline

- Documented lockfile-based development setup, SQLite and PostgreSQL runtime paths, container data volumes, diagnostics, health checks, and safe demo-data reset behavior.
- Recorded local and CI quality gates, troubleshooting guidance, and source-control and secret-handling expectations.
- Added documentation validation for stale setup instructions, unsafe sample credentials, aggregate implementation counts, and unresolved repository-relative Markdown links.
