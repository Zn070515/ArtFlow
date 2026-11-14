# M2-C Judge Authority / Direct Scoring / School Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This repository explicitly forbids subagents and linked worktrees; execute the plan inline in the current checkout.

**Goal:** Deliver a production-shaped temporary judge workflow whose scoring authority is bound to a frozen panel seat and server-owned live performance context, while producing the evidence and operational boundaries needed for later school deployment.

**Architecture:** Keep the contest authority domain in `singer_contest` because `ContestRound`, `RoundJudge`, `Performance`, and `ScoreRecord` already form one integrity boundary. Add judge-panel models to `singer_contest.models`, focused services in `singer_contest/judge_authority.py`, focused HTTP views in `singer_contest/judge_views.py`, and a strict TypeScript judge terminal. Reuse `entry_access` only for one-time grant/ephemeral-token transport; a bound `JudgeSession` is the scoring authority. A server-owned `PerformanceRunState` supplies the current performer, and every score source converges on one guarded formal-fact service.

**Tech Stack:** Django ORM and `TestCase`/`TransactionTestCase`, PostgreSQL row locks and migrations, existing `entry_access` services, existing `common.authority` scopes and audit log, strict TypeScript compiler, Node client tests, Playwright, Ruff, mypy, Pyright/Pylance, Docker Compose PostgreSQL acceptance, and the existing backup/restore rehearsal.

**Spec:** `docs/superpowers/specs/2026-09-08-m2-c-judge-authority-school-readiness-design.md`

## Global Constraints

- Work directly in `C:\Users\16275\Desktop\ArtFlow`; do not create `.worktree`, `worktrees`, or linked worktrees, and do not spawn subagents for repository modifications.
- After approval, start implementation from an up-to-date `main` on `feat/m2-c-judge-authority`; keep the approved spec and this plan in the history, and make each logical test, security/behavior, type-hygiene, and documentation change a small conventional commit.
- Use TDD for every behavior change: add focused failing tests, run them to demonstrate the missing behavior, implement the smallest change, run the focused gate, then commit.
- Before every production-Python commit run `npm run check:pyright` and `npm run check:pyright:entry-access`; both must have zero diagnostics. Also run the relevant Django tests, `python manage.py check`, `python manage.py makemigrations --check --dry-run`, Ruff, and mypy.
- Preserve M2-A generic `entry_access` grant/session semantics and M2-B ticket semantics. A generic `EphemeralSession` is transport/authentication context only; it is never direct judge scoring authority.
- Never accept client-selected activity, round, judge, seat, panel snapshot, or current performer as authority. Expected context values are optimistic stale-page guards only.
- Keep raw QR/grant/session tokens out of database fields, audit records, logs, URLs, HTML, JSON error bodies, traces, screenshots, local drafts, and backups. Persist digests and non-secret correlation IDs only.
- Formal score facts, panel snapshots, judge sessions, and live performance state are written only by named audited services inside `transaction.atomic()` with deterministic `Activity → ContestRound → domain row` lock order.
- Preserve existing `RoundJudge`/`RoundEntry` post-preparation immutability. A later panel version uses immutable snapshot-member rows; it never mutates, deletes, or adds to the prepared `RoundJudge` set.
- M2-C initially supports `HOLD_ONLY` for post-preparation panel changes. Any versioned replacement path must be explicitly declared by frozen policy and must create a new immutable snapshot; unsupported policy values fail closed.
- `HOLD` is a scoring-context state in the panel snapshot/live-state records. Do not invent or directly write a new `ContestRound.status` value unless the existing state machine is deliberately extended in a separate approved design.
- Do not use `docker compose down --volumes`, reset, or drop the running source PostgreSQL database or its volumes. Temporary restore targets only may be created and removed by the existing rehearsal scripts.
- M2-C is SSO-neutral and does not claim WAF, DDoS mitigation, TLS termination, MLPS, or institutional legal compliance. School readiness means documented interfaces, evidence, and deployment responsibilities.

---

## Repository Map and File Responsibilities

The implementation must use these focused boundaries:

