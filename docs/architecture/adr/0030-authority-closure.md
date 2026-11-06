# ADR-0030: Authority closure for scope, result provenance, and the read plane

- Status: accepted
- Date: 2026-10-27
- Supersedes: none; tightens ADR-0011, ADR-0014, ADR-0017, ADR-0022

## Context

The M7–M13 audit found four authority gaps that were closed before cutover:

1. A release froze **which scopes exist**, not **which command may run in which
   scope**. A voting command could borrow a still-running `judging` session after
   its own `voting` session closed.
2. `stage_result` recorded a revision and fingerprint but not the aggregate,
   definition release, or mode that produced the candidate. A v2 publishing
   session could confirm a candidate produced by v1.
3. After a result was CONFIRMED, a ticket revoke or score correction could change
   the source without the result noticing; `releaseResult` only checked
   `confirmed` and the candidate revision.
4. Several internal GET routes were anonymous or login-only (activity detail,
   executions, execution state, formal ranking, vote scores/live), letting a
   participant read facts the publish chain had not released.

## Decision

### Command → scope ownership is frozen with the release

`ExecutionPolicy.commandScopes` is composed from capability manifests
(`commandScopes`), frozen at release, and used by the runtime guard
(`requireRunningCommandSession`). A command absent from the map fails closed with
`COMMAND_SCOPE_UNDECLARED`; a declared-but-wrong scope fails with
`SCOPE_NOT_AUTHORIZED`. The guard reads the release bound to the running session,
so an in-flight session keeps its semantics after a newer release.

### A confirmed result carries its full source identity

`stage_result.source` stores `kind`, `aggregateId`, `definitionVersion`,
`releaseHash`, `mode`, `sourceRevision`, and `inputFingerprint`. Confirmation
rejects a vote session or contributing round from another release with
`SOURCE_RELEASE_MISMATCH`. Release revalidates that the source still exists and
its fingerprint is unchanged; a legacy import has no live source.

### Source movement makes the result stale

`stale_at` / `stale_reason` are part of the result. Normal corrections
(score edits, corrections, grouping correction) are refused while a CONFIRMED
result exists (`RESULT_CONSUMED`) and require an unlock. Security actions
(ticket revoke/rotate/session revoke) are allowed but atomically mark consumed
vote results stale and supersede their ACTIVE release. A stale result cannot be
released; it must be confirmed again.

### The read plane is declared at route registration

Every GET route declares `config.access` (`public`, `session`, `operations`,
`studio`, `voting`, `result`, `archive`). An undeclared route fails at boot.
The contract test hits the internal route table anonymously (401) and as a
permissionless participant (403); explicit public selectors stay anonymous.

### The browser never receives the bearer token

`POST /api/auth/login` and `/api/auth/register` set the HttpOnly cookie and return
actor, CSRF token, and expiry only. Programmatic clients use
`POST /api/auth/token`.

## Consequences

- Releases created before this ADR lack `commandScopes` and fail closed when a
  command tries to run; they must be re-released.
- Results confirmed before this ADR lack a source descriptor; they must be
  unlocked and confirmed again before release.
- A stale result disappears from the public selector because its release is
  superseded. Reconfirmation and a new release are required.
- Every new GET route must choose an access level; the SPA and CLI continue to
  use the session cookie or the bearer token endpoint.

## Verification

- Domain: composition freezes and validates the command map.
- Runtime: scope-borrowing, release-mismatch, stale-source, and consumed-result
  tests run against PostgreSQL.
- API: read-surface matrix (anonymous/participant) and the token endpoint.
- Web: business E2E runs with `reducedMotion: "reduce"`; the voting journey polls
  the public selector instead of assuming a synchronous release.
- `scripts/check_docs.ps1` and the 26 structural gates stay green.
