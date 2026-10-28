# M15 Operations Analytics Design

## Intent

ArtFlow-Plus currently has authoritative facts for registration, materials,
competition, voting, publishing, and archive, but Ops has no single activity
view that answers “what is ready, what is blocked, and where is the remaining
work?”. This slice adds a read-only aggregate view. It is an operational
projection, not a new lifecycle and not a replacement for any capability's
authority.

## Scope

The API exposes:

```text
GET /api/activities/:id/operations/analytics
```

The response contains:

- activity identity and current status;
- registration totals and status counts;
- material-check totals and status counts, including required-not-approved;
- roster state and approved count;
- competition round, performance, current-score, and locked-count summaries;
- voting session status counts and valid ballot count;
- stage-result and result-release status counts;
- archive version/current-package counts;
- deterministic attention items with stable codes and severities.

No participant answer, review note, judge note, token, storage key, credential,
or row identifier is returned.

## Authority and counting rules

1. The repository reads existing authoritative tables only. No analytics table
   or denormalized writable state is added.
2. Valid ballots use the same predicate as closed vote tallying: a ballot is
   counted unless it names a ticket that is not in `redeemed` state. Raw
   `ballot` count is never presented as the valid count.
3. `attention` is advisory. It never gates a command, changes lifecycle, or
   substitutes for the capability resolver/closure/archive rules.
4. `required_not_approved` means a required `material_check` whose status is
   not `approved`. A material row without a corresponding check is not
   silently treated as complete.
5. The archive attention item is emitted only for a closed activity with no
   current archive package. Draft/active activities are not incorrectly told
   that archival is required.
6. Formal open vote sessions and unlocked competition rounds are reported as
   operational attention items, but only their existing services may close or
   lock them.

## Read access

The route uses a dedicated `analytics` read surface. It accepts the existing
operations permissions (`studio.manage`, `competition.manage`, `judge.manage`,
`registration.*`, `materials.*`, `grouping.manage`, `voting.manage`,
`result.manage`, `archive.manage`, and `ticket.manage`) without widening the
existing event-feed `operations` surface. The response is aggregate-only, so a
registration reviewer does not gain access to score notes or event payloads.

## UI

Ops activity detail shows an “运营分析” card beside the existing registration,
roster, grouping, and voting cards. It has:

- compact aggregate cards;
- stable attention labels;
- a clear empty state when the activity does not enable a capability;
- no mutation buttons and no private row-level data.

Realtime is not required. TanStack Query invalidation from existing Ops actions
is sufficient; a future realtime topic may invalidate this projection without
making the socket authoritative.

## Deferred capabilities exposed by the comparison

This slice deliberately does not pretend to implement check-in, offline scan,
tasks, schedules, resource booking, incident management, or feedback. Those
need their own capability definitions, authoritative commands, audit contracts,
and participant/staff privacy boundaries. The comparative report ranks them for
the next implementation stages.

## Verification

- standard-library analyzer unit tests;
- PostgreSQL repository aggregate tests;
- runtime permission/attention tests;
- API authorization and response-shape tests;
- web component tests and Plus typecheck;
- Plus test suite with `REQUIRE_DB=1`;
- structural gates and documentation check;
- disposable Docker route smoke only when needed.
