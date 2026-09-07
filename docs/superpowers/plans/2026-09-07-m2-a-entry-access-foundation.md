# M2-A Entry & Ephemeral Access Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a narrow, auditable, single-use grant and short-lived session foundation for future Judge, Scanner, and operational QR flows.

**Spec:** `docs/superpowers/specs/2026-09-07-m2-a-entry-access-foundation-design.md`

**Execution:** Inline execution in this checkout, because the repository rule forbids worktrees and the user requested no subagents. Each task ends with its own verification and small conventional commit.

## Repository map

- `entry_access/`: new Django domain app; models, services, views, URLs, and tests for temporary access.
- `common/authority.py`: new explicit write scopes for entry-point, grant, and ephemeral-session transitions.
- `common/models.py`: typed audit action values for issue/redeem/revoke events.
- `config/settings.py`: register the app.
- `config/urls.py`: mount the app URL namespace.
- `docs/superpowers/specs/2026-09-07-m2-a-entry-access-foundation-design.md`: approved architecture boundary.
- `docs/superpowers/plans/2026-09-07-m2-a-entry-access-foundation.md`: this task plan.

## Data contract

Use relational fields only; do not add a JSON scope or add security state to
`core.QRCodeLink`.

```python
class EntryPoint(models.Model):
    class Kind(models.TextChoices):
        JUDGE = "judge", "Judge"
        SCANNER = "scanner", "Scanner"
        OPERATIONAL = "operational", "Operational"

    activity = models.ForeignKey(Activity, on_delete=models.PROTECT)
    kind = models.CharField(max_length=16, choices=Kind.choices)
    label = models.CharField(max_length=100)
    is_active = models.BooleanField(default=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

class AccessGrant(models.Model):
    entry_point = models.ForeignKey(EntryPoint, on_delete=models.PROTECT)
    kind = models.CharField(max_length=16, choices=EntryPoint.Kind.choices)
    activity = models.ForeignKey(Activity, on_delete=models.PROTECT)
    round = models.ForeignKey(ContestRound, on_delete=models.PROTECT, null=True, blank=True)
    token_digest = models.CharField(max_length=64, unique=True, editable=False)
    expires_at = models.DateTimeField()
    redeemed_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    issued_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

class EphemeralSession(models.Model):
    grant = models.OneToOneField(AccessGrant, on_delete=models.PROTECT)
    kind = models.CharField(max_length=16, choices=EntryPoint.Kind.choices)
    activity = models.ForeignKey(Activity, on_delete=models.PROTECT)
    round = models.ForeignKey(ContestRound, on_delete=models.PROTECT, null=True, blank=True)
    token_digest = models.CharField(max_length=64, unique=True, editable=False)
    expires_at = models.DateTimeField()
    last_seen_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
```

`EntryPoint` configuration and grant/session scope and kind are immutable
after creation. The three lifecycle models may be created or transition state
only inside their named authority service scopes. The service validates that
`entry_point.activity_id == activity_id`, `entry_point.kind == kind`, and any
round belongs to the activity before writing. A session copies the grant scope
and kind; it never accepts client-supplied replacement scope.

Tokens are generated with `secrets.token_urlsafe(32)`. Store
`sha256(raw_token).hexdigest()` only. The service result dataclasses carry the
raw token only to the immediate caller. No model, AuditLog, exception, or
normal log contains it.

## Task 1: Scaffold the focused app and authority vocabulary

- [ ] Create `entry_access/__init__.py`, `apps.py`, empty `models.py`,
  `services.py`, `views.py`, `urls.py`, and `tests.py` with app label
  `entry_access`.
- [ ] Register `entry_access.apps.EntryAccessConfig` in `config/settings.py`.
- [ ] Mount `path("entry-access/", include("entry_access.urls"))` in
  `config/urls.py`.
