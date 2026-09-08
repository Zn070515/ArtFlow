# M2-B Ticket / Check-in / Audience Entitlement Design

**Status:** Design revision 1 — two self-review rounds complete; pending user review
**Date:** 2026-09-08
**Scope:** M2-B only; M2-A entry grants remain unchanged.

## 1. Goal

Build the first production-shaped audience ticket boundary:

```text
Ticket lifecycle
→ Staff check-in
→ short-lived ticket access session
→ VoteSession ticket entitlement
→ one Ticket + one VoteSession ballot
```

The design must preserve the existing authority baseline, keep Ticket secrets out
of durable records, support TEST and FORMAL lifecycle separation, and be suitable
for later school deployment without pretending that application code is a WAF or
DDoS service.

## 2. Current system constraints

- `Activity` is the lifecycle and data-boundary root.
- `VoteSession` owns vote purpose, time window, OPEN/CLOSED/LOCKED state, and
  existing browser-session compatibility.
- `VoteBallot` and `VoteRecord` are raw vote facts; after a vote session is locked
  they must not be mutated through direct ORM writes.
- `entry_access` owns short-lived staff-created grants for temporary operational
  entry. It is not the Ticket domain and must not be overloaded with Ticket
  lifecycle semantics.
- Existing no-ticket voting remains supported for sessions whose frozen
  configuration does not require a Ticket.

## 3. Architecture and boundaries

Create a dedicated `tickets` Django app. Ticket lifecycle, ticket access sessions,
Staff operations, and Ticket-specific audit events belong there. `voting` consumes
the Ticket service through a narrow service interface; it does not reach into
Ticket state with raw ORM queries for authority decisions.

### 3.1 Components

| Component | Responsibility | Must not do |
| --- | --- | --- |
| `tickets.models` | Persist Ticket state and short-lived access-session state with ORM guards | Expose raw Secret or permit protected direct writes |
| `tickets.services` | Create, issue, check in, void, revoke, redeem, and authenticate Tickets | Decide rules by client-provided activity or browser identity |
| `tickets.views` | Staff JSON/forms and public body-only redeem/scan flow | Accept Secret in query/path or mutate state from a public scan |
| `voting.services` | Enforce Ticket entitlement inside ballot transaction | Treat browser session or IP as vote authority |
| `core.policies` | Central activity action/phase gate for ticket operations | Let individual views invent phase checks |
| `common.audit` / `AuditLog` | Record actor, action, target, and non-secret metadata | Record raw Ticket or session tokens |

### 3.2 No new distributed subsystem

M2-B remains a Django/PostgreSQL monolith feature. It does not introduce a
microservice, Kafka, Kubernetes, external identity provider, or browser-side
second database. External WAF, load balancing, DDoS mitigation, and school SSO/MFA
remain deployment/institutional work outside this feature.

## 4. Data model

### 4.1 Ticket

`tickets.Ticket` contains:

- `activity` foreign key;
- optional non-personal `batch_reference` and `serial_number` for physical inventory;
- `secret_digest`, unique and indexed;
- `state` with `CREATED`, `ISSUED`, `CHECKED_IN`, `VOID`, `REVOKED`;
- `issued_at`, `issued_by`;
- `checked_in_at`, `checked_in_by`;
- `revoked_at`, `revoked_by`;
- `voided_at`, `voided_by`;
- `is_test_data`, derived from the Activity lifecycle;
- timestamps.

When both inventory fields are present, `(activity, batch_reference,
serial_number)` is unique. Batch metadata is never a person identifier and never
grants authority.

The Ticket contains no student name, phone number, email, class, or other
personal identity field. Inventory metadata must not be used as authority.

The database must protect Ticket references held by vote facts (`PROTECT` rather
than cascade). Formal Tickets are never deleted. Test Ticket deletion is allowed
only through explicit test-data cleanup, only when the activity and dependent
facts satisfy the existing cleanup contract.

Batch issuance is a service convenience that returns individual QR payloads and
applies the same audited transition to every Ticket. Batch metadata cannot change
an individual Ticket state without going through that transition.

