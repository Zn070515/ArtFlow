from django.core.exceptions import PermissionDenied


def ensure_activity_unlocked(activity):
    if activity and activity.is_locked:
        raise PermissionDenied("Activity results are locked.")


def ensure_round_unlocked(contest_round):
    ensure_activity_unlocked(contest_round.activity)
    if contest_round.is_locked:
        raise PermissionDenied("Contest round results are locked.")


def ensure_vote_session_unlocked(vote_session):
    ensure_activity_unlocked(vote_session.activity)
    if vote_session.is_locked:
        raise PermissionDenied("Vote session results are locked.")