- `singer_contest/models.py`: `RoundPanelSnapshot`, immutable snapshot members, `JudgeSeat`, `JudgeSeatGrant`, `JudgeSession`, `PerformanceRunState`, and formal `ScoreRecord` provenance fields. Keep model guards close to their data.
- `singer_contest/judge_authority.py`: preparation, seat assignment, panel HOLD/revision, grant binding, session authentication, live-context transitions, score command validation, idempotency, `STAFF_PROXY`, paper DR, and formal fact materialization.
- `singer_contest/judge_views.py`: judge context/score endpoints and staff-only panel/stage/proxy endpoints. Views parse requests and call services; they do not decide authority.
- `singer_contest/judge_urls.py` and `config/urls.py`: mount the narrow judge routes without changing M2-A `entry-access/` URLs.
- `singer_contest/test_judge_authority.py`: model, service, race, abuse, provenance, and direct-ORM regression tests owned by this feature.
- `singer_contest/test_judge_http.py`: HTTP/CSRF/origin/rate-limit/error-shape tests for judge and staff routes.
- `common/authority.py` and `common/models.py`: explicit write scopes and redacted audit action values.
- `frontend/judge_terminal.ts`: typed judge context, local draft, command creation, ACK/retry state machine, and generic error rendering.
- `tests/client/judge_terminal.test.mjs`: deterministic client tests without network or secrets in fixtures.
- `tests/e2e/judge-flow.spec.ts`: Playwright scan/session/context/score/replay/stale-context flow.
- `templates/singer_contest/judge_terminal.html` and `templates/staff_panel/judge_panel_*.html`: judge and staff surfaces with no secret-bearing rendered state.
- `docs/production-readiness.md`, `docs/school-onboarding.md`, `docs/backup-restore.md`, and `docs/incident-response.md`: evidence and institutional boundary documentation.

The exact migration files are generated after model tests and must be included
in the commit that introduces their models. Do not hand-edit an old migration.
Because `singer_contest.models` currently defines `Performance` after the score
models, use string model references for forward relations instead of reordering
the large existing module.

## Domain Interfaces

The following names and signatures are the contract between plan tasks:

```python
@dataclass(frozen=True)
class JudgeContext:
    activity_id: int
    round_id: int
    seat_id: int
    panel_snapshot_id: int
    panel_version: int
    context_version: int
    performance_id: int | None
    performance_state: str
    rubric_payload: Mapping[str, object]

def prepare_judge_panel(round_id: int, *, operator: User) -> RoundPanelSnapshot:
    raise NotImplementedError

def issue_judge_grant(
    seat_id: int, *, operator: User, ttl_seconds: int
) -> IssuedAccessGrant:
    raise NotImplementedError

def authenticate_judge_session(raw_ephemeral_token: str) -> JudgeSession:
    raise NotImplementedError

def get_judge_context(raw_ephemeral_token: str) -> JudgeContext:
    raise NotImplementedError

def submit_judge_score(
    raw_ephemeral_token: str,
    *,
    command_id: str,
    expected_context_version: int,
    expected_performance_id: int,
    score_payload: Mapping[str, object],
    notes: str = "",
) -> JudgeScoreReceipt:
    raise NotImplementedError

def submit_staff_proxy_score(
    *,
    operator: User,
    seat_id: int,
    expected_performance_id: int,
    score_payload: Mapping[str, object],
    reason: str,
    source_reference: str,
    command_id: str,
) -> JudgeScoreReceipt:
    raise NotImplementedError
```

`JudgeContext` values are server-derived. `expected_performance_id` and
`expected_context_version` are compared against the locked live state and are
never used to select a different performer. `JudgeScoreReceipt` contains only a
status, reason code, formal `ScoreRecord` ID, and non-secret context metadata.

The existing `ScoreWriteReceipt` remains dedicated to `apply_scores_if_version`
and is not reused for judge commands. M2-C adds this separate receipt contract
inside `singer_contest.models`:

```python
class ScoreSource(models.TextChoices):
    STAFF_RAPID = "staff_rapid", "Staff rapid score"
    DIRECT_JUDGE = "direct_judge", "Direct judge"
    STAFF_PROXY = "staff_proxy", "Staff proxy"
    PAPER_DR = "paper_dr", "Paper disaster recovery"
    IMPORT = "import", "Approved import"

class JudgeScoreReceipt(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        SUCCEEDED = "succeeded", "Succeeded"

    command_id = models.CharField(max_length=64, unique=True)
    operation = models.CharField(max_length=32)
    source = models.CharField(max_length=16, choices=ScoreSource.choices)
    payload_hash = models.CharField(max_length=64)
    panel_snapshot = models.ForeignKey(RoundPanelSnapshot, on_delete=models.PROTECT)
    seat = models.ForeignKey(JudgeSeat, on_delete=models.PROTECT)
    performance = models.ForeignKey(Performance, on_delete=models.PROTECT)
    session = models.ForeignKey(JudgeSession, on_delete=models.PROTECT, null=True, blank=True)
    operator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="judge_score_receipts",
    )
    score_record = models.OneToOneField(
        ScoreRecord,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="judge_receipt",
    )
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    result_code = models.CharField(max_length=32, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)
```

`ScoreSource` is a `models.TextChoices` enum with exactly `STAFF_RAPID`,
`DIRECT_JUDGE`, `STAFF_PROXY`, `PAPER_DR`, and `IMPORT`. `ScoreRecord` gains
`source`, nullable `panel_snapshot`, nullable `judge_seat`, and a bounded
`source_reference`. Existing records receive the explicit `STAFF_RAPID`
migration default; new direct/proxy/paper/import records must set source through
the formal fact service. The existing `is_test_data` flag remains the
test/formal boundary.

## Task 1: Establish the M2-C authority vocabulary and red contract tests

**Files:**

