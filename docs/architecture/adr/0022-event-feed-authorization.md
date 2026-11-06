# ADR-0022: Authorize the operational event feed

- **Status**: accepted
- **Date**: 2026-10-26

## Decision

`GET /api/activities/:id/events` and `GET /api/activities/:id/stream` require an
authenticated actor holding at least one of `studio.manage`,
`competition.manage`, or `judge.manage`. The event payloads are operational
facts: score criteria and notes, registration review notes, ballot and session
ids. They were previously readable by anyone who knew an activity id.

The feed remains an invalidation/recovery surface for the operational UIs, not
a public projection. A future public realtime feed must be a separate,
allowlisted projection rather than lowering this gate.

## Alternatives rejected

- Leaving the feed public because "events are internal ids": payloads carry
  private judging and registration text.
- Requiring a single permission (`studio.manage`): Live operators hold
  `competition.manage`/`judge.manage` and must keep SSE working.
- Filtering payloads per caller: the feed is a raw outbox; redaction belongs to
  a dedicated public projection.

## Consequences

- Anonymous `events`/`stream` requests return 401; authenticated requests with
  the wrong permission return 403.
- The Live console's EventSource continues to work because it runs in a staff
  session with the required permissions.
- Tests that read the feed must authenticate like the UI does.
