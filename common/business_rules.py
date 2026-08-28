from typing import Any

from django.core.exceptions import PermissionDenied


def ensure_activity_unlocked(activity: Any) -> None:
    if activity and activity.is_locked:
        raise PermissionDenied("Activity results are locked.")


def ensure_round_unlocked(contest_round: Any) -> None:
    ensure_activity_unlocked(contest_round.activity)
    if contest_round.is_locked:
        raise PermissionDenied("Contest round results are locked.")


def ensure_vote_session_unlocked(vote_session: Any) -> None:
    ensure_activity_unlocked(vote_session.activity)
    if vote_session.is_locked:
        raise PermissionDenied("Vote session results are locked.")


def ensure_same_activity(expected_activity: Any, related_object: Any, *, label: str) -> None:
    if not related_object or getattr(related_object, "activity_id", None) != expected_activity.pk:
        raise PermissionDenied(f"{label} must belong to the selected activity.")


def ensure_participant_can_edit(registration: Any) -> None:
    """Participants may edit their own submission only while it can still change."""
    ensure_activity_unlocked(registration.activity)
    if registration.activity.phase not in {"registration_open", "reviewing"}:
        raise PermissionDenied("当前活动阶段不允许修改报名。")
