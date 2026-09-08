# M2-C Judge Authority / Direct Scoring / School Readiness Design

**Status:** Design draft — pending approval
**Date:** 2026-09-08
**Scope:** M2-C only; M2-A entry access and M2-B ticket/check-in contracts remain in force.

## 1. Goal

Build a production-shaped judge workflow in which a temporary on-site judge can
score only through an explicitly assigned seat and a frozen round panel, while
the system remains ready for later school deployment without hard-coding a
particular SSO provider or claiming legal/MLPS compliance.

The authority chain is:

```text
staff-confirmed judge
→ JudgeSeat
→ immutable RoundPanelSnapshot
→ one-time Judge QR
→ short-lived JudgeSession
→ server-owned current Performance
→ idempotent score command
→ formal ScoreRecord
```

`JudgeSession` is a temporary capability, not a person identity. A redeemed QR
or a valid browser session alone never authorizes a score.

## 2. Non-negotiable invariants

1. A client cannot choose its own activity, round, judge, seat, panel, or current
   performer. Those values are derived from the server-side session and live
   round context.
2. `Judge` is descriptive contest data. It is not an account, an authenticator,
   or an authority grant.
3. `JudgeSeat + RoundPanelSnapshot + active JudgeSession` is the minimum direct
   judge scoring authority.
4. A QR contains only a high-entropy one-time secret. It contains no name,
   phone number, email, student data, or durable permission.
5. `entry_access` may provide the token digest, expiry, redemption, and revoke
   transport. Its generic `EphemeralSession` is not sufficient scoring authority;
   the judge domain must bind it to a seat and panel snapshot.
6. The current `Performance` is server-owned. An expected performance supplied
   by the client is an optimistic concurrency check only, never an authority
   selector.
7. A stale page must fail closed with `STALE_CONTEXT` and must never write a
   score for the next performer.
8. Reusing the same `command_id` with the same canonical payload returns the
   original successful receipt. Reusing it with a different payload or authority
   context is an idempotency conflict.
9. Direct judge scoring, `STAFF_PROXY`, paper entry, and approved import must
   converge on the same formal score-fact service. No path may restore raw ORM
   writes after the round is locked or consumed.
10. A panel change after preparation invalidates affected sessions and places the
    scoring context in `HOLD`, unless an explicitly configured round policy
    permits the transition.
11. Test data is always explicit and cannot be promoted into formal scoring facts
    by a normal operational request.
12. Audit events may contain actor, source, reason, context, outcome, and payload
    fingerprints, but never raw tokens, QR payloads, passwords, or sensitive form
    contents.

## 3. Current system constraints

- `Activity` is the lifecycle and data-boundary root.
- `ContestRound` already owns round status, preparation, locking, score version,
  `RoundJudge`, `RoundEntry`, `Performance`, and `ScoreRecord` facts.
- `RoundJudge` and `RoundEntry` are already protected after preparation. M2-C
  must preserve that boundary. `RoundJudge` is the preparation input; a new
  immutable snapshot-member record, not a mutation of `RoundJudge`, represents a
  later approved panel version.
- `Performance` is the frozen ordered list of possible performers, but there is
  currently no server-owned live pointer for “the performer currently on stage”.
- `ScoreRecord` is the formal raw score fact and is already protected after a
  round is locked or consumed.
- `apply_scores_if_version` is the existing staff rapid-score service. It accepts
  a sparse matrix and client-supplied singer/judge cells, so it must not be
  exposed as the judge-terminal API. M2-C may reuse its lower-level guarded fact
  write only behind a new narrow judge command service.
- `entry_access` owns generic one-time grants and ephemeral sessions. The judge
  domain must add an explicit binding from a redeemed grant/session to a seat.
- The application is a Django monolith. PostgreSQL concurrency behavior is a
  required acceptance gate; SQLite is not evidence for row-lock correctness.

## 4. Authority model