- Modify: `common/authority.py`
- Modify: `common/models.py`
- Create: `singer_contest/test_judge_authority.py`
- Create: `singer_contest/test_judge_http.py`
- Modify: `singer_contest/models.py`
- Modify: `singer_contest/apps.py` only if model import registration requires it

**Interfaces:** Consumes existing `ContestRound`, `RoundJudge`, `Judge`,
`Performance`, `ScoreRecord`, `entry_access.EphemeralSession`,
`authority_write`, and `AuditLog`. Produces the five explicit M2-C scopes and
the test fixtures used by every later task.

- [ ] Add failing tests named `test_judge_authority_scopes_are_explicit`, `test_judge_audit_actions_fit_storage_limit`, and `test_judge_fixture_does_not_persist_raw_token`. Assert the scopes are distinct from `ENTRY_POINT_CONFIG`, `EPHEMERAL_SESSION_STATE`, and `TICKET_SESSION_STATE`.
- [ ] Add failing model-contract tests for the exact proposed objects: snapshot version, immutable member rows, seat state, grant binding, session expiry/revocation, live context version, provenance source, and command identity. Assert all activity/round relations are same-activity and all secret fields are digest-only.
- [ ] Add failing direct-ORM tests for `.save()`, `.update()`, `.bulk_update()`, `.bulk_create()`, conflict upsert, `_base_manager`, relation moves, deletes, and admin querysets. Verify every protected write is rejected unless the owning service scope is active.
- [ ] Run `python manage.py test singer_contest.test_judge_authority singer_contest.test_judge_http` and record the expected missing-model/scope failures. Do not implement production code before the red tests exist.
- [ ] Add `JUDGE_PANEL_STATE`, `JUDGE_SESSION_STATE`, `ROUND_PERFORMANCE_STATE`, `JUDGE_SCORE_SUBMISSION`, and `SCORE_FACT_WRITE` to `common/authority.py` with stable string values.
- [ ] Add bounded audit action types for panel prepared/changed/held, seat assigned/revoked, judge session issued/revoked, performance advanced/held, score submitted, proxy entry, and paper entry. Keep stored values within the existing `AuditLog.action_type` limit.
- [ ] Commit only this vocabulary and red-contract batch as `test: define m2-c judge authority contract` after `git diff --check`.

## Task 2: Add immutable panel snapshots, seats, sessions, and live context

**Files:**

- Modify: `singer_contest/models.py`
- Create: `singer_contest/migrations/0034_m2c_judge_authority.py`
- Modify: `singer_contest/test_judge_authority.py`
- Modify: `common/test_authority_matrix.py` only for shared matrix registration

**Interfaces:** Consumes Task 1 scopes and existing round snapshot guards.
Produces `RoundPanelSnapshot`, `RoundPanelSnapshotMember`, `JudgeSeat`,
`JudgeSeatGrant`, `JudgeSession`, and `PerformanceRunState` model contracts.

Use this model shape, adapting field names to existing project conventions:

```python
class RoundPanelSnapshot(models.Model):
    class State(models.TextChoices):
        ACTIVE = "active", "Active"
        HOLD = "hold", "Hold"
        SUPERSEDED = "superseded", "Superseded"

    class ChangePolicy(models.TextChoices):
        HOLD_ONLY = "hold_only", "Hold only"
        VERSIONED_REPLACEMENT = "versioned_replacement", "Versioned replacement"

    round = models.ForeignKey(ContestRound, on_delete=models.PROTECT)
    activity = models.ForeignKey(Activity, on_delete=models.PROTECT)
    version = models.PositiveIntegerField()
    change_policy = models.CharField(max_length=24, choices=ChangePolicy.choices)
    state = models.CharField(max_length=16, choices=State.choices)
    expected_judge_count = models.PositiveIntegerField()
    minimum_judge_count = models.PositiveIntegerField()
    scoring_method = models.CharField(max_length=32)
    roster_digest = models.CharField(max_length=64)
    captured_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="captured_judge_panel_snapshots",
    )
    is_test_data = models.BooleanField(default=False)

class RoundPanelSnapshotMember(models.Model):
    panel_snapshot = models.ForeignKey(RoundPanelSnapshot, on_delete=models.PROTECT)
    judge = models.ForeignKey(Judge, on_delete=models.PROTECT)
    source_round_judge = models.ForeignKey(RoundJudge, on_delete=models.PROTECT)
    seat_key = models.CharField(max_length=32)
    is_active = models.BooleanField(default=True)

class JudgeSeat(models.Model):
    class State(models.TextChoices):
        ASSIGNED = "assigned", "Assigned"
        REVOKED = "revoked", "Revoked"
        HOLD = "hold", "Hold"

    panel_member = models.ForeignKey(RoundPanelSnapshotMember, on_delete=models.PROTECT)
    state = models.CharField(max_length=16, choices=State.choices)
    assigned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="assigned_judge_seats",
    )
    revoked_at = models.DateTimeField(null=True, blank=True)
    revocation_reason = models.CharField(max_length=240, blank=True)

class JudgeSeatGrant(models.Model):
    access_grant = models.OneToOneField("entry_access.AccessGrant", on_delete=models.PROTECT)
    seat = models.ForeignKey(JudgeSeat, on_delete=models.PROTECT, related_name="grants")
    panel_snapshot = models.ForeignKey(RoundPanelSnapshot, on_delete=models.PROTECT)

class JudgeSession(models.Model):
    class State(models.TextChoices):
        ACTIVE = "active", "Active"
        REVOKED = "revoked", "Revoked"

    ephemeral_session = models.OneToOneField("entry_access.EphemeralSession", on_delete=models.PROTECT)
    seat = models.ForeignKey(JudgeSeat, on_delete=models.PROTECT, related_name="sessions")
    panel_snapshot = models.ForeignKey(RoundPanelSnapshot, on_delete=models.PROTECT)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)

class PerformanceRunState(models.Model):
    class State(models.TextChoices):
        IDLE = "idle", "Idle"
        PERFORMING = "performing", "Performing"
        ACCEPTING_SCORE = "accepting_score", "Accepting score"
        HOLD = "hold", "Hold"
        CLOSED = "closed", "Closed"

    round = models.OneToOneField(ContestRound, on_delete=models.PROTECT)
    current_performance = models.ForeignKey(Performance, on_delete=models.PROTECT, null=True, blank=True)
    state = models.CharField(max_length=24, choices=State.choices)
    context_version = models.PositiveIntegerField(default=0)
```