### 4.2 TicketAccessSession

`tickets.TicketAccessSession` is an ephemeral bearer session created after a
successful public redeem:

- `ticket` foreign key with `PROTECT` deletion behavior;
- `token_digest`, unique and indexed;
- `expires_at`;
- optional `revoked_at`;
- created/last-seen timestamps;
- `is_test_data` derived from the Ticket Activity.

The raw access-session token is emitted only as an HttpOnly cookie and is never
stored in the database, audit records, application logs, URLs, HTML response
body, or test artifacts. Production cookies must be `Secure`, `HttpOnly`, and
`SameSite=Lax` or stricter. The session is not authority: every vote request
revalidates the referenced Ticket and VoteSession.

The default access-session lifetime is 30 minutes. It must not silently become a
long-lived Ticket credential; expired sessions are rejected and removed by the
normal cleanup path. Direct session deletion or revocation is not an authority
bypass; cleanup deletes only expired sessions, while explicit revocation goes
through the Ticket session service. A user may rescan the physical QR to obtain
a new short session.

### 4.3 VoteSession and VoteBallot integration

Add `VoteSession.requires_ticket`, defaulting to `False` for backward
compatibility. It is a configuration field and must be included in the existing
VoteSession configuration mutability guards. It cannot change after OPEN or
LOCKED, or after the VoteSession is bound by a Ruleset freeze. Its effective
value must be included in the Ruleset freeze/binding contract where that
VoteSession is consumed.

Add nullable `VoteBallot.ticket` with `on_delete=PROTECT`. Add a partial unique
constraint for non-null Ticket rows:

```text
UNIQUE(ticket_id, vote_session_id) WHERE ticket_id IS NOT NULL
```

Existing browser-session uniqueness remains a UX/idempotency guard. It is not a
replacement for the Ticket constraint or Ticket authority. `VoteRecord` remains
attached to its Ballot and does not need a second Ticket field.

## 5. Secret and QR contract

### 5.1 Generation and storage

- Generate Ticket secrets with `secrets.token_urlsafe(32)` or an equivalent
  256-bit cryptographically secure value.
- Persist only a SHA-256 digest of the secret.
- Return the raw Ticket secret only once to the controlled Staff issuance/QR
  printing response.
- Never provide a recovery endpoint that reconstructs a lost raw secret; void the
  lost Ticket and issue a replacement.
- Never include raw Ticket or access-session secrets in audit `target`, `note`,
  `old_value`, `new_value`, exception text, request logs, or metrics labels.

### 5.2 Public scan

The printed QR points to a scan page whose secret is carried in the URL fragment,
not the query string or path. The page immediately removes the fragment from
history and sends the secret in a body-only `POST` to the redeem endpoint.

Public redeem:

- is deliberately CSRF-exempt because it is body-only bearer bootstrap and does
  not mutate Ticket authority;
- has a strict JSON body limit and a route-specific rate limit;
- accepts no URL token and no cookie as the source of the initial secret;
- returns a generic failure for unknown, `CREATED`, expired, void, or revoked
  Tickets;
- on success creates only a short-lived `TicketAccessSession` cookie;
- does not transition `CREATED` to `ISSUED` or `ISSUED` to `CHECKED_IN`.

The scan page is presentation/credential bootstrap, not a check-in authority.

## 6. Lifecycle and service contracts

All stateful operations run through `tickets.services` and use an atomic
transaction. The service locks the Activity and target Ticket before evaluating
state and phase policy. Views may validate syntax, but they cannot implement the
authority transition themselves.

### 6.1 Allowed transitions

```text
CREATED ──issue──→ ISSUED ──check_in──→ CHECKED_IN
   │                  │                    │
   └──void──→ VOID     ├──void──→ VOID      └──revoke──→ REVOKED
                      └──revoke──→ REVOKED
```

`VOID` and `REVOKED` are terminal. `CREATED` is not valid for public redeem,
check-in, or voting. `ISSUED` and `CHECKED_IN` are redeemable, but only
`CHECKED_IN` is vote-eligible when the target VoteSession also requires and
permits Ticket voting.

