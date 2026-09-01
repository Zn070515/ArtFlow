from __future__ import annotations

import json
from functools import partial
from typing import Any

from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.db.models import Q

from .models import AuditLog


def lock_activity_for_runtime_data(activity: Any) -> Any:
    from core.models import Activity

    return Activity.objects.select_for_update().get(pk=activity.pk)


def get_test_data_counts(activity: Any) -> dict[str, int]:
    from exports.models import GeneratedDocument
    from farewell_show.models import Program
    from files.models import SubmissionFile
    from incidents.models import IncidentRecord
    from singer_contest.models import (
        Award,
        CompositeResult,
        CriterionScore,
        ManualDecision,
        Performance,
        ScoreRecord,
        ScoreSummary,
        SingerRegistration,
        StageDecision,
        StageResult,
    )
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
        "stage_results": StageResult.objects.filter(activity=activity, is_test_data=True).count(),
        "stage_decisions": StageDecision.objects.filter(
            stage_result__activity=activity, is_test_data=True
        ).count(),
        "composite_results": CompositeResult.objects.filter(
            stage_result__activity=activity, is_test_data=True
        ).count(),
        "criterion_scores": CriterionScore.objects.filter(
            score_record__round__activity=activity, is_test_data=True
        ).count(),
        "performances": Performance.objects.filter(activity=activity, is_test_data=True).count(),
        "manual_decisions": ManualDecision.objects.filter(
            activity=activity, is_test_data=True
        ).count(),
        "incidents": IncidentRecord.objects.filter(activity=activity, is_test=True).count(),
        "files": SubmissionFile.objects.filter(is_test_data=True)
        .filter(Q(singer_registration__activity=activity) | Q(program__activity=activity))
        .count(),
        "generated_documents": GeneratedDocument.objects.filter(
            activity=activity, is_test_data=True
        ).count(),
    }


def _restore_test_related_posts_to_draft(activity: Any, *, operator: Any) -> None:
    """Demote any published public post linked to a test activity to DRAFT.

    A test activity's public content must never follow the activity into FORMAL.
    Posts are kept (never deleted), just rolled back to DRAFT before the activity
    leaves test mode, so the public homepage is only published via an explicit
    staff action after it becomes formal.
    """
    from public_portal.models import PublicPost

    published = PublicPost.objects.filter(
        related_activity=activity, status=PublicPost.Status.PUBLISHED
    )
    if not published.exists():
        return
    count = published.update(status=PublicPost.Status.DRAFT, published_at=None)
    AuditLog.objects.create(
        operator=operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"Activity:{activity.pk}",
        note=f"leave_test_mode: demoted {count} published post(s) to draft",
    )


