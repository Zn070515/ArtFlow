# M2-A Entry & Ephemeral Access Foundation Design

**Status:** Draft for user review
**Date:** 2026-09-07
**Baseline:** `M1-CODE-CLOSED` / `a952d1a`

## Goal

Create a narrow, auditable foundation for temporary QR-mediated access to
ArtFlow. A staff member can issue a short-lived, single-use access grant for a
bounded activity context; a holder can redeem it exactly once for a separate,
short-lived ephemeral session; staff can revoke either object. The foundation
must be usable by the future Judge and Scanner flows without becoming a
general-purpose identity or authorization platform.

## Scope

### In scope

- A new `entry_access` Django app containing `EntryPoint`, `AccessGrant`, and
  `EphemeralSession`.
- Explicit grant/session kinds for the currently planned temporary actors:
  `JUDGE`, `SCANNER`, and `OPERATIONAL`.
- Activity and optional round scope, copied into the ephemeral session at
  redemption and never widened by the client.
- Cryptographically random bearer tokens, stored only as one-way digests.
- Grant expiry, single-use redemption, session expiry, and staff/admin
  revocation.
- Atomic redemption with row locking so concurrent redemption produces at most
  one session.
- Typed audit events for issue, redeem, and revoke operations without raw
  tokens or unnecessary personal data.
- Service-layer APIs plus minimal HTTP surfaces sufficient to exercise the
  lifecycle; polished QR-center UI and Judge Terminal UX remain later work.
- Tests for authorization, scope, expiry, replay, revocation, secret handling,
  and PostgreSQL concurrency.

### Out of scope

- Ticket issuance, physical-ticket lifecycle, check-in, or audience voting
  entitlement (M2-B).
- JudgeSeat, PanelSnapshot, JudgeSession, or electronic scoring (M2-C/M2-D).
- User accounts for judges or audience members.
- Generic IAM, OAuth/OIDC, device fingerprinting, IP-based identity, or
  permanent QR credentials.
- Extending `core.QRCodeLink` with token, expiry, identity, or lifecycle fields.
- A requirement that a GET request consumes a grant.

## Design decisions

### 1. Keep the legacy QR model separate

`core.QRCodeLink` remains a durable/public link registry for existing
registration, vote, result, and profile URLs. M2-A introduces `EntryPoint` for
temporary access bootstrap. A future QR renderer may render an `EntryPoint`
and its issued grant, but neither QR image generation nor legacy links define
the authority of the grant.

`EntryPoint` has an activity, a kind, a human-readable label, an active flag,
and creation metadata. It does not hold a bearer secret. Deactivating an
entry point prevents new grants while leaving already-issued grants governed
by their own expiry/revocation state.

### 2. Model bounded temporary access, not identities

`AccessGrant` is the one-time bootstrap credential. It stores:

- its `EntryPoint`;
- the grant kind;
- the activity and optional round scope;
- a unique digest of the random raw token;
- `expires_at`, `redeemed_at`, `revoked_at`, and issuer metadata.

`EphemeralSession` is a separate bearer credential created by redemption. It
stores:

- the redeemed grant;
- the same immutable kind and copied activity/round scope;
- a unique digest of a new random session token;
- `expires_at`, `last_seen_at`, and `revoked_at`.

The raw grant token is returned once by the issue service, and the raw session
token is returned once by the redeem service. Neither is stored in a model,
AuditLog, exception message, or normal request log; each is present only in
the immediate success response that hands the credential to its intended
caller. The database contains only digests, so a database read cannot
directly recover a usable credential.

The initial scope is deliberately relational and finite: `activity` is
required and `round` is optional. M2-C can add an explicit JudgeSeat binding
after JudgeSeat exists; it must not turn `scope` into an arbitrary JSON or
polymorphic object field.

### 3. Use explicit lifecycle services

The model layer enforces invariants; domain services own transitions and
authorization:

- `issue_access_grant(entry_point, *, actor, ttl, round=None)` requires current
  active staff/admin, validates that the entry point is active and that the
  round belongs to its activity, generates the raw token, and audits issuance.
- `redeem_access_grant(raw_token, *, request_meta)` accepts only a bounded
  token format, locks the matching grant in a transaction, rejects inactive,
  expired, revoked, or already-redeemed grants, creates one session, marks the
  grant redeemed, and audits the result without the token. The returned raw
  session token is the only ongoing credential.
- `revoke_access_grant(grant, *, actor, note)` requires current staff/admin,
  locks the grant, marks it revoked, and audits the transition. It never
  restores or reopens a redeemed grant.
- `revoke_ephemeral_session(session, *, actor, note)` requires current
  staff/admin, locks the session, marks it revoked, and audits the transition.