`check_in_ticket` is idempotent for an already `CHECKED_IN` Ticket and returns
the existing state. It accepts only `ISSUED` and rejects `CREATED`, `VOID`, and
`REVOKED`. `void_ticket` accepts only `CREATED` or `ISSUED` and rejects a
checked-in Ticket. `revoke_ticket` accepts `ISSUED` or `CHECKED_IN` and may
invalidate a checked-in Ticket for future operations, but never deletes or
rewrites an existing Ballot or VoteRecord.

### 6.2 Actors

- Staff may create/issue Tickets and perform ordinary check-in operations.
- Admin/Chair may void or revoke Tickets because those operations change future
  eligibility.
- Every transition records the authenticated actor and an audit event with no raw
  credential material.
- Public redeem has no authenticated operator and records only non-secret
  technical metadata required by the retention policy.

### 6.3 Activity phase policy

Add centralized `ActivityAction.MANAGE_TICKETS` and
`ActivityAction.CHECK_IN` policy entries. The default formal management window is
`REGISTRATION_OPEN`, `REGISTRATION_CLOSED`, `REHEARSAL`, or `LIVE`; the default
formal check-in window is `REGISTRATION_CLOSED`, `REHEARSAL`, or `LIVE`. Test
activities may manage and check in during `TESTING`. Ticket management and
check-in use the central policy and cannot be reimplemented in a view. If a
future event needs a different window, it must be an explicit frozen policy
change with tests, not an ad-hoc bypass.

## 7. Vote entitlement contract

`voting.services.submit_ballot` remains the only mutation path for a ballot. For
`requires_ticket=True`, it must accept the authenticated TicketAccessSession
context and, inside the same transaction as ballot creation:

1. lock and reload the Activity and VoteSession;
2. lock and reload the Ticket referenced by the access session;
3. verify Ticket Activity equals VoteSession Activity;
4. verify Ticket state is `CHECKED_IN`;
5. verify Ticket and access session are not revoked or expired;
6. verify VoteSession is OPEN and inside its server-side time window;
7. verify the selected options belong to that VoteSession and Activity;
8. create or return the idempotent Ballot while the database unique constraint
   arbitrates concurrent requests.

If any validation fails, no Ballot or VoteRecord is written. A later Ticket
revocation does not mutate a previously accepted raw vote fact; any post-vote
review is an explicit audited operational decision.

For `requires_ticket=False`, the existing browser-session compatibility path is
preserved and the resulting Ballot remains unassociated with a Ticket. A Ticket
access session supplied to such a VoteSession is ignored and never creates a
Ticket-linked Ballot. A browser session or IP never grants entitlement to a
ticket-required session.

## 8. HTTP surface

The exact URL names follow repository conventions, but the contracts are fixed:

### Staff endpoints

- issue/create Ticket or batch: authenticated Staff, CSRF protected;
- check in by scanned Secret: authenticated Staff, CSRF protected, body-only
  Secret;
- void/revoke: Admin/Chair, CSRF protected, explicit reason where required;
- operational list/reconciliation: Staff-readable, never displays raw Secret.

### Public endpoints

- scan page: no state mutation;
- redeem: body-only JSON Secret, CSRF-exempt bootstrap, rate-limited, strict
  body-size limit, HttpOnly session cookie on success;
- ticket-backed vote: existing public vote surface, using the TicketAccessSession
  and standard CSRF protection for browser POSTs.

No endpoint accepts Ticket or access-session credentials in query strings, URL
paths, referer-derived values, or client-supplied Activity IDs as authority.

## 9. Authority and ORM requirements

The implementation must add a Ticket-specific authority scope and protect every
write entry point:

- model instance `save`;
- queryset `update` and `delete`;
- `bulk_update`;
- `bulk_create`, including conflict upsert options;
- `_base_manager` mutation attempts;
- relation moves across Activities;
- direct mutation of state, actor, timestamps, digest, and lifecycle fields.
- direct mutation of `TicketAccessSession` token digest, expiry, revocation, and
  Ticket relation;
