# Participant Account Claim and Legacy Identity Link

- **Status**: Proposed
- **Date**: 2026-10-28
- **Scope**: ArtFlow-Plus participant account claim for adopted legacy registrations

## Context

ArtFlow-Plus already supports self-registration through local cookie sessions. An
adopted v1 registration, however, keeps its authoritative participant identity as
`legacy-user:<id>` and has no Plus account. The existing participant checks are
literal actor-ID comparisons, so simply creating a local account would not grant
the participant access to the imported registration.

The claim flow must preserve imported facts and provenance. It must not rewrite
`registration.participant_id`, grouping membership, material ownership, or any
historical result references. It must also avoid importing or validating v1
password hashes.

## Decision

Use a staff-issued, one-time claim capability to link one imported legacy
participant identity to one Plus local participant actor. The capability is
scoped to a concrete adopted registration for staff verification, while the
resulting identity link is global to the legacy participant ID because the v1
user ID is the cross-activity participant identity.

The participant may either create a new Plus local account during claim or use an
already authenticated participant session. A local participant actor can link at
most one legacy identity, and a legacy identity can link at most one local actor.
The first implementation does not migrate passwords, infer identity from names or
answers, or support email/SSO verification.

## Data model

Migration `0019_participant_account_claim` adds two module-owned tables:

### `participant_identity_link`

- `legacy_participant_id` — primary key, currently restricted to the
  `legacy-user:<id>` shape;
- `actor_id` — unique Plus local participant actor ID;
- `linked_at`;
- `linked_by` — the issuing staff actor or the synthetic claim actor;
- `claim_id` — the consumed claim that established the link.

The table is an identity alias, not a replacement for imported participant IDs.
It has no cascade that can delete registrations or facts.

### `participant_claim`

- `id` — deterministic command ID for the issued grant;
- `activity_id` and `registration_id` — the verification scope;
- `legacy_participant_id`;
- `token_digest` — unique SHA-256 digest; raw token is never persisted;
- `expires_at`;
- `consumed_at` and `consumed_by_actor_id`;
- `issued_by` and `created_at`.

The database enforces uniqueness for the digest, the identity link on both sides,
and the registration/claim references. Claim consumption locks the claim and
identity link rows before revalidating expiry, registration ownership, and link
state.

## Runtime and API behavior

### Staff issuance

`POST /api/activities/:id/registrations/:registrationId/account-claim`

- requires `registration.review` or `registration.manage`;
- requires an active adopted registration whose participant ID is a legacy ID;
- refuses a registration already linked to a local actor;
- requires the existing `Idempotency-Key` header and uses it as the durable
  command ID;
- creates an opaque `AF1.CLAIM.<id>.<random>` token, stores only its digest,
  and returns the raw token exactly once in the command response;
- redacts the token from the command receipt; replaying the same command returns
  `token: null`, so issuing a replacement requires a new `Idempotency-Key`;
- writes receipt, audit, and outbox event in the same transaction;
- rate limiting and command idempotency follow existing staff command behavior.

The response includes only the public code, activity title, expiry, and claim
token. It does not include questionnaire answers or other participant PII.

### Public claim

`POST /api/public/participant-claims/consume`

The body contains the token and, when no participant session exists, a new
username/password. The token is accepted in the web URL fragment or manual input
so it does not enter browser history, referrer headers, or server access logs.
The request requires the existing `Idempotency-Key` header; a retry with the
same key replays the accepted receipt without creating a second account or link.

Add domain error code `INVALID_PARTICIPANT_CLAIM`, mapped to the same generic
client response for missing, expired, consumed, malformed, or inconsistent
claims. The error must not reveal whether a legacy identity or account exists.

The transaction:

1. resolves and locks the claim;
2. rejects missing, expired, consumed, malformed, non-legacy, already linked, or
   registration/activity-inconsistent claims with one generic
   `INVALID_PARTICIPANT_CLAIM` error;
3. uses the current participant session actor, or creates a validated local
   participant account;
4. locks and inserts the one-to-one identity link;
5. marks the claim consumed and writes audit/outbox/receipt data;
6. returns the public actor and normal Plus session cookies when a new account
   was created.

An existing local account is never selected by username during claim. It can be
used only when its authenticated session is already present. Username conflicts,
invalid passwords, and account/link uniqueness failures leave the claim
unconsumed.

### Identity-aware participant authorization

Add a runtime resolver that returns the actor's own participant ID plus any
linked legacy ID. Participant-owned read and write paths use this resolver:

- registration mine/detail reads;
- registration answer/submit;
- material metadata upload, content attach, and material reads;
- any future participant-owned capability must use the same helper.

Staff permissions continue to bypass ownership checks. The pure domain
`canActFor` function remains literal and deterministic; database-backed identity
resolution stays in runtime services rather than importing persistence into the
domain package.

## Security and lifecycle rules

- raw claim tokens appear only in the issuance response and the client fragment;
  never in database rows, audit detail, outbox payloads, logs, URLs sent to the
  server, or error messages;
- public claim endpoints are rate-limited and return indistinguishable invalid
  claim errors;
- claim creation and consumption are command-idempotent through
  `Idempotency-Key`; replays do not create a second account, link, audit entry,
  or outbox event;
- a consumed or expired claim cannot be used to bind another account;
- linking never changes imported `participant_id` values or historical authority;
- unlinking is out of scope for this slice and requires a separately audited
  administrative recovery design.

## Web surface

Add a minimal `/claim` page that accepts a fragment token or manual token input,
collects new account credentials when needed, submits the claim, then redirects
to the participant registration detail. Add a staff action beside an eligible
legacy registration to issue and copy a claim link. The UI must not render the
raw token after the issuance response is dismissed and must display expiry and
the one-time-use warning.

## Verification

The slice is complete only when the following are covered:

- migration and repository tests for both uniqueness directions and safe replay;
- runtime tests for issue, expiry, consumption, existing-session claim, new
  account claim, username conflict, registration/activity mismatch,
  already-linked identity, and concurrent double consumption;
- registration and material tests proving a linked actor can read and mutate the
  original legacy registration while an unrelated participant cannot;
- audit/outbox/receipt assertions proving one accepted claim has one durable
  record set and no raw token leakage;
- API tests for cookie creation, generic invalid errors, rate limits, and CSRF
  behavior after a session is established;
- Web unit/API tests and one browser journey covering staff issuance followed by
  participant claim and registration resume;
- Plus check plus the focused runtime/API/web tests only; no v1 full suite and no
  production cutover are part of this slice.

## Non-goals

- deleting or moving the v1 source tree;
- v1 password-hash migration;
- email verification, SSO, password reset, or account recovery;
- automatic identity matching from names, phone numbers, answers, or files;
- changing the accepted cutover rollback boundary;
- rewriting imported registrations, scores, votes, groups, or archive records.