- [ ] Add failing tests for same-activity constraints, unique snapshot version, unique seat key per snapshot, no active duplicate snapshot member, one active grant per seat with expired/revoked history allowed, one session per ephemeral session, one live state per round, protected deletion, test/formal marker consistency, and no raw token fields. Also require `JudgeSeatGrant.panel_snapshot_id == seat.panel_member.panel_snapshot_id`, `JudgeSession.panel_snapshot_id == seat.panel_member.panel_snapshot_id`, grant/session activity-round-kind equality, session expiry no later than the transport session expiry, and `PerformanceRunState.current_performance` activity/round equality.
- [ ] Add failing tests proving prepared `RoundJudge` rows cannot be changed, while a new immutable snapshot member can preserve the original source row and a new snapshot can be created only by its service.
- [ ] Implement model `clean()` and queryset guards. Reject direct changes to snapshot version/member identity/seat identity/session binding/live context, conflict upserts, and protected deletes. Use `TYPE_CHECKING` declarations for reverse managers instead of broad suppressions.
- [ ] Implement the initial migration with `PROTECT` relations, indexes on active state/expiry/context version, and database uniqueness constraints. Do not use `CASCADE` for formal panel/session authority rows.
- [ ] Run `python manage.py makemigrations --check --dry-run`, `python manage.py check`, the focused model tests, `npm run check:pyright`, and `npm run check:pyright:entry-access`.
- [ ] Commit as `feat: add immutable m2-c judge authority models`.

## Task 3: Implement panel preparation, seat assignment, and live-stage services

**Files:**

- Create: `singer_contest/judge_authority.py`
- Modify: `singer_contest/test_judge_authority.py`
- Modify: `core/policies.py` only if a dedicated stage-control action is required
- Modify: `staff_panel/forms.py`, `staff_panel/urls.py`, `staff_panel/views.py`
- Create: `templates/staff_panel/judge_panel_prepare.html`, `templates/staff_panel/judge_panel_detail.html`

**Interfaces:** Consumes Task 2 models, `require_current_staff`,
`ensure_activity_action_allowed`, existing round preparation, and frozen ruleset
parameters. Produces `prepare_judge_panel`, `assign_judge_seat`,
`hold_judge_panel`, `advance_performance`, `hold_performance`, and
`resume_performance`.

- [ ] Add failing service tests for expected/minimum judge count, ruleset scoring method, roster digest, deterministic seat keys, preparation idempotency, cross-activity rejection, non-staff rejection, draft-only setup, and audit rows.
- [ ] Add failing tests for the safe initial panel-change policy: after preparation, a change enters scoring-context `HOLD`, revokes affected sessions, and does not mutate `RoundJudge`; unsupported replacement policy values are rejected rather than interpreted permissively.
- [ ] Add failing tests for live state transitions: idle → performing, performing → accepting score, accepting score → next performance, any state → hold, hold → resumed state, closed-state rejection, monotonic `context_version`, and stale expected-context rejection.
- [ ] Commit red service tests as `test: cover m2-c panel and live context rules`.
- [ ] Implement every transition in `transaction.atomic()` with `Activity → ContestRound → snapshot/run-state` locks. Re-read the operator and authority facts inside the transaction; do not trust objects supplied by the caller.
- [ ] Build the initial immutable snapshot from prepared `RoundJudge` rows and frozen scoring parameters. Create snapshot members and seats in stable order, calculate a canonical roster digest, and write one redacted audit event.
- [ ] Implement `HOLD_ONLY` panel handling. Mark the active snapshot and live state held, revoke affected sessions, record reason/actor/time, and require explicit staff resume. Do not mutate `ContestRound.status` to an undefined value.
- [ ] Implement live performance transitions so the current performer is always server-owned and every advance increments `context_version` under the fixed lock order.
- [ ] Add CSRF-protected staff routes and forms that call only these services. Staff UI may display seat/performance context but must not expose raw tokens or allow arbitrary foreign IDs through hidden fields without service revalidation.
- [ ] Run focused tests, full `singer_contest` tests, Django checks, both Pyright gates, Ruff, mypy, and `git diff --check`; commit as `feat: add m2-c panel and live-stage services`.

