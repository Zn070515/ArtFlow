"""Shared throttling constant for read-only session heartbeats.

Polling clients (judge terminals, live-state viewers) re-authenticate on every
request. ``last_seen_at`` is forensic metadata — it feeds the admin display and
the revoke audit trail — never a business input. A read-only path may therefore
refresh it at most once per interval, and must treat a failed refresh as a no-op
rather than failing the request.
"""

from datetime import timedelta

HEARTBEAT_INTERVAL = timedelta(seconds=60)