### 4.1 Actors and authority objects

| Object | Meaning | Authority role | Client may choose it? |
| --- | --- | --- | --- |
| `Judge` | Activity-scoped descriptive person record | Identifies the assigned judge label | No |
| `RoundJudge` | Preparation-time membership input | Source panel fact | No |
| `RoundPanelSnapshotMember` | Immutable membership in one panel version | Versioned panel authority | No |
| `JudgeSeat` | Operational seat in one round | Direct scoring subject | No |
| `RoundPanelSnapshot` | Immutable panel version and scoring policy | Bounds all sessions and facts | No |
| `JudgeSession` | Short-lived capability bound to one seat/snapshot | Temporary authentication context | No |
| `PerformanceRunState` | Server-owned live performer and context version | Current target context | No |
| `ScoreRecord` | Formal score fact | Durable authoritative input | No |
| `STAFF_PROXY` receipt | Staff-entered fact on behalf of a seat/judge | Audited alternate source | Source is service-controlled |

### 4.2 Authority scopes

M2-C must introduce distinct explicit write scopes rather than overloading
`ENTRY_POINT_CONFIG` or `EPHEMERAL_SESSION_STATE`:

- `JUDGE_PANEL_STATE`: preparation, seat assignment, panel snapshot, HOLD, and
  declared emergency panel changes;
- `JUDGE_SESSION_STATE`: judge grant binding, session creation, expiry, and
  revocation;
- `ROUND_PERFORMANCE_STATE`: live performer advance, pause, resume, and HOLD;
- `JUDGE_SCORE_SUBMISSION`: validation and materialization of judge-originated
  score commands;
- `SCORE_FACT_WRITE`: the existing protected formal score-fact mutation path,
  usable only by an approved service.

These scopes are service-internal authority capabilities. They must not be
selectable through request parameters, admin form fields, or test shortcuts.

## 5. Proposed domain model

### 5.1 `RoundPanelSnapshot`

An immutable aggregate created when a round is prepared. It contains:

- `round` and `activity`;
- monotonically increasing `version`;
- expected judge count, minimum sufficient count, scoring method, and panel
  sufficiency policy copied from the frozen ruleset;
- a canonical roster digest and captured timestamp/operator;
- lifecycle state such as `ACTIVE`, `HOLD`, `SUPERSEDED`;
- `is_test_data` consistent with the activity.

Its immutable `RoundPanelSnapshotMember` rows copy the effective judge, seat
role/key, and source `RoundJudge` reference. The snapshot member rows are the
explicit version that binds seats, sessions, and score submissions. They are
never edited in place. A replacement snapshot is a new version and requires the
declared panel-change service; the original `RoundJudge` rows remain unchanged.

### 5.2 `JudgeSeat`

An activity- and round-scoped operational seat containing:

- `round`, `panel_snapshot`, and assigned `RoundPanelSnapshotMember`;
- stable non-personal seat key/ordinal used for the physical station;
- state `ASSIGNED`, `REVOKED`, or `HOLD`;
- assignment/revocation actor, reason, and timestamps;
- `is_test_data`.

The seat is not transferable by client action. Reassignment requires a staff
service that locks the activity and round in the existing lock order, creates an
audit event, and invalidates sessions for the old assignment.

The service must enforce uniqueness of a seat key within a panel snapshot and
must not assign one snapshot member to two active seats in the same snapshot
unless an explicit ruleset policy says that the seat is a deliberate duplicate
role.

### 5.3 `JudgeSeatGrant`

An internal one-to-one binding between an `entry_access.AccessGrant` and a
`JudgeSeat` plus its `RoundPanelSnapshot`.

It stores no raw QR secret. It ensures that redeeming a valid JUDGE grant can
resolve exactly one server-selected seat. The generic grant still owns one-time
redemption; a missing, revoked, expired, or mismatched binding fails closed.

### 5.4 `JudgeSession`