## Task 4: Bind one-time grants to seats and expose judge context safely

**Files:**

- Modify: `entry_access/services.py` only to expose a typed, non-secret redemption result if required; do not change existing grant/session semantics
- Create: `singer_contest/judge_views.py`
- Create: `singer_contest/judge_urls.py`
- Modify: `config/urls.py`
- Modify: `singer_contest/judge_authority.py`
- Modify: `singer_contest/test_judge_authority.py`, `singer_contest/test_judge_http.py`
- Create: `templates/singer_contest/judge_terminal.html`

**Interfaces:** Consumes `issue_access_grant`,
`redeem_access_grant`, `authenticate_ephemeral_session`, and Task 3 seat/live
services. Produces `issue_judge_grant`, `authenticate_judge_session`, and
`GET /judge/context/` plus a narrow `POST /judge/bootstrap/` only if the
existing entry-access response needs a domain binding step.

- [ ] Add failing tests for grant binding to exactly one seat/snapshot, mismatch/revocation/expiry, cross-activity/cross-round rejection, one-time redemption, generic invalid response, and no raw token in audit/log/error/HTML output.
- [ ] Add failing tests proving a valid generic `EphemeralSession` without a `JudgeSeatGrant` cannot read context or score, and a valid judge session cannot reach staff/scanner/ticket authority.
- [ ] Add failing HTTP tests for method restrictions, body-size limits, malformed JSON, same-origin policy for bearer-token transport, CSRF protection on staff mutations, rate limiting, generic errors, and `Cache-Control: no-store` on credential-related responses.
- [ ] Implement `issue_judge_grant` as an atomic staff service: lock the seat/snapshot, issue the generic JUDGE grant through `entry_access`, create `JudgeSeatGrant` with no raw secret, and return the raw grant only to the immediate caller.
- [ ] Implement `authenticate_judge_session` by authenticating the generic ephemeral token, resolving the bound `JudgeSession`, rechecking activity/round/seat/snapshot state and expiry, and returning a generic invalid result for every failure class.
- [ ] Use an in-memory `Authorization: Bearer` transport for the judge terminal if the existing generic redeem flow returns a JSON session token. Never put the token in query/path, local drafts, persistent storage, or cookie-as-initial-credential. The endpoint must not accept a client-selected seat or round.
- [ ] Implement `GET /judge/context/` to derive all IDs and current performance from `JudgeSession` plus `PerformanceRunState`; expose only rubric fields and non-sensitive labels needed by the terminal.
- [ ] Run focused HTTP/service tests, both Pyright gates, Ruff, mypy, Django checks, and the existing `entry_access` test suite; commit as `feat: bind judge sessions to operational seats`.

## Task 5: Implement guarded score commands, provenance, idempotency, and DR sources

**Files:**

- Modify: `singer_contest/models.py`
- Modify: `singer_contest/services.py` only for a narrow shared formal-fact helper
- Modify: `singer_contest/judge_authority.py`, `singer_contest/judge_views.py`
- Create: `singer_contest/migrations/0035_m2c_score_provenance.py`
- Modify: `singer_contest/test_judge_authority.py`, `singer_contest/test_judge_http.py`, `singer_contest/test_authority_closure.py`
- Modify: `staff_panel/forms.py`, `staff_panel/views.py`, `staff_panel/urls.py`
- Create: `templates/staff_panel/judge_proxy_score.html`, `templates/staff_panel/judge_paper_reentry.html`

**Interfaces:** Consumes Task 3 live context and Task 4 session binding;
produces `submit_judge_score`, `submit_staff_proxy_score`, and one shared
formal score-fact materialization path.