- `authenticate_ephemeral_session(raw_token, *, expected_kind, activity,
  round=None)` resolves only an unexpired, unrevoked session with an exact
  kind/activity/round match. It does not silently widen scope or fall back to
  a user account.

All public or staff views call these services rather than mutating lifecycle
fields through the ORM. A GET bootstrap page may display a confirmation page,
but redemption is an explicit POST/service operation so browser prefetchers,
QR scanners, and link previews cannot consume a grant accidentally.

### 4. Security and authority boundaries

- Token generation uses the standard cryptographic random source with at least
  256 bits of entropy; token input has a strict maximum length before lookup.
- Token comparison is digest-based and does not expose whether a partial token
  matched. Error responses use one generic invalid/expired/revoked outcome for
  untrusted callers.
- Grant and session scope and kind are immutable after creation; only lifecycle
  timestamps/flags move through their services.
- Issuance and revocation re-read the actor through
  `require_current_staff`/`require_current_admin` immediately before the
  authoritative transaction. Anonymous redemption has no operator identity;
  request IP may be recorded in the existing audit field, while user-agent is
  not an identity signal and is not required for the contract.
- Audit records identify the grant/session and transition, never raw bearer
  material or full request payloads.
- A grant cannot be redeemed after expiry or revocation, cannot be redeemed
  twice, and cannot mint a session outside its original scope.
- The implementation must protect ordinary `.save()`, queryset `update()` /
  `delete()`, `bulk_create()`, `bulk_update()`, and `_base_manager` paths from
  manufacturing or mutating terminal access state.

## Data flow

```text
Staff/Admin
    │ issue_access_grant
    ▼
EntryPoint ──> AccessGrant (digest, scope, expiry, unused)
                                │
                         explicit POST redeem
                                ▼
                    AccessGrant (redeemed_at)
                                │
                                ▼
                 EphemeralSession (new digest, same scope)
                                │
                 authenticate / revoke / expire
                                ▼
                    bounded temporary operation
```

No existing user account is created for the temporary actor. No QR payload is
trusted as an authority until the server redeems and validates its grant.

## HTTP surface

The first implementation exposes only the smallest integration surface:

- staff-only issue and revoke endpoints for operational testing;
- a public/non-account redeem endpoint that requires an explicit POST and
  returns a short-lived session credential once;
- a session revoke endpoint for staff/admin;
- JSON error responses with stable reason codes, no raw token echo, and no
  distinction between unknown, expired, and revoked credentials to untrusted
  callers.

The endpoints do not yet render a Judge Terminal, Scanner workflow, Ticket
page, or QR-center redesign. Those consumers will bind to the service contract
after M2-A is stable.

## Compatibility and migration

M2-A adds a new app and migrations only; it does not rewrite or migrate
existing `QRCodeLink` rows. Existing registration, vote, result, and profile
QRs continue to behave as before. No existing user, activity, vote, or score
authority is changed.

The feature is capability-gated as `EXPERIMENTAL` until a later M2 rehearsal
proves a real scanner/judge flow. Unsupported kinds must fail closed rather
than being guessed from a URL.

## Testing strategy

### Unit and service tests

- issue requires active staff/admin and active `EntryPoint`;
- invalid activity/round scope is rejected;
- raw secrets are never persisted or included in audit text;
- expiry, revoke, replay, malformed token, and wrong kind/scope all fail
  closed;
- grant/session lifecycle fields cannot be changed through ordinary model,
  queryset, bulk, base-manager, or admin paths;
- revoking a redeemed grant does not resurrect its session;
- session authentication enforces exact kind/activity/round scope;
- actor identity is re-read and audit operators are correct.

### Integration and concurrency tests

- explicit POST redemption succeeds once and never on a GET;
- concurrent PostgreSQL redemption creates exactly one session and one
  successful audit transition;
- revocation racing with redemption produces a deterministic safe outcome;
- HTTP responses do not distinguish secret-state details or leak tokens;
- existing `QRCodeLink` and current public/staff routes remain unchanged.

The implementation must run the normal Django checks, migrations check, full
test suite, client/CSS gates, and Docker PostgreSQL test suite before merge.

## Acceptance criteria

M2-A is complete when:

1. The three models and migrations exist in a focused app with explicit
   lifecycle constraints.
2. The service layer is the only supported path for issuing, redeeming, and
   revoking temporary access.
3. A grant is high-entropy, single-use, expiring, revocable, scope-bound, and
   never logged in raw form.
4. A redeemed session is a separate short-lived credential with exact scope
   enforcement.
5. Concurrent redemption cannot create duplicate sessions.
6. The minimal HTTP contract is covered by negative and positive tests.
7. Existing M1 behavior remains green and `M1-CODE-CLOSED` semantics are not
   weakened.
