from __future__ import annotations

from enum import StrEnum
from typing import Any

from django.core.exceptions import PermissionDenied


class ActivityAction(StrEnum):
    SUBMIT_REGISTRATION = "submit_registration"
    REVIEW_REGISTRATION = "review_registration"
    UPLOAD_MATERIAL = "upload_material"
    SCORE = "score"
    MANAGE_VOTE = "manage_vote"
    MANAGE_AWARD = "manage_award"
    PUBLISH_RESULT = "publish_result"
    ARCHIVE = "archive"


# phase -> actions allowed in that phase. The set is intentionally a single
# source of truth so views never need to sprinkle `if activity.phase == ...`.
#
# Bugs this closes:
#   * DRAFT no longer allows scoring.
#   * RESULTS_PUBLISHED no longer allows changing registration/review state.
#   * ARCHIVED is read-only (no upload/material/review/score/submit).
_PHASE_ACTIONS: dict[str, frozenset[ActivityAction]] = {
    "draft": frozenset(
        {
            ActivityAction.UPLOAD_MATERIAL,
            ActivityAction.REVIEW_REGISTRATION,
            ActivityAction.MANAGE_VOTE,
            ActivityAction.MANAGE_AWARD,
        }
    ),
    "testing": frozenset(
        {
            ActivityAction.UPLOAD_MATERIAL,
            ActivityAction.REVIEW_REGISTRATION,
            ActivityAction.SCORE,
            ActivityAction.MANAGE_VOTE,
            ActivityAction.MANAGE_AWARD,
        }
    ),
    "registration_open": frozenset(
        {
            ActivityAction.SUBMIT_REGISTRATION,
            ActivityAction.REVIEW_REGISTRATION,
            ActivityAction.UPLOAD_MATERIAL,
            ActivityAction.SCORE,
            ActivityAction.MANAGE_VOTE,
        }
    ),
    "registration_closed": frozenset(
        {
            ActivityAction.REVIEW_REGISTRATION,
            ActivityAction.UPLOAD_MATERIAL,
            ActivityAction.SCORE,
            ActivityAction.MANAGE_VOTE,
        }
    ),
    "reviewing": frozenset(
        {
            ActivityAction.REVIEW_REGISTRATION,
            ActivityAction.UPLOAD_MATERIAL,
        }
    ),
    "rehearsal": frozenset(
        {
            ActivityAction.UPLOAD_MATERIAL,
            ActivityAction.SCORE,
            ActivityAction.MANAGE_VOTE,
        }
    ),
    "live": frozenset(
        {
            ActivityAction.SCORE,
            ActivityAction.MANAGE_VOTE,
            ActivityAction.MANAGE_AWARD,
        }
    ),
    "results_pending": frozenset(
        {
            ActivityAction.SCORE,
            ActivityAction.MANAGE_VOTE,
            ActivityAction.MANAGE_AWARD,
            ActivityAction.ARCHIVE,
        }
    ),
    "results_published": frozenset(
        {
            ActivityAction.MANAGE_AWARD,
            ActivityAction.ARCHIVE,
        }
    ),
    "archived": frozenset({ActivityAction.ARCHIVE}),
}


def allowed_actions(activity: Any) -> frozenset[ActivityAction]:
    return _PHASE_ACTIONS.get(activity.phase, frozenset())


def ensure_activity_action_allowed(activity: Any, action: ActivityAction) -> None:
    if action not in allowed_actions(activity):
        raise PermissionDenied(
            f"Activity phase '{activity.get_phase_display()}' does not allow this action."
        )
