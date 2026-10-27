# ADR-0029: Live invalidation over the realtime core

- **Status**: accepted
- **Date**: 2026-10-27

## Context

M11 added `@artflow-plus/realtime` for the voting card, but the Live console still
used SSE (`/stream` + `useLiveEvents`). Two realtime transports in one repository
contradicted the "one protected core" decision.

## Decision

- Add `activity:<activityId>`: the snapshot is the activity's newest outbox id
  (`max(id)`), and the socket carries only that invalidation cursor.
- Live subscribes and refetches its authoritative state over HTTP; the socket never
  carries Live state.
- Delete the SSE route and `useLiveEvents`; keep `/events` as the recovery
  authority.
- Authorization matches the old operations reader: studio/competition/judge manage,
  or the admin role.

## Consequences

- Live updates have up to the realtime poll interval (~1s) of latency instead of
  SSE's immediate push. Acceptable for the control console.
- One socket serves every realtime surface in the app; topics remain independent.
- The outbox `(activity_id, id)` index makes the head read cheap.