- direct deletion of `TicketAccessSession` except through expired-session
  cleanup.

Ticket and VoteBallot relation consistency must be checked both on object saves
and queryset/bulk paths. VoteSession `requires_ticket` must use the existing
configuration guard and freeze contract. Cleanup is the only exception for
eligible TEST data, and it must preserve media/database cleanup semantics.

## 10. Error, replay, and concurrency semantics

- Invalid or replayed Ticket secrets return the same public failure shape;
- rate-limited public redeem returns a generic 429 with bounded `Retry-After`;
- repeated check-in of the same Ticket is idempotent;
- simultaneous check-in requests result in one state transition;
- simultaneous ballot requests for one Ticket/VoteSession result in one Ballot,
  with the database constraint and service transaction handling the race;
- cross-Activity Ticket, VoteSession, option, and access-session combinations are
  rejected before mutation;
- lock/phase failures are explicit and audited where an authenticated actor is
  involved;
- raw credentials never appear in error messages or response bodies.

## 11. School readiness requirements

M2-B must ship with these operational contracts, even when integrations remain
outside the code change:

- a data inventory classifies Ticket digest, access-session digest, status,
  operator, and IP/audit fields;
- formal retention rules define when expired access sessions and technical
  redeem logs are purged;
- audit redaction is tested against raw Ticket and session token leakage;
- production cookie, Secret, and key settings are documented;
- sensitive export/list pages never export raw credentials;
- Staff can reconcile issued/check-in/void/revoked counts by non-personal batch
  metadata;
- paper check-in and manual vote entry remain the final DR;
- Playwright credentials are excluded from trace/video/screenshot artifacts;
- public redeem/vote request limits and alerts are documented;
- school network/WAF ownership is documented for volumetric DDoS, TLS floods,
  slow clients, connection caps, and edge rate limiting.

M2-B does not claim school SSO, final MFA, formal domain/TLS ownership, WAF
deployment, or institutional approval. Those are explicit follow-up gates.

## 12. Test and release gates

### Unit/service tests

- all lifecycle transitions and illegal transitions;
- idempotent duplicate check-in;
- revoke/void behavior before and after a Ballot exists;
- raw Secret absent from database, audit, logs, and response bodies;
- cross-Activity and forged-ID rejection;
- TEST/FORMAL isolation and cleanup;
- ORM instance/queryset/bulk/`_base_manager` authority matrix;
- VoteSession configuration freeze for `requires_ticket`;
- TicketAccessSession expiry/revocation and cookie contract;
- no-ticket backward compatibility;
- public redeem body limit, rate limit, and generic errors.

### PostgreSQL and browser tests

- PostgreSQL concurrent check-in;
- PostgreSQL concurrent one-ticket/one-session ballot creation;
- locked VoteSession and locked Ticket mutation rejection;
- QR fragment → body-only redeem → HttpOnly session → check-in → vote;
- duplicate scan, duplicate vote, expired session, revoked Ticket, and stale page;
- no bearer material in Playwright trace/video/screenshot artifacts.

### Blocking repository gates

```powershell
uv run ruff format --check .
uv run ruff check .
uv run mypy
npm run check:pyright
npm run check:pyright:entry-access
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run pytest -q
npm run check:client
npm run test:client
npm run check:css
pwsh -NoProfile -File scripts/check_docs.ps1
pwsh -NoProfile -File scripts/verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
npm run test:e2e
```

The production rehearsal must additionally retain evidence for duplicate Ticket
scans, revoked/void Tickets, repeated Ticket/VoteSession submissions, paper DR,
and external edge protection ownership.

## 13. Non-goals and explicit follow-ups

- JudgeSeat, JudgeSession, Direct Judge scoring, and `STAFF_PROXY` scoring remain
  later M2 work;
- Ticket does not become a user account or student identity record;
- `VOTED` is not added to Ticket;
- browser storage/device binding is not authority;
- the application does not implement volumetric DDoS protection;
- school SSO, final MFA, ClamAV, field-level encryption, and formal institutional
  deployment approval remain separate readiness work.
