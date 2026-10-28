# ADR-0035: 通过一次性 fragment Claim 认领导入的参与者身份

- Status: accepted
- Date: 2026-10-28
- Related: ADR-0031, ADR-0032, ADR-0033

## Context

Legacy adoption keeps the imported `participant_id` authoritative, but an
imported registration may not have a v2 local account. Rewriting that ID or
silently migrating a password would change the historical identity and weaken
the cutover audit trail.

## Decision

1. Staff with registration review/management permission may issue a one-time
   claim for an adopted `legacy-user:*` registration in an active activity.
   Issuing a replacement revokes any older unconsumed claim for the same
   registration. The API stores only a digest, binds the claim to the exact
   activity and registration, expires it, and consumes it under row/advisory
   locks.
2. The claim creates a new local participant account, or links an already
   authenticated participant session. Staff sessions and other non-participant
   sessions cannot consume it. Existing passwords are never migrated or
   inspected; a new account receives a new password chosen by the participant.
3. The identity map is one-to-one in both directions: one legacy participant
   maps to one actor and one actor cannot claim multiple legacy identities.
   Registration and material authorization resolves the actor plus its linked
   legacy subject, while the imported participant ID remains the authoritative
   registration value.
4. Staff normally deliver the opaque credential in a URL fragment
   (`/claim#...`), with a manual token field available when the fragment or
   clipboard cannot be used. The browser removes the fragment from the
   address bar immediately. The raw claim token is not placed in the path,
   receipt, audit, outbox, or API JSON response; a successful new-account
   claim sets the normal HttpOnly session cookie and readable CSRF cookie.
5. The successful response includes only the non-secret activity public code
   needed to resume the participant portal. Invalid, expired, consumed, and
   malformed claims share one generic error; public consumption is rate-limited.

## Consequences

- Imported participants can sign in to the Plus portal without rewriting
  imported registration facts or requiring a password migration.
- Claim issuance and consumption remain auditable commands with replay-safe,
  redacted responses. A replay never creates a second account or session.
- A failed username choice leaves the claim unconsumed so staff can ask the
  participant to retry with another username.
- This decision does not authorize deletion of the v1 source, v1 media, or
  their read-only bridge. Removal remains a separate, verified cutover decision.

