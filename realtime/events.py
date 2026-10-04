from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer  # type: ignore[import-untyped]
from django.db import transaction

logger = logging.getLogger(__name__)


def schedule_realtime_event(
    group: str,
    *,
    event: str,
    resource: str,
    revision: int | str | None = None,
    actor: Mapping[str, Any] | None = None,
    details: Mapping[str, Any] | None = None,
) -> None:
    """Broadcast a thin event only after the surrounding transaction commits.

    Realtime is an enhancement path. A Redis outage must be observable in logs,
    but it must never turn a successful PostgreSQL mutation into a failed HTTP
    response or roll back the authoritative transaction.
    """

    payload = {
        "type": "realtime.event",
        "event": event,
        "resource": resource,
        "revision": revision,
        "actor": dict(actor) if actor is not None else None,
    }
    if details:
        payload["details"] = dict(details)

    def publish() -> None:
        try:
            channel_layer = get_channel_layer()
            if channel_layer is None:
                return
            async_to_sync(channel_layer.group_send)(group, payload)
        except Exception:
            logger.warning(
                "Realtime event could not be published; HTTP authority remains complete.",
                extra={"group": group, "event": event, "resource": resource},
                exc_info=True,
            )

    transaction.on_commit(publish)


def schedule_activity_event(
    activity_id: int,
    *,
    event: str,
    resource: str,
    revision: int | str | None = None,
    actor: Mapping[str, Any] | None = None,
    details: Mapping[str, Any] | None = None,
) -> None:
    """Publish an event to staff currently viewing one activity workspace."""

    schedule_realtime_event(
        f"staff_activity_{activity_id}",
        event=event,
        resource=resource,
        revision=revision,
        actor=actor,
        details=details,
    )


def schedule_group_material_event(
    group_id: int,
    *,
    event: str,
    revision: int | str | None = None,
    actor: Mapping[str, Any] | None = None,
    details: Mapping[str, Any] | None = None,
) -> None:
    """Notify current group members and staff viewing one group material page."""
    schedule_realtime_event(
        f"group_material_{group_id}",
        event=event,
        resource=f"group:{group_id}:materials",
        revision=revision,
        actor=actor,
        details=details,
    )


def schedule_judge_context_event(
    round_id: int,
    *,
    revision: int,
    actor: Mapping[str, object] | None = None,
) -> None:
    """Notify connected judge terminals that their HTTP context is stale."""
    schedule_realtime_event(
        f"judge_round_{round_id}",
        event="judge.context_changed",
        resource=f"judge-context:{round_id}",
        revision=revision,
        actor=actor,
    )
