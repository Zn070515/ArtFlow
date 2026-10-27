# ADR-0027: One protected realtime core

- **Status**: accepted
- **Date**: 2026-10-27

## Context

v2 only had SSE (`/api/activities/:id/stream`) as an invalidation hint. The voting
card needs live ballot counts with a fallback, and future surfaces will need the
same transport. Ad-hoc sockets per feature would drift.

## Decision

- Add `@artflow-plus/realtime` with `./protocol`, `./server`, `./client`.
- The transport is notification-only: clients subscribe/unsubscribe/ping; all
  mutations stay on HTTP.
- One versioned envelope; handshake authentication and per-topic authorization.
- Updates are full snapshots with a monotonic `seq`; clients drop stale sequences.
  Backpressure drops updates instead of queueing because the next snapshot covers.
- Bounded resources: 32 subscriptions, 4 KiB frames, 1 MiB send buffer, 10
  subscribe requests/second, heartbeat on both ends.
- The server polls each subscribed topic's `snapshot()` (1s default). A future
  LISTEN/NOTIFY source replaces the snapshot provider without changing the
  protocol or client.
- Only this package imports `ws` / `@fastify/websocket`; only `src/client` and the
  package's tests construct `WebSocket`. A structural gate enforces this.

## Consequences

- Feature code registers topics and never forks connection/reconnect logic.
- Permission revocation applies on reconnect, not mid-subscription.
- Multi-instance deployments poll independently; consistent but not coalesced.
- The Live console now uses the `activity:<id>` invalidation topic; SSE has been
  retired (ADR-0029).
