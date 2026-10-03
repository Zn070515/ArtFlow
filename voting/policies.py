from __future__ import annotations

from core.models import Activity


def formal_singer_contest_requires_ticket(activity: Activity) -> bool:
    return (
        activity.activity_type == Activity.Type.SINGER_CONTEST
        and activity.data_lifecycle == Activity.DataLifecycle.FORMAL
    )


def vote_ui_state(vote_session, now):
    """Return the one public-facing state used by vote and live surfaces."""
    if vote_session.activity.is_locked:
        return "activity_locked", "活动已锁定", False
    if vote_session.is_locked:
        return "locked", "投票已锁定", False
    if not vote_session.is_open:
        return "closed", "投票未开放", False
    if now < vote_session.start_time:
        return "not_started", "投票尚未开始", False
    if now > vote_session.end_time:
        return "ended", "投票已结束", False
    return "open", "投票进行中", True
