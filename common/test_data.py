from __future__ import annotations

import json
from typing import Any

from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.db.models import Q

from .models import AuditLog


def lock_activity_for_runtime_data(activity: Any) -> Any:
    from core.models import Activity

    return Activity.objects.select_for_update().get(pk=activity.pk)


def get_test_data_counts(activity: Any) -> dict[str, int]:
    from farewell_show.models import Program
    from files.models import SubmissionFile
    from incidents.models import IncidentRecord
    from singer_contest.models import Award, ScoreRecord, ScoreSummary, SingerRegistration
    from voting.models import VoteBallot, VoteOption, VoteRecord, VoteSession

    return {
        "singer_registrations": SingerRegistration.objects.filter(
            activity=activity, is_test_data=True
        ).count(),
        "programs": Program.objects.filter(activity=activity, is_test_data=True).count(),
        "vote_sessions": VoteSession.objects.filter(activity=activity, is_test_data=True).count(),
        "vote_options": VoteOption.objects.filter(
            vote_session__activity=activity,
            vote_session__is_test_data=True,
            is_test_data=True,
        ).count(),
        "vote_records": VoteRecord.objects.filter(
            vote_session__activity=activity,
            vote_session__is_test_data=True,
            is_test_data=True,
        ).count(),
        "vote_ballots": VoteBallot.objects.filter(
            vote_session__activity=activity,
            vote_session__is_test_data=True,
            is_test_data=True,
        ).count(),
        "scores": ScoreRecord.objects.filter(round__activity=activity, is_test_data=True).count(),
        "score_summaries": ScoreSummary.objects.filter(
            round__activity=activity, is_test_data=True
        ).count(),
        "awards": Award.objects.filter(activity=activity, is_test_data=True).count(),
        "incidents": IncidentRecord.objects.filter(activity=activity, is_test=True).count(),
        "files": SubmissionFile.objects.filter(is_test_data=True).filter(
            Q(singer_registration__activity=activity) | Q(program__activity=activity)
        ).count(),
    }


def _reject_mixed_marker_dependencies(activity: Any) -> None:
    from files.models import SubmissionFile
    from voting.models import VoteBallot, VoteOption, VoteRecord, VoteSession

    test_vote_sessions = VoteSession.objects.filter(activity=activity, is_test_data=True)
    if (
        VoteOption.objects.filter(
            vote_session__in=test_vote_sessions, is_test_data=False
        ).exists()
        or VoteBallot.objects.filter(
            vote_session__in=test_vote_sessions, is_test_data=False
        ).exists()
        or VoteRecord.objects.filter(
            vote_session__in=test_vote_sessions, is_test_data=False
        ).exists()
    ):
        raise PermissionDenied("Test vote sessions with formal dependents cannot be cleared.")

    test_singer_vote_options = VoteOption.objects.filter(
        singer__activity=activity,
        singer__is_test_data=True,
    )
    if (
        test_singer_vote_options.filter(is_test_data=False).exists()
        or VoteRecord.objects.filter(
            vote_option__in=test_singer_vote_options,
            is_test_data=False,
        ).exists()
    ):
        raise PermissionDenied("Test singers with formal vote dependents cannot be cleared.")

    if SubmissionFile.objects.filter(is_test_data=False).filter(
        Q(singer_registration__activity=activity, singer_registration__is_test_data=True)
        | Q(program__activity=activity, program__is_test_data=True)
    ).exists():
        raise PermissionDenied("Test owners with formal files cannot be cleared.")


@transaction.atomic
def clear_activity_test_data(activity: Any, *, operator: Any) -> dict[str, int]:
    from farewell_show.models import Program
    from files.models import SubmissionFile
    from files.services import delete_submission_file
    from incidents.models import IncidentRecord
    from singer_contest.models import Award, ScoreRecord, ScoreSummary, SingerRegistration
    from voting.models import VoteBallot, VoteOption, VoteRecord, VoteSession

    locked_activity = lock_activity_for_runtime_data(activity)
    if not locked_activity.is_test_mode:
        raise PermissionDenied("Test data can only be cleared while the activity is in test mode.")
    _reject_mixed_marker_dependencies(locked_activity)
    counts = get_test_data_counts(locked_activity)
    files = SubmissionFile.objects.filter(is_test_data=True).filter(
        Q(singer_registration__activity=locked_activity)
        | Q(program__activity=locked_activity)
    )
    for submission_file in files:
        delete_submission_file(submission_file)
    Award.objects.filter(activity=locked_activity, is_test_data=True).delete()
    ScoreRecord.objects.filter(round__activity=locked_activity, is_test_data=True).delete()
    ScoreSummary.objects.filter(round__activity=locked_activity, is_test_data=True).delete()
    VoteRecord.objects.filter(
        vote_session__activity=locked_activity,
        vote_session__is_test_data=True,
        is_test_data=True,
    ).delete()
    VoteBallot.objects.filter(
        vote_session__activity=locked_activity,
        vote_session__is_test_data=True,
        is_test_data=True,
    ).delete()
    VoteOption.objects.filter(
        vote_session__activity=locked_activity,
        vote_session__is_test_data=True,
        is_test_data=True,
    ).delete()
    VoteSession.objects.filter(activity=locked_activity, is_test_data=True).delete()
    Program.objects.filter(activity=locked_activity, is_test_data=True).delete()
    SingerRegistration.objects.filter(activity=locked_activity, is_test_data=True).delete()
    IncidentRecord.objects.filter(activity=locked_activity, is_test=True).delete()
    AuditLog.objects.create(
        operator=operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"Activity:{locked_activity.pk}",
        note=f"clear_test_data={json.dumps(counts, ensure_ascii=False, sort_keys=True)}",
    )
    return counts


@transaction.atomic
def leave_test_mode(
    activity: Any, *, operator: Any, clear: bool = False, reason: str = ""
) -> dict[str, int]:
    from core.models import Activity

    locked_activity = lock_activity_for_runtime_data(activity)
    if locked_activity.data_lifecycle != Activity.DataLifecycle.TEST:
        raise PermissionDenied("Only test activities can leave test mode.")
    if not locked_activity.is_test_mode:
        raise PermissionDenied("Only test activities can leave test mode.")
    counts = get_test_data_counts(locked_activity)
    if any(counts.values()) and not clear:
        raise PermissionDenied("退出测试模式前必须清理所有测试数据。")
    if clear:
        if not reason.strip():
            raise PermissionDenied("清理并退出测试模式必须填写原因。")
        clear_activity_test_data(locked_activity, operator=operator)
    locked_activity.is_test_mode = False
    locked_activity.data_lifecycle = Activity.DataLifecycle.FORMAL
    locked_activity.save(update_fields=["is_test_mode", "data_lifecycle", "updated_at"])
    AuditLog.objects.create(
        operator=operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"Activity:{locked_activity.pk}",
        old_value="is_test_mode=True",
        new_value="is_test_mode=False",
        note=reason.strip(),
    )
    return counts