- [ ] Add failing direct-score tests for score range/rubric validation, missing/expired/revoked session, panel HOLD, stale context, wrong performance, closed window, duplicate fact, malformed notes, cross-activity references, and no partial writes.
- [ ] Add failing idempotency tests: same command/payload returns the original receipt; same command/different payload or context returns `IDEMPOTENCY_CONFLICT`; a failed command never becomes a successful replay; concurrent retries create one formal fact.
- [ ] Add failing PostgreSQL `TransactionTestCase` coverage for two sessions/tabs submitting the same seat/performance, panel HOLD racing with score submission, and performance advance racing with score submission. SQLite tests may characterize behavior but cannot satisfy the acceptance gate.
- [ ] Add failing provenance tests for `DIRECT_JUDGE`, `STAFF_PROXY`, `PAPER_DR`, and approved `IMPORT`; assert source, seat/snapshot reference, operator/reason/reference, command ID, and before/after correction audit are present without raw credentials.
- [ ] Add failing tests proving ordinary judge commands cannot correct an existing score. A pre-lock correction must use a separate reason-bearing service and immutable before/after audit under `SCORE_FACT_WRITE`.
- [ ] Commit red score/DR tests as `test: cover m2-c score authority and provenance`.
- [ ] Extend `ScoreRecord` with bounded source/provenance fields and a non-secret command correlation field while preserving its existing round/singer/judge uniqueness and lock guards. Use string references only where a migration cycle would otherwise be introduced; do not weaken relational activity checks.
- [ ] Require `ScoreRecord.source == DIRECT_JUDGE` to have a seat, panel snapshot, and successful `JudgeScoreReceipt`; require `STAFF_PROXY`/`PAPER_DR` to have their bounded source reference and operator audit; allow legacy `STAFF_RAPID` rows to retain null judge-session provenance. Reject a source/relationship mismatch before mutation.
- [ ] Bridge the new `SCORE_FACT_WRITE` scope to the existing `_raw_fact_write_authorized()` guard through one private context manager owned by the formal-fact service. No caller may pass a public bypass flag, invoke the raw guard directly, or write a locked/consumed `ScoreRecord` outside that service.
- [ ] Implement a canonical payload hash from activity, round, snapshot version, seat/judge, performance, rubric version, source, and normalized score payload. Persist command receipt state before materialization, then materialize the formal fact and mark the receipt succeeded in one transaction.
- [ ] Derive judge/seat/snapshot/performance from the authenticated session and locked live state. Treat client expected IDs only as equality checks. Reject stale or changed state before any `ScoreRecord` write.
- [ ] Implement `STAFF_PROXY` with authenticated operator, server-resolved seat, original judge context, bounded reason, source reference, same rubric/lock/context checks, and a distinct audit source. Implement paper re-entry with a required bounded paper reference and no silent `DIRECT_JUDGE` label.
- [ ] Keep existing Staff rapid-score matrix behavior intact. Do not route judge requests through `round_scores_api`; share only a lower-level guarded formal fact helper after judge-specific validation.
- [ ] Run focused tests, PostgreSQL concurrency acceptance, both Pyright gates, Ruff, mypy, Django checks, and migration checks; commit as `fix: enforce m2-c authoritative score commands`.

## Task 6: Build the typed judge terminal and browser safety boundary

**Files:**

- Create: `frontend/judge_terminal.ts`
- Create: `tests/client/judge_terminal.test.mjs`
- Create: `templates/singer_contest/judge_terminal.html` if Task 4 only created a shell
- Modify: `tsconfig.client.json` only if compiler entry behavior requires it
- Create: generated `static/dist/judge_terminal.js`
- Modify: `tests/e2e/judge-flow.spec.ts`

**Interfaces:** Consumes `GET /judge/context/` and `POST /judge/score/` contracts;
produces typed state transitions `Loading → Ready → Drafted → Submitting →
Acked | Rejected`, local draft recovery, and safe ACK retry.

- [ ] Add failing client tests for strict context decoding, bounded score parsing, no unchecked array access, command ID generation, canonical retry payload, stale-context rendering, and generic error mapping.
- [ ] Add failing client tests proving drafts contain only score payload, command ID, context fingerprint, and bounded notes; assert no bearer token, student PII, QR token, query/path credential, or raw server response is written to storage.
- [ ] Implement strict TypeScript discriminated unions under the existing `strict`, `noUncheckedIndexedAccess`, and `noImplicitReturns` configuration. Keep the bearer token in memory only and clear it on terminal unload/explicit revoke.
- [ ] Implement submit/retry so a network failure retries the same command ID and canonical payload, while `STALE_CONTEXT`, `PANEL_CHANGED_MID_ROUND`, and `DUPLICATE_SCORE_FACT` become visible non-retry states.
- [ ] Render only server-provided non-sensitive labels and rubric values. Do not use `innerHTML` for server content; use text nodes or escaped template values.
- [ ] Run `npm run check:client`, `npm run test:client`, both Pyright gates, and the relevant Django HTTP tests; commit as `feat: add typed judge scoring terminal`.

## Task 7: Add school-readiness documentation and operational evidence gates

**Files:**

- Create: `docs/school-onboarding.md`
- Create: `docs/incident-response.md`
- Modify: `docs/production-readiness.md`
- Modify: `docs/postgres-backup-restore.md`
- Modify: `scripts/check_docs.ps1` only if new user-facing documentation requires an explicit link check
- Modify: `tests/test_production_compose_config.py`
- Create: `tests/test_judge_school_readiness.py`

