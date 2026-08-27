from __future__ import annotations

import json
from typing import Any

from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.db.models import Q

from .models import AuditLog


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
            vote_session__activity=activity, vote_session__is_test_data=True
        ).count(),
        "vote_records": VoteRecord.objects.filter(
            vote_session__activity=activity, vote_session__is_test_data=True
        ).count(),
        "vote_ballots": VoteBallot.objects.filter(
            vote_session__activity=activity, vote_session__is_test_data=True
        ).count(),
        "scores": ScoreRecord.objects.filter(round__activity=activity, is_test_data=True).count(),
        "score_summaries": ScoreSummary.objects.filter(
            round__activity=activity, is_test_data=True
        ).count(),
        "awards": Award.objects.filter(activity=activity, is_test_data=True).count(),
        "incidents": IncidentRecord.objects.filter(activity=activity, is_test=True).count(),
        "files": SubmissionFile.objects.filter(
            (
                Q(is_test_data=True)
                | Q(singer_registration__is_test_data=True)
                | Q(program__is_test_data=True)
            )
            & (Q(singer_registration__activity=activity) | Q(program__activity=activity))
        ).count(),
    }


@transaction.atomic
def clear_activity_test_data(activity: Any, *, operator: Any) -> dict[str, int]:
    from farewell_show.models import Program
    from files.models import SubmissionFile
    from files.services import delete_submission_file
    from incidents.models import IncidentRecord
    from singer_contest.models import Award, ScoreRecord, ScoreSummary, SingerRegistration
    from voting.models import VoteBallot, VoteOption, VoteRecord, VoteSession

    counts = get_test_data_counts(activity)
    files = SubmissionFile.objects.filter(
        (
            Q(is_test_data=True)
            | Q(singer_registration__is_test_data=True)
            | Q(program__is_test_data=True)
        )
        & (Q(singer_registration__activity=activity) | Q(program__activity=activity))
    )
    for submission_file in files:
        delete_submission_file(submission_file)
    Award.objects.filter(activity=activity, is_test_data=True).delete()
    ScoreRecord.objects.filter(round__activity=activity, is_test_data=True).delete()
    ScoreSummary.objects.filter(round__activity=activity, is_test_data=True).delete()
    VoteRecord.objects.filter(
        vote_session__activity=activity, vote_session__is_test_data=True
    ).delete()
    VoteBallot.objects.filter(
        vote_session__activity=activity, vote_session__is_test_data=True
    ).delete()
    VoteOption.objects.filter(
        vote_session__activity=activity, vote_session__is_test_data=True
    ).delete()
    VoteSession.objects.filter(activity=activity, is_test_data=True).delete()
    Program.objects.filter(activity=activity, is_test_data=True).delete()
    SingerRegistration.objects.filter(activity=activity, is_test_data=True).delete()
    IncidentRecord.objects.filter(activity=activity, is_test=True).delete()
    AuditLog.objects.create(
        operator=operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"Activity:{activity.pk}",
        note=f"clear_test_data={json.dumps(counts, ensure_ascii=False, sort_keys=True)}",
    )
    return counts


@transaction.atomic
def leave_test_mode(
    activity: Any, *, operator: Any, clear: bool = False, reason: str = ""
) -> dict[str, int]:
    from core.models import Activity

    locked_activity = Activity.objects.select_for_update().get(pk=activity.pk)
    if not locked_activity.is_test_mode:
        return {}
    counts = get_test_data_counts(locked_activity)
    if any(counts.values()) and not clear:
        raise PermissionDenied("退出测试模式前必须清理所有测试数据。")
    if clear:
        if not reason.strip():
            raise PermissionDenied("清理并退出测试模式必须填写原因。")
        clear_activity_test_data(locked_activity, operator=operator)
    locked_activity.is_test_mode = False
    locked_activity.save(update_fields=["is_test_mode", "updated_at"])
    AuditLog.objects.create(
        operator=operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"Activity:{locked_activity.pk}",
        old_value="is_test_mode=True",
        new_value="is_test_mode=False",
        note=reason.strip(),
    )
    return counts
