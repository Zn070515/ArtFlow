# Realtime core — protected contract

This package owns the only WebSocket implementation in the repository.

## Non-negotiable

1. Notification-only: clients may send `subscribe`, `unsubscribe`, `ping`. No business
   commands travel over the socket.
2. Handshake authentication and per-topic authorization. Never trust activity or
   permission fields from the client.
3. Snapshot first, then full snapshots only. `seq` is monotonic per topic; clients drop
   `seq <= last`.
4. Bounded connections: max 32 subscriptions, 4 KiB client frames, 1 MiB send buffer,
   10 subscribe requests per second. Under backpressure, drop updates; never queue.
5. Heartbeat liveness on both ends.
6. Versioned envelope; incompatible changes bump `PROTOCOL_VERSION`.
7. Only this package imports `ws` / `@fastify/websocket`; only `src/client` and this
   package's own tests construct `WebSocket`.
8. This package never imports `@artflow-plus/domain`, `@artflow-plus/db`, or
   `@artflow-plus/runtime`.

## Changing the core

- Any change to the rules above requires an ADR and a matching contract test update.
- Feature work registers `RealtimeTopic` definitions; it must not fork the connection,
  reconnect, heartbeat, or envelope code.
- `tests/gates/test_plus_realtime_core.py` enforces the import boundaries.