**Interfaces:** Consumes all M2-C service/test outcomes and existing production,
backup, proxy-header, audit, export, and dependency documentation. Produces a
school onboarding checklist without selecting SSO or asserting compliance.

- [ ] Add failing documentation/contract tests for the seven data families: student/registration data, judge descriptive data, QR/grant/session digests, scores/panel snapshots, audit/IP/request metadata, private files, and backups/exports. Assert every family has owner, purpose, classification, retention input, export authority, and deletion/legal-hold owner.
- [ ] Add failing deployment tests for production `DEBUG=False`, non-placeholder secrets, explicit hosts/origins, private database assumptions, trusted forwarded-header proxy configuration, secure cookies, and no development server claim.
- [ ] Add failing operational tests for isolated backup restore target, source-volume preservation, expired session purge, non-secret doctor output, no raw credentials in manifests/exports, and paper DR evidence fields.
- [ ] Document future SSO mapping as immutable `(issuer, subject)` to an existing account/invitation. Explicitly state that email/name matching is not authority and that high-risk operations require an institution-approved MFA/re-authentication policy before school launch.
- [ ] Document retention as institution-supplied configuration, not a universal application constant. Document WAF/DDoS/TLS ownership at the approved edge and application throttles as defense-in-depth only.
- [ ] Document incident evidence: actor/source/reason/context/request ID/payload hash, redaction policy, clock synchronization, audit export, contacts, RTO/RPO, restore authority, and paper re-entry chain.
- [ ] Add Playwright/runtime and PostgreSQL acceptance prerequisites to `docs/production-readiness.md`; record unavailable Docker as an unfulfilled external gate rather than a passing result.
- [ ] Run `pwsh -NoProfile -File scripts/check_docs.ps1`, Django checks, focused school-readiness tests, and `git diff --check`; commit as `docs: define m2-c school onboarding evidence`.

## Task 8: Adversarial gates, two implementation reviews, and completion rehearsal

**Files:**

- Modify: `tests/e2e/judge-flow.spec.ts`
- Modify: `singer_contest/test_judge_authority.py`, `singer_contest/test_judge_http.py`
- Modify: `common/test_authority_matrix.py`
- Modify: `.github/workflows/integration.yml`
- Modify: `README.md` only for verified commands or entry points
- Modify: `docs/production-readiness.md`

**Interfaces:** Consumes all M2-C implementation contracts and the repository
gates in `AGENTS.md`. Produces CI coverage and a production-rehearsal record.

- [ ] Add bounded localhost-only malicious tests for QR replay, expired/revoked/cross-activity/cross-round tokens, generic session without seat binding, judge-to-staff/scanner/ticket escalation, client ID tampering, stale-page submission, panel HOLD race, duplicate command replay, malformed/oversized JSON, rate limits, CSRF/origin, response leakage, and direct ORM/queryset bypasses.
- [ ] Add Playwright coverage for staff preparation → seat grant → generic redemption → judge context → current performance score → ACK retry → next performance → stale context rejection → paper/proxy recovery. Assert no token appears in URL, page source, trace, screenshot, console, audit, or response error.
- [ ] Add CI jobs/gates without removing existing ones: Django tests, migration checks, Ruff, mypy, project Pyright, entry-access Pyright, client compile/test, CSS, docs, PostgreSQL acceptance, Playwright, and non-destructive backup/restore rehearsal.
- [ ] Run the local gate sequence exactly as required by `AGENTS.md`, including `uv sync --locked --extra dev`, all Django checks, both Pyright gates, client/CSS/docs gates, PostgreSQL acceptance with `-StartCompose -VerifyResetSafety`, `npm run test:e2e`, and backup/restore. If Docker is unavailable, record the exact failure and do not claim the gate passed.
- [ ] Perform authority review round one against every numbered spec invariant: trace each HTTP input to service validation and locked write; inspect all `save`, `update`, `bulk_update`, `bulk_create`, `_base_manager`, relation assignment, admin, cleanup, import, and correction paths; verify no client-controlled authority field survives validation.
- [ ] Perform authority review round two adversarially: replay and race every token/command, change panel/live context during submission, cross activity/round/seat/judge/performance, inspect audit/export/backup/trace sinks, and confirm formal/test separation. Fix every finding in a separate small commit and rerun affected gates.
- [ ] Perform school-layer review: confirm data inventory/classification, retention ownership, SSO-neutral identity mapping, MFA/re-auth plan, proxy/header trust, private DB, edge WAF/DDoS/TLS ownership, backup/restore, incident evidence, dependency inventory, and paper DR. Mark external prerequisites as residual deployment requirements rather than code-complete claims.
- [ ] Update `docs/production-readiness.md` with actual command results, migrations, residual Docker/edge/SSO/MFA prerequisites, and the two review outcomes. Commit as `test: close m2-c authority and readiness gates`.

