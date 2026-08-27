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