- [ ] Add `ENTRY_POINT_CONFIG`, `ACCESS_GRANT_STATE`, and
  `EPHEMERAL_SESSION_STATE` constants to `common/authority.py`.
- [ ] Add `ACCESS_GRANT_ISSUE`, `ACCESS_GRANT_REDEEM`,
  `ACCESS_GRANT_REVOKE`, and `ACCESS_SESSION_REVOKE` to
  `common.models.AuditLog.ActionType`, keeping every stored value within the
  existing 22-character field limit.
- [ ] Add an app smoke test that imports the config and verifies the URL
  namespace resolves without exposing an implementation endpoint yet.
- [ ] Run `uv run python manage.py check` and the new smoke test.
- [ ] Commit as `chore: scaffold M2-A entry access app`.

## Task 2: Define model invariants with failing tests first

- [ ] In `entry_access/tests.py`, add tests for: closed initial lifecycle
  state; activity/round/kind consistency; unique token digests; session
  one-to-one grant; direct creation of grant/session state is rejected without
  authority; ordinary save/update/delete/bulk paths cannot alter scope, kind,
  expiry, redemption, or revocation state; `_base_manager` follows the same
  guards; and an inactive entry point cannot be used by the service fixture.
- [ ] Run the focused tests and observe failures for missing models and guards.
- [ ] Implement the three models, `clean()` consistency checks, explicit
  authority checks in `save()` and custom querysets for `update()`,
  `bulk_create()`, `bulk_update()`, and `delete()`.
- [ ] Add the generated `entry_access` initial migration with indexes on
  `token_digest`, `expires_at`, and the active/revocation lookup fields.
- [ ] Run `uv run python manage.py makemigrations --check --dry-run`, the
  focused model tests, and `uv run ruff check entry_access common config`.
- [ ] Commit as `feat: add M2-A temporary access models`.

## Task 3: Implement entry-point and grant issuance

- [ ] Add failing tests for `create_entry_point` and
  `issue_access_grant`: current active staff is required; inactive staff is
  rejected; inactive entry points are rejected; round/activity mismatch is
  rejected; TTL must be positive and bounded by a fixed service maximum; the
  returned raw token has at least 256 bits of entropy; only its digest is
  persisted; and the audit operator is the re-read current actor.
- [ ] Implement `create_entry_point(activity, *, kind, label, actor)` and
  `deactivate_entry_point(entry_point, *, actor)` using current staff
  re-reads and `ENTRY_POINT_CONFIG`.
- [ ] Implement `issue_access_grant(entry_point, *, actor, ttl, round=None)`
  with a frozen result dataclass containing `grant` and `token`, using
  `secrets.token_urlsafe(32)` and SHA-256, `ACCESS_GRANT_STATE`, and a typed
  `ACCESS_GRANT_ISSUE` audit event.
- [ ] Ensure audit fields contain only object IDs, scope labels, and the
  optional request IP; never include token material.
- [ ] Run the focused issuance tests and `uv run ruff format` on changed
  Python files.
- [ ] Commit as `feat: add temporary access grant issuance`.

## Task 4: Implement atomic one-time redemption and session authentication

- [ ] Add failing tests for explicit redemption success; malformed/oversized,
  unknown, expired, revoked, and already-redeemed tokens; session token
  separation; copied scope; session TTL capped by the grant expiry; exact
  kind/activity/round authentication; and generic untrusted error reason codes.
- [ ] Add a PostgreSQL `TransactionTestCase` that concurrently redeems one
  grant and asserts exactly one `EphemeralSession`, one `redeemed_at`, and one
  successful redemption outcome.
- [ ] Implement `redeem_access_grant(raw_token, *, request_meta)` inside
  `transaction.atomic()` using the digest lookup and
  `select_for_update()`. Reject all unusable states before creating the
  session, create a separate 256-bit session token, mark the grant redeemed
  under `ACCESS_GRANT_STATE`, create the session under
  `EPHEMERAL_SESSION_STATE`, and audit without the raw token.