A domain row linked one-to-one to the redeemed JUDGE `EphemeralSession`, with:

- `seat`, `panel_snapshot`, activity and round context;
- expiry, last-seen, and revocation timestamps;
- session state and revocation reason;
- a non-secret session identifier for audit correlation;
- `is_test_data`.

The browser may hold the existing short-lived transport token according to the
entry-access contract, but every judge endpoint must resolve and validate the
domain `JudgeSession`. A valid generic ephemeral session without a live seat
binding cannot read judge context or write scores.

### 5.5 `PerformanceRunState`

A unique row for a round that provides the server-owned live context:

- current `Performance`, nullable only while the stage is idle;
- state `IDLE`, `PERFORMING`, `ACCEPTING_SCORE`, `HOLD`, or `CLOSED`;
- monotonically increasing `context_version`;
- advance/pause/resume actor and timestamps;
- optional reason for HOLD or correction.

Only the staff stage-control service may advance this state. Each transition
locks `Activity` then `ContestRound` then the run-state row. The judge endpoint
reads it under the same transaction used to validate a score command.

### 5.6 Formal score provenance

`ScoreRecord` remains the formal raw fact and keeps the existing round/singer/
judge uniqueness contract. M2-C must add auditable provenance sufficient to
distinguish at least:

- `DIRECT_JUDGE`;
- `STAFF_PROXY`;
- `PAPER_DR`;
- approved `IMPORT`;
- explicit `TEST` data.

The record must retain the originating seat/panel snapshot where applicable and
reference the successful command/receipt. Provenance is immutable after the
fact is accepted. A correction is a new audited command under the existing
unlock/revision policy, not an untracked overwrite.

## 6. Lifecycle and state rules

### 6.1 Preparation

1. Staff confirms the round and its judge roster.
2. The service validates expected/minimum judge counts and the frozen scoring
   policy.
3. The service creates the immutable `RoundPanelSnapshot` and `JudgeSeat` rows.
4. Only after this succeeds may the round become `PREPARED`.

Before preparation, roster and seat setup may be changed through the existing
round-setup authority. After preparation, direct ORM updates and bulk updates
are rejected.

### 6.2 Panel change

After preparation, an assignment change must:

1. lock activity and round;
2. determine whether the declared round policy permits the change;
3. otherwise set the panel/run scoring context to `HOLD` and block score writes;
4. revoke affected `JudgeSession` rows;
5. create a new immutable panel snapshot and member rows if proceeding is
   allowed; this never mutates the existing `RoundJudge` or old snapshot rows;
6. record old/new roster digests, reason, actor, and effective time.

No old session may score against a new snapshot.

`HOLD` here is an M2-C scoring-context state. It must not be represented by an
invented direct ORM mutation of `ContestRound.status`; if the existing round
state machine has no `HOLD` value, the panel snapshot and
`PerformanceRunState` are the authoritative hold records and the central score
action guard must reject writes.

### 6.3 Direct judge scoring

The judge flow is:

```text
JUDGE AccessGrant issuance
→ QR redemption
→ generic EphemeralSession validation
→ JudgeSession resolution
→ live context read
→ local Draft
→ score command
→ transactional authority/context validation
→ formal ScoreRecord
→ immutable ACK/receipt
```

The judge client may send only:

- `command_id`;
- the score payload allowed by the frozen rubric;
- optional bounded notes;
- `expected_context_version` and `expected_performance_id` as stale-page guards.

It must not send authoritative activity, round, seat, judge, singer, source, or
panel identifiers. The server derives them from the session and live state.

Required rejection codes include:

