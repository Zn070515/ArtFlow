# ArtFlow realtime collaboration boundary

ArtFlow keeps PostgreSQL and the existing Django services as the only authority
for formal state. WebSocket messages are an enhancement layer for short-lived
presence and post-commit invalidation. A browser must be able to continue with
the existing HTTP page and polling flow when the realtime service or Redis is
unavailable.

The production topology keeps the existing HTTP path unchanged:

```text
Caddy
├── normal HTTP → web:8000 → Gunicorn ×3 → Django/POSTGRES
└── /ws/*       → realtime:8001 → Daphne/ASGI ─┐
                                                └→ Redis (ephemeral)
```

`web` owns migration, ruleset seeding and static collection. `realtime` waits
for PostgreSQL and runs Django checks, but never migrates, seeds or collects
static files. Redis is internal and ephemeral; it stores channel groups and
short-lived presence records only. Losing Redis cannot invalidate scores,
votes, tickets, rulesets, results or audit records.

The first socket is the staff activity workspace. It accepts only the following
client messages:

```text
heartbeat
presence.focus
presence.blur
```

It does not accept score, vote, ticket, result or lifecycle commands. Formal
mutations remain ordinary HTTP requests protected by the existing CSRF,
permission, transaction, authority and audit paths. Future accepted-patch or
invalidation notifications must be scheduled with `transaction.on_commit()`;
the event payload should carry a resource and revision so a client can refetch
the authoritative snapshot after a gap.

Staff sockets use the Django session and the existing current-staff check;
Origin validation is provided by Channels. Judge sockets use the existing
HttpOnly `artflow_judge_session` cookie and derive their round from the server
side session. No access key, bearer token or business identifier belongs in a
WebSocket query string.

Judge terminals receive only `judge.context_changed` notifications containing
the round resource and context revision. The terminal then refetches
`/judge/context/` over HTTP. A 30-second sanity poll remains active while the
socket is connected, and the existing short polling fallback resumes when it
disconnects. HOLD, resume and performance transitions therefore keep the same
HTTP authority and CAS behavior as before.

Rapid Score follows the same boundary: its HTTP `base_version` and
`command_id` CAS remains authoritative. A successful sparse save emits
`score.grid_changed` for the activity room; other editors refetch the grid and
the existing client keeps dirty cells visible as explicit conflicts. The
activity editor also exposes value-CAS PATCH primitives for title, subtitle
and description, so unrelated fields can converge without a universal field
revision table.

There is currently no Group/GroupMembership aggregate in the domain model. A
group-material room is therefore intentionally not mounted yet; mapping a
farewell `Program` to that room would weaken membership authorization and file
slot ownership.

Presence is not a database fact and is not audited. Redis records expire after a
short TTL, and browser reconnect is advisory. A presence indicator must never
become a hard edit lock: conflict correctness belongs to the server-side CAS or
domain service.