- [ ] Implement `authenticate_ephemeral_session(raw_token, *, expected_kind,
  activity, round=None)` with exact scope matching, expiry/revocation checks,
  and no account fallback. Update `last_seen_at` only through a narrowly
  scoped session service path.
- [ ] Run focused unit tests and PostgreSQL concurrency tests where available.
- [ ] Commit as `feat: add atomic ephemeral access redemption`.

## Task 5: Implement revocation and lifecycle audit

- [ ] Add failing tests for grant revocation before redemption, revocation
  after redemption without session resurrection, session revocation,
  idempotent repeated revocation, inactive actors, stale actor objects, and
  race-safe revoke/redeem outcomes.
- [ ] Implement `revoke_access_grant(grant, *, actor, note)` and
  `revoke_ephemeral_session(session, *, actor, note)` with current staff
  re-reads, row locks, explicit state scopes, and typed audit events.
- [ ] Make model/queryset/base-manager mutation attempts fail with stable
  validation errors and ensure no raw token enters the error text.
- [ ] Run the focused lifecycle tests, `git diff --check`, and ruff checks.
- [ ] Commit as `feat: add temporary access revocation`.

## Task 6: Add the minimal HTTP contract

- [ ] Add failing Django client tests for staff-only issue, staff-only grant
  and session revoke, explicit `POST` redemption, GET non-consumption, stable
  reason codes, no raw token echo, and no distinction between unknown,
  expired, and revoked grant errors.
- [ ] Implement JSON endpoints:
  - `POST /entry-access/grants/issue/` with `{entry_point_id, ttl_seconds,
    round_id?}`;
  - `POST /entry-access/grants/redeem/` with `{token}`;
  - `POST /entry-access/grants/<id>/revoke/` with `{note?}`;
  - `POST /entry-access/sessions/<id>/revoke/` with `{note?}`.
- [ ] Keep redemption body-only and POST-only; do not put secrets in URLs or
  GET side effects. The public redeem endpoint is bearer-token-only and does
  not use cookie authentication; document the deliberate CSRF boundary in the
  view.
- [ ] Return the raw grant/session token only in the immediate successful JSON
  response. Use stable codes such as `INVALID_ACCESS_GRANT`,
  `ACCESS_GRANT_EXPIRED`, and `ACCESS_SCOPE_MISMATCH` only where the caller is
  already trusted; untrusted grant-state failures share one generic code.
- [ ] Add URL reverse tests and preserve all existing `QRCodeLink` routes.
- [ ] Commit as `feat: expose M2-A access lifecycle endpoints`.

## Task 7: Capability documentation and full verification

- [ ] Add a concise `M2-A Entry & Ephemeral Access` section to
  `docs/production-readiness.md`, marking the feature `EXPERIMENTAL` and
  stating that it is not yet Judge Terminal, Ticket, Check-in, or audience-vote
  entitlement.
- [ ] Add admin registrations only for safe inspection; do not expose raw
  digests as editable secrets or add an admin bypass.
- [ ] Run `uv run python manage.py check`.
- [ ] Run `uv run python manage.py makemigrations --check --dry-run`.
- [ ] Run `uv run pytest -q --cov` and the client/CSS gates.
- [ ] Rebuild Docker with `docker compose -p artflow up --build --wait`, run
  the full container test suite, and verify db/web remain healthy without
  deleting volumes.
- [ ] Perform two self-review rounds: first contract/semantic coverage, then
  security/concurrency/logging/compatibility; fix findings in their own small
  commits.
- [ ] Commit the capability note/admin inspection as
  `docs: document M2-A experimental capability` if it is separate from the
  endpoint commit.
- [ ] Merge the feature branch into main with `--no-ff`, push main, verify
  remote state through the configured HTTP/1.1 proxy only if direct Git
  transport times out, then retain a clean final status.