| Code | Meaning |
| --- | --- |
| `INVALID_JUDGE_SESSION` | Missing, expired, revoked, or mismatched session |
| `PANEL_CHANGED_MID_ROUND` | Session snapshot is no longer active |
| `ROUND_ON_HOLD` | Scoring is paused pending staff resolution |
| `STALE_CONTEXT` | Client page is not for the current performance/version |
| `PERFORMANCE_NOT_SCORABLE` | Live state does not accept scores |
| `DUPLICATE_SCORE_FACT` | This seat/judge already has a formal fact for the performance |
| `IDEMPOTENCY_CONFLICT` | Same command ID was reused with different content/context |
| `SCORE_WINDOW_CLOSED` | Round or activity action is no longer open |

No rejection may partially create a formal score fact.

Posting a second score for the same seat/performance is not a silent overwrite.
If a pre-lock correction is required, it must use a separate, reason-bearing
correction service with a new command ID and an immutable before/after
audit/provenance record. The service may update the still-mutable formal fact
under the existing score-fact authority, or use a future revision table, but the
normal judge command remains single-acceptance and idempotent.

### 6.4 Local Draft and ACK

The browser draft is a usability aid, not an authority or an offline final
record. It must contain only the minimum score data and a command ID. It must
not store QR secrets, session tokens, student PII, or arbitrary server payloads.

An ACK is authoritative only after the server has persisted the formal fact. A
network retry with the same command and canonical payload returns the original
receipt. A draft from a superseded context must be retained only as an
unsent/rejected local item and must not be silently remapped to another
performer.

## 7. `STAFF_PROXY` and paper DR

`STAFF_PROXY` is a normal audited score source with stricter operator checks,
not a bypass. The service must require:

- authenticated staff operator;
- selected server-side seat/judge context;
- bounded reason;
- original paper/external record reference when applicable;
- the same round, panel, live-context, rubric, lock, and idempotency checks as
  direct scoring.

Paper DR is the final fallback when the judge terminal or network is unavailable.
Paper entry must preserve the original paper reference and entry operator. It
must never be silently labeled as direct judge input. The rehearsal must test
duplicate paper entry, late entry, wrong-round entry, and post-lock entry.

## 8. School integration readiness

M2-C prepares an integration contract; it does not select a school identity
provider or claim regulatory certification.

### 8.1 Identity and roles

- Staff/admin accounts remain the only durable operator identities.
- Judge identity remains temporary and event-scoped.
- Future SSO must map an external immutable `(issuer, subject)` to an existing
  account or explicit invitation; email/name matching cannot grant authority.
- High-risk operations (panel change, unlock, export, restore, retention purge)
  require a documented MFA/re-authentication policy before institutional launch.
- No SSO-specific columns or provider assumptions belong in `Judge` or
  `JudgeSeat`.

### 8.2 Data inventory and retention

Before school onboarding, document owner, classification, purpose, retention,
export authority, and deletion/legal-hold behavior for:

| Data family | Minimum treatment |
| --- | --- |
| Student/registration data | Minimize in judge views and exports |
| Judge descriptive data | Event-scoped; no QR/secret in the record |
| QR/grant/session material | Digest only at rest; short expiry; auditable revoke |
| Scores and panel snapshots | Formal operational records; protected after lock |
| Audit/IP/request metadata | Redacted, time-synchronized, retention-controlled |
| Uploaded files | Private access path, download audit, retention policy |
| Backups and exports | Encrypted custody, access log, restore evidence |

Retention values must be supplied by the institution’s policy and configured
explicitly. The application must not invent a universal school retention period.

### 8.3 Deployment and network contract

Production must run behind the institution-approved edge/proxy with TLS and
rate limiting/WAF/DDoS controls. The database and internal services remain
private. Forwarded headers are trusted only from the configured proxy, which
must overwrite them; direct public access to the Django process is not a valid
deployment.

Application-level limits remain necessary for expensive endpoints, QR redeem,
session bootstrap, and score commands, but they are not a substitute for edge
DDoS protection.

### 8.4 Operations and continuity

The onboarding evidence package must define:

- backup owner, encryption/custody, and restore test frequency;
- RTO/RPO and the person authorized to restore;
- paper DR and re-entry procedure;
- incident contacts and audit export procedure;
- clock synchronization and log retention;
- separation of development/demo data from school production data.

The PostgreSQL backup/restore rehearsal must restore only into an isolated target
and must never reset or drop the source database or volumes.

### 8.5 Supply chain and dependencies

Maintain pinned Python/Node dependencies, container image provenance, update
ownership, and a dependency inventory. Production acceptance must include the
locked client/type gates, Playwright browser smoke, PostgreSQL tests, and the
existing security checks. Vulnerability scanning/SBOM integration may be added
as an institutional deployment gate without changing judge authority semantics.

## 9. Threat and abuse cases

M2-C tests must cover at least:

- QR replay, expired QR, revoked QR, cross-activity QR, cross-round QR;
- valid JUDGE session attempting staff, scanner, ticket, or another seat actions;
- client tampering with activity/round/seat/judge/singer/panel identifiers;
- stale judge page submitted after performance advance;
- panel replacement while a judge session remains open;
- duplicate command retry and same-command different-payload replay;
- concurrent submissions from two browser tabs for one seat/performance;
- concurrent last-seat/minimum-panel transitions on PostgreSQL;
- `STAFF_PROXY` without reason, wrong seat, wrong source, or forged original
  judge;
- paper entry after lock, duplicate paper reference, and test-data promotion;
- oversized/malformed JSON, rate-limit exhaustion, CSRF/cookie/origin boundary;
- response leakage of token, PII, internal exception, or cross-activity data;
- direct ORM, `update`, `bulk_update`, `bulk_create`, and admin attempts to
  mutate protected panel/session/score state.

The stress rehearsal must remain bounded and localhost-only. DDoS claims are
not inferred from a local application test.

## 10. Acceptance gates

Before M2-C can enter production rehearsal:

1. Django checks and migration checks pass.
2. Full Django tests plus focused authority matrix pass.
3. PostgreSQL tests prove lock order, idempotency, panel invalidation, and
   concurrent score submission behavior.
4. `npm run check:pyright` and
   `npm run check:pyright:entry-access` report zero diagnostics.
5. Client build/test and Playwright judge-flow smoke pass.
6. Direct judge, `STAFF_PROXY`, paper DR, and rejected stale-context paths have
   regression tests.
7. No raw secret/token appears in database rows, audit records, logs, URLs,
   HTML, JSON error bodies, or test artifacts.
8. Two independent authority/security review rounds find no unresolved contract
   violation, semantic contradiction, or unsafe direct write path.
9. School-readiness documentation includes data inventory, retention ownership,
   deployment trust boundary, backup/restore evidence, incident contact, and
   SSO/MFA migration assumptions.

## 11. Explicit non-goals

- No SSO vendor integration in M2-C.
- No claim that ArtFlow itself supplies WAF, DDoS mitigation, TLS termination,
  or institutional compliance certification.
- No offline final scoring authority; local drafts are retryable user-interface
  state only.
- No direct ORM escape hatch for administrators, tests, imports, or scripts.
- No replacement of the existing M2-A generic entry-access contract or M2-B
  ticket entitlement contract.
- No broad refactor of all scoring workflows before the narrow judge boundary,
  tests, and migration path are proven.

## 12. Implementation order after approval

1. Add authority scopes and immutable panel-member, seat, and live-context
   services.
2. Bind JUDGE grants to seats and create domain JudgeSessions.
3. Add the server-owned judge context endpoint and narrow score command service.
4. Add provenance/receipt support and `STAFF_PROXY`/paper DR paths.
5. Add TypeScript client draft/ACK handling and Playwright coverage.
6. Add PostgreSQL concurrency, malicious input, and authority-matrix tests.
7. Update production-readiness, school onboarding, backup/restore, and incident
   documentation.
8. Run two review rounds, then perform M2-C production rehearsal.
