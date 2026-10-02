from __future__ import annotations

from core.models import Activity


def formal_singer_contest_requires_ticket(activity: Activity) -> bool:
    return (
        activity.activity_type == Activity.Type.SINGER_CONTEST
        and activity.data_lifecycle == Activity.DataLifecycle.FORMAL
    )