## Task 9: Verify, merge, push, and preserve the handoff

**Files:** no new source files; Git state and verification artifacts only.

- [ ] Confirm the feature branch is clean, `git diff --check` passes, migrations are present, and every Task 8 gate has fresh output.
- [ ] Push `feat/m2-c-judge-authority`. If the normal push times out, retry exactly with `git -c http.proxy=http://127.0.0.1:12334 -c https.proxy=http://127.0.0.1:12334 push origin feat/m2-c-judge-authority`.
- [ ] Switch to `main`, run `git pull --ff-only origin main`, merge with `git merge --no-ff feat/m2-c-judge-authority`, and do not mix unrelated changes.
- [ ] Push `main`; on timeout retry through `127.0.0.1:12334`, then verify `origin/main` contains the merge commit and the working tree is clean.
- [ ] Retain the feature branch until remote verification is complete. Report the merge commit, gate results, migrations, review findings, and residual school/deployment prerequisites before deleting it.

## Completion Criteria

- Direct judge authority requires a live seat, immutable panel snapshot, valid bound JudgeSession, open live performance context, valid rubric payload, and a successful idempotent command; no client-selected authority field is trusted.
- Prepared `RoundJudge`/`RoundEntry` facts remain immutable; panel changes are HOLD-only by default and any future versioned replacement creates immutable snapshot members without mutating old facts.
- Formal score facts retain source/provenance and remain protected after lock/consumption. Direct, proxy, paper, and approved import paths use the same guarded fact service.
- Generic entry-access tokens are digest-only and never become scoring authority without a domain seat binding. Token replay, cross-scope use, expiry, revocation, stale context, and concurrency all fail closed.
- The typed client stores no credential in drafts or persistent storage, retries idempotently, and renders safe generic errors.
- School onboarding documentation defines data ownership/classification/retention inputs, SSO/MFA migration assumptions, proxy/header trust, edge protection responsibility, backup/restore, incident evidence, dependency inventory, and paper DR without claiming external compliance.
- All required Django, PostgreSQL, client, Pyright/Pylance, Playwright, docs, security, backup/restore, and two-review evidence is present; unavailable external infrastructure is explicitly recorded as unfulfilled.

## Pre-Implementation Functional Review (2026-09-08)

### Authority-layer review

**Result: conditionally approved for implementation after the conditions below.**

Passed design checks:

- Authority is separated into descriptive judge identity, preparation input,
  versioned panel membership, operational seat, transport credential, domain
  session, live performance context, and formal score fact.
- The existing post-preparation `RoundJudge` immutability is preserved by
  making snapshot members the versioned authority rows.
- The existing `ContestRound` state machine is not polluted with an undefined
  `HOLD` status; the scoring context owns HOLD and central score guards enforce
  it.
- Current performer, judge, seat, round, and panel are server-derived. Client
  expected IDs are stale-page equality checks only.
- Idempotency, duplicate fact rejection, correction provenance, source
  provenance, lock ordering, and test/formal separation are explicitly covered.
- Generic `EphemeralSession` is not accepted as direct scoring authority without
  a `JudgeSeatGrant`/`JudgeSession` binding.

Conditions that must remain implementation blockers:

1. The initial implementation must use `HOLD_ONLY` for post-preparation panel
   changes. A permissive replacement path cannot be inferred from a missing or
   malformed policy value.
2. `ScoreRecord` correction must use a separate reason-bearing service with an
   immutable before/after audit. Ordinary judge submission cannot overwrite a
   unique formal fact.
3. PostgreSQL tests must prove the lock order and race outcomes; SQLite passing
   is insufficient evidence.
4. Every ORM mutation path, including admin, `_base_manager`, bulk methods,
   conflict upserts, cleanup, import, and correction, must be covered by the
   authority matrix before merge.

### School/institution-layer review

**Result: institution-ready direction approved; school launch remains externally gated.**

Covered by the plan:

- minimal QR/session data and digest-only persistence;
- school-supplied retention and deletion/legal-hold ownership;
- SSO-neutral future `(issuer, subject)` mapping and no email-as-authority;
- high-privilege MFA/re-authentication migration requirement;
- proxy/TLS/WAF/DDoS/private-DB deployment boundary;
- backup/restore isolation, RTO/RPO, paper DR, incident evidence, and clock
  synchronization;
- dependency inventory and explicit distinction between application throttles
  and edge DDoS controls.

External prerequisites that must not be represented as code-complete:

- school data-controller/processor and incident-responsibility agreement;
- approved retention/deletion/legal-hold values;
- production identity provider and MFA policy;
- approved reverse proxy, TLS certificate, WAF/DDoS service, and header trust
  configuration;
- backup encryption custody and restore operator;
- school-approved dependency/vulnerability/SBOM process where required.

The plan therefore permits M2-C implementation and rehearsal, but not a claim
that the system is ready for institutional production until those external
prerequisites have evidence.