def _reject_mixed_marker_dependencies(activity: Any) -> None:
    from files.models import SubmissionFile
    from voting.models import VoteBallot, VoteOption, VoteRecord, VoteSession

    test_vote_sessions = VoteSession.objects.filter(activity=activity, is_test_data=True)
    if (
        VoteOption.objects.filter(vote_session__in=test_vote_sessions, is_test_data=False).exists()
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

    if (
        SubmissionFile.objects.filter(is_test_data=False)
        .filter(
            Q(singer_registration__activity=activity, singer_registration__is_test_data=True)
            | Q(program__activity=activity, program__is_test_data=True)
        )
        .exists()
    ):
        raise PermissionDenied("Test owners with formal files cannot be cleared.")


@transaction.atomic
def clear_activity_test_data(activity: Any, *, operator: Any) -> dict[str, int]:
    from exports.models import GeneratedDocument
    from farewell_show.models import Program
    from files.models import SubmissionFile
    from files.services import delete_storage_object, delete_submission_file
    from incidents.models import IncidentRecord
    from singer_contest.models import (
        Award,
        ContestRound,
        ManualDecision,
        ScoreRecord,
        ScoreSummary,
        SingerRegistration,
        StageResult,
    )
    from singer_contest.services import reset_round_snapshots
    from voting.models import VoteBallot, VoteOption, VoteRecord, VoteSession

    locked_activity = lock_activity_for_runtime_data(activity)
    if not locked_activity.is_test_mode:
        raise PermissionDenied("Test data can only be cleared while the activity is in test mode.")
    _reject_mixed_marker_dependencies(locked_activity)
    counts = get_test_data_counts(locked_activity)
    for contest_round in (
        ContestRound.objects.filter(
            activity=locked_activity,
            status__in=[
                ContestRound.Status.PREPARED,
                ContestRound.Status.SCORING,
                ContestRound.Status.LOCKED,
            ],
        )
        .order_by("pk")
        .select_for_update()
    ):
        reset_round_snapshots(contest_round, operator, reason="activity_test_cleanup")
    files = SubmissionFile.objects.filter(is_test_data=True).filter(
        Q(singer_registration__activity=locked_activity) | Q(program__activity=locked_activity)
    )
    for submission_file in files:
        delete_submission_file(submission_file)
    for generated_document in GeneratedDocument.objects.filter(
        activity=locked_activity, is_test_data=True
    ):
        storage = generated_document.file.storage
        stored_name = generated_document.file.name
        generated_document.delete()
        if stored_name:
            transaction.on_commit(partial(delete_storage_object, storage, stored_name))
    Award.objects.filter(activity=locked_activity, is_test_data=True).delete()
    # StageResult.ruleset_version is PROTECT-ed by RulesetVersion — but a ContestRuleset
    # is *config*, not runtime residue (§7, P0-8): a test rehearsal must leave its
    # ruleset structure behind for the FORMAL successor. So results go first, then manual
    # decisions, and the ContestRuleset (and its versions) is retained and later promoted.
    # Singers are deleted later, and their stage decisions cascade once the results are
    # gone. The StageResult/StageDecision querysets refuse to delete READY rows — but a
    # test activity legitimately holds READY test results, so demote them first.
    demo = StageResult.objects.filter(activity=locked_activity, is_test_data=True)
    for stage in demo:
        # A CONFIRMED test result is immutable, so demote via the bypass flag. Dropping a
        # CONFIRMED row to HOLD must also clear the trail, per the confirmed_trail CHECK.
        stage.status = StageResult.Status.HOLD
        stage.confirmed_at = None
        stage.confirmed_by = None
        stage.save(update_fields=["status", "confirmed_at", "confirmed_by"], _bypass_confirmed=True)
    StageResult.objects.filter(activity=locked_activity, is_test_data=True).delete()
    # ManualDecision FK's to the frozen RulesetVersion; delete before it is demoted.
    ManualDecision.objects.filter(activity=locked_activity, is_test_data=True).delete()
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


def _promote_retained_config(activity: Any, *, operator: Any) -> dict[str, int]:
    """Flip retained M1 config markers to a formal activity's lifecycle.

    §7/P0-8: a test rehearsal leaves *configuration* behind (rubrics, criteria,
    performance groups, material slots, and the ContestRuleset) that is never deleted
    with runtime facts. When the activity leaves test mode those markers must be promoted
    to ``is_test_data=False`` so a FORMAL activity never holds config whose marker
    contradicts its lifecycle. Runtime facts (stage results/decisions, criterion scores,
    performances, manual decisions) are handled separately and never promoted.
    """
    from django.utils import timezone
    from files.models import MaterialSlot
    from ruleset.models import ContestRuleset, RulesetVersion
    from ruleset.services import create_ruleset_version
    from singer_contest.models import PerformanceGroup, RubricCriterion, ScoringRubric

    promoted = {
        "scoring_rubrics": ScoringRubric.objects.filter(
            activity=activity, is_test_data=True
        ).update(is_test_data=False),
        "rubric_criteria": RubricCriterion.objects.filter(
            rubric__activity=activity, is_test_data=True
        ).update(is_test_data=False),
        "performance_groups": PerformanceGroup.objects.filter(
            activity=activity, is_test_data=True
        ).update(is_test_data=False),
        "material_slots": MaterialSlot.objects.filter(activity=activity, is_test_data=True).update(
            is_test_data=False
        ),
    }
    rulesets = ContestRuleset.objects.filter(activity=activity, is_test_data=True)
    promoted["rulesets"] = rulesets.count()
    promoted["successor_versions"] = 0
    for ruleset in rulesets:
        # The test ruleset is config: flip its marker (via update() to bypass clean(),
        # which would reject a False marker while the activity is still in test mode).
        ContestRuleset.objects.filter(pk=ruleset.pk).update(
            is_test_data=False, updated_at=timezone.now()
        )
        # The frozen TEST authority must never become the FORMAL authority (§16/P0-8):
        # retire it by demoting is_current, then hand the staff a clean DRAFT successor to
        # re-bind to the (now-formal) runtime and re-validate before re-freezing. If the
        # test config never froze, its current DRAFT is already the FORMAL editing target.
        retire = ruleset.versions.filter(
            is_current=True, status=RulesetVersion.Status.FROZEN
        ).first()
        if retire is not None:
            # §M1-R8: ``is_current`` = current official authority. The retiring TEST
            # frozen must not become the FORMAL authority, and a DRAFT successor is never
            # current, so demote the TEST frozen through the base manager (bypassing the
            # frozen-immutability guard on is_current) — no authority exists until staff
            # re-bind and re-freeze the FORMAL successor.
            RulesetVersion._base_manager.filter(pk=retire.pk).update(is_current=False)
            create_ruleset_version(
                ruleset,
                definition=retire.definition,
                created_by=operator,
                binding={
                    "stage_key": ruleset.stage_key or "",
                    "round_keys": {},
                    "vote_keys": {},
                    "group_keys": {},
                    "announcement_blocks": list(ruleset.announcement_blocks or []),
                },
            )
            promoted["successor_versions"] += 1
    return promoted


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
    promoted = _promote_retained_config(locked_activity, operator=operator)
    _restore_test_related_posts_to_draft(locked_activity, operator=operator)
    locked_activity.is_test_mode = False
    locked_activity.data_lifecycle = Activity.DataLifecycle.FORMAL
    locked_activity.save(
        update_fields=["is_test_mode", "data_lifecycle", "updated_at"],
        _allow_lifecycle_transition=True,
    )
    AuditLog.objects.create(
        operator=operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"Activity:{locked_activity.pk}",
        old_value="is_test_mode=True",
        new_value="is_test_mode=False",
        note=(
            f"{reason.strip()} promoted_config="
            f"{json.dumps(promoted, ensure_ascii=False, sort_keys=True)}"
        ),
    )
    return counts
