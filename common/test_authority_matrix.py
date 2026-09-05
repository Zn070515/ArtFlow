"""Cross-app authority regression matrix.

This deliberately exercises ORM entry points, rather than staff views.  A view is
not an authority boundary: each row names the model-specific fact that becomes
protected and drives the instance, queryset, base-manager, bulk, FK, delete, and
Admin-canonical checks that apply to that fact.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from typing import Callable

from accounts.admin import CustomUserAdmin
from accounts.models import User
from accounts.services import change_user_role
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    RULESET_FREEZE,
    SCORE_SUMMARY_RECALCULATE,
    STAGE_RESULT_CONFIRM,
    VOTE_SESSION_STATE,
    authority_write,
)
from core.admin import ActivityAdmin
from core.models import Activity
from django.contrib import admin
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import TestCase
from django.utils import timezone
from ruleset.models import ContestRuleset, RulesetVersion
from singer_contest.admin import JudgeAdmin, SingerRegistrationAdmin
from singer_contest.models import (
    AudienceScore,
    Award,
    CompositeResult,
    ContestRound,
    CriterionScore,
    Judge,
    Performance,
    PerformanceGroup,
    RubricCriterion,
    ScoreRecord,
    ScoreSummary,
    SingerRegistration,
    StageAwardDecision,
    StageDecision,
    StageResult,
)
from voting.models import VoteBallot, VoteOption, VoteRecord, VoteSession


Rejects = (ValidationError, PermissionDenied)


@dataclass(frozen=True)
class AuthorityDescriptor:
    """One protected mutation contract and its authoritative owner."""

    name: str
    model: type
    owner: str
    check: Callable[["AuthorityMutationMatrixTests"], None]


class AuthorityMutationMatrixTests(TestCase):
    """A common, table-driven safety net for authoritative model mutations."""

    def setUp(self):
        self.operator = User.objects.create_user(username="matrix-operator", password="pass")
        self.other_user = User.objects.create_user(username="matrix-other", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.admin_user = User.objects.create_user(
                username="matrix-admin", password="pass", role=User.Role.ADMIN
            )
        self.activity = Activity.objects.create(
            title="matrix", activity_type=Activity.Type.SINGER_CONTEST, is_test_mode=True
        )
        self.other_activity = Activity.objects.create(
            title="matrix-other", activity_type=Activity.Type.SINGER_CONTEST, is_test_mode=True
        )
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.operator,
            name="Matrix singer",
            student_id="matrix-1",
            college="College",
            class_name="Class",
            phone="13000000000",
            song_name="Song",
            is_test_data=True,
        )
        self.other_singer = SingerRegistration.objects.create(
            activity=self.other_activity,
            user=self.other_user,
            name="Other singer",
            student_id="matrix-2",
            college="College",
            class_name="Class",
            phone="13100000000",
            song_name="Other song",
            is_test_data=True,
        )
        self.judge = Judge.objects.create(activity=self.activity, name="Matrix judge")
        self.round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            name="Matrix round",
        )
        self.other_round = ContestRound.objects.create(
            activity=self.other_activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            name="Other round",
        )
        self.score = ScoreRecord.objects.create(
            round=self.round,
            singer=self.singer,
            judge=self.judge,
            score=Decimal("90"),
            is_test_data=True,
        )
        self.vote_session = VoteSession.objects.create(
            activity=self.activity,
            name="Matrix vote",
            passcode="123456",
            start_time=timezone.now(),
            end_time=timezone.now() + timedelta(hours=1),
            is_test_data=True,
        )
        self.other_vote_session = VoteSession.objects.create(
            activity=self.other_activity,
            name="Other vote",
            passcode="654321",
            start_time=timezone.now(),
            end_time=timezone.now() + timedelta(hours=1),
            is_test_data=True,
        )
        self.alternate_vote_session = VoteSession.objects.create(
            activity=self.activity,
            name="Alternate matrix vote",
            passcode="234567",
            start_time=timezone.now(),
            end_time=timezone.now() + timedelta(hours=1),
            is_test_data=True,
        )
        self.option = VoteOption.objects.create(
            vote_session=self.vote_session, singer=self.singer, is_test_data=True
        )
        self.ballot = VoteBallot.objects.create(
            vote_session=self.vote_session,
            browser_session_key="matrix-browser",
            ip_address="127.0.0.1",
            is_test_data=True,
        )
        self.record = VoteRecord.objects.create(
            ballot=self.ballot,
            vote_session=self.vote_session,
            vote_option=self.option,
            browser_session_key="matrix-browser",
            ip_address="127.0.0.1",
            is_test_data=True,
        )
        self.alternate_option = VoteOption.objects.create(
            vote_session=self.alternate_vote_session, singer=self.singer, is_test_data=True
        )
        self.alternate_ballot = VoteBallot.objects.create(
            vote_session=self.alternate_vote_session,
            browser_session_key="alternate-browser",
            ip_address="127.0.0.1",
            is_test_data=True,
        )
        self.alternate_record = VoteRecord.objects.create(
            ballot=self.alternate_ballot,
            vote_session=self.alternate_vote_session,
            vote_option=self.alternate_option,
            browser_session_key="alternate-browser",
            ip_address="127.0.0.1",
            is_test_data=True,
        )
        self.group = PerformanceGroup.objects.create(
            activity=self.activity, round=self.round, name="Matrix group", is_test_data=True
        )
        self.performance = Performance.objects.create(
            activity=self.activity,
            round=self.round,
            singer=self.singer,
            group=self.group,
            is_test_data=True,
        )
        self.rubric = self.round.rubric
        if self.rubric is None:
            from singer_contest.models import ScoringRubric

            self.rubric = ScoringRubric.objects.create(
                activity=self.activity, name="Matrix rubric", is_test_data=True
            )
            self.round.rubric = self.rubric
            self.round.save(update_fields=["rubric"])
        self.criterion = RubricCriterion.objects.create(
            rubric=self.rubric,
            name="Matrix criterion",
            max_score=Decimal("100"),
            is_test_data=True,
        )
        self.criterion_score = CriterionScore.objects.create(
            score_record=self.score,
            criterion=self.criterion,
            value=Decimal("90"),
            is_test_data=True,
        )
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="Matrix rules",
            audience_keys={"matrix-audience": "matrix-audience"},
            is_test_data=True,
        )
        with authority_write(RULESET_FREEZE):
            self.version = RulesetVersion.objects.create(
                ruleset=self.ruleset,
                definition=(
                    '{"schema_version": 1, "nodes": ['
                    '{"key": "assess-audience", "type": "ASSESS", '
                    '"source": "entry", "vote_source": "matrix-audience"}]}'
                ),
                binding={"audience_keys": {"matrix-audience": "matrix-audience"}},
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
            )
        self.stage = StageResult.objects.create(
            activity=self.activity,
            ruleset_version=self.version,
            stage_key="matrix-stage",
            is_test_data=True,
        )
        self.decision = StageDecision.objects.create(
            stage_result=self.stage,
            singer=self.singer,
            outcome_code="selected",
            is_test_data=True,
        )
        self.award_decision = StageAwardDecision.objects.create(
            stage_result=self.stage,
            activity=self.activity,
            singer=self.singer,
            name="Matrix award",
            is_test_data=True,
        )
        self.composite = CompositeResult.objects.create(
            stage_result=self.stage,
            singer=self.singer,
            node_key="matrix-node",
            value=Decimal("90"),
            is_test_data=True,
        )
        self.audience = AudienceScore.objects.create(
            activity=self.activity,
            stage_key="matrix-audience",
            singer=self.singer,
            score=Decimal("90"),
            entered_by=self.operator,
            is_test_data=True,
        )
        self.award = Award.objects.create(
            activity=self.activity,
            singer=self.singer,
            name="Manual matrix award",
            is_test_data=True,
        )

    def _lock_round(self):
        with authority_write(CONTEST_ROUND_STATE):
            ContestRound.objects.filter(pk=self.round.pk).update(
                status=ContestRound.Status.LOCKED, is_locked=True
            )

    def _lock_vote(self):
        with authority_write(VOTE_SESSION_STATE):
            VoteSession.objects.filter(pk=self.vote_session.pk).update(is_locked=True)

    def _confirm_stage(self):
        self.stage.refresh_from_db()
        if self.stage.status == StageResult.Status.CONFIRMED:
            return
        with authority_write(STAGE_RESULT_CONFIRM):
            StageResult.objects.filter(pk=self.stage.pk).update(
                status=StageResult.Status.CONFIRMED,
                confirmed_at=timezone.now(),
                confirmed_by=self.operator,
            )

    def _assert_rejects(self, mutation):
        with self.assertRaises(Rejects):
            mutation()

    def test_registered_models_are_all_explicitly_owned(self):
        self.assertEqual(
            {descriptor.name for descriptor in MODEL_MATRIX},
            {
                "User", "Activity", "ContestRound", "VoteSession", "ScoreRecord",
                "ScoreSummary", "AudienceScore", "VoteOption", "VoteBallot", "VoteRecord",
                "PerformanceGroup", "Performance", "RubricCriterion", "CriterionScore",
                "StageResult", "StageDecision", "StageAwardDecision", "CompositeResult",
                "Award", "SingerRegistration", "Judge", "RulesetVersion",
            },
        )

    def test_unauthorized_mutation_matrix(self):
        for descriptor in MODEL_MATRIX:
            with self.subTest(model=descriptor.name, owner=descriptor.owner):
                descriptor.check(self)

    def test_admin_canonical_boundaries(self):
        self.assertFalse(ActivityAdmin(Activity, admin.site).has_delete_permission(None, self.activity))
        self.assertEqual(
            CustomUserAdmin(User, admin.site).get_readonly_fields(None, self.admin_user),
            ("role", "is_active", "is_superuser", "is_staff"),
        )
        self.assertEqual(
            SingerRegistrationAdmin(SingerRegistration, admin.site).get_readonly_fields(None, self.singer),
            ("activity", "user"),
        )
        self.assertEqual(
            JudgeAdmin(Judge, admin.site).get_readonly_fields(None, self.judge), ("activity",)
        )

    def test_documented_authority_services_succeed(self):
        change_user_role(
            target=self.operator, new_role=User.Role.STAFF, actor=self.admin_user
        )
        self.operator.refresh_from_db()
        self.assertEqual(self.operator.role, User.Role.STAFF)
        with authority_write(SCORE_SUMMARY_RECALCULATE):
            ScoreSummary.objects.create(
                round=self.round, singer=self.singer, average_score=Decimal("90"), is_test_data=True
            )
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=self.activity.pk).update(phase=Activity.Phase.REGISTRATION_OPEN)
        with authority_write(VOTE_SESSION_STATE):
            VoteSession.objects.filter(pk=self.vote_session.pk).update(is_open=True)


def _user_row(case):
    case.admin_user.role = User.Role.PARTICIPANT
    case._assert_rejects(lambda: case.admin_user.save(update_fields=["role"]))
    case._assert_rejects(lambda: User.objects.filter(pk=case.admin_user.pk).update(role=User.Role.PARTICIPANT))
    case._assert_rejects(lambda: User._base_manager.filter(pk=case.admin_user.pk).update(role=User.Role.PARTICIPANT))
    case.admin_user.role = User.Role.PARTICIPANT
    case._assert_rejects(lambda: User.objects.bulk_update([case.admin_user], ["role"]))


def _activity_row(case):
    case._assert_rejects(lambda: Activity.objects.filter(pk=case.activity.pk).update(phase=Activity.Phase.LIVE))
    case._assert_rejects(lambda: Activity._base_manager.filter(pk=case.activity.pk).update(phase=Activity.Phase.LIVE))
    case.activity.phase = Activity.Phase.LIVE
    case._assert_rejects(lambda: case.activity.save(update_fields=["phase"]))
    case.activity.phase = Activity.Phase.LIVE
    case._assert_rejects(lambda: Activity.objects.bulk_update([case.activity], ["phase"]))


def _round_row(case):
    case._assert_rejects(lambda: ContestRound.objects.filter(pk=case.round.pk).update(status=ContestRound.Status.LOCKED))
    case._assert_rejects(lambda: ContestRound._base_manager.filter(pk=case.round.pk).update(status=ContestRound.Status.LOCKED))
    case.round.status = ContestRound.Status.LOCKED
    case._assert_rejects(lambda: case.round.save(update_fields=["status"]))
    case.round.status = ContestRound.Status.LOCKED
    case._assert_rejects(lambda: ContestRound.objects.bulk_update([case.round], ["status"]))


def _vote_session_row(case):
    case._assert_rejects(lambda: VoteSession.objects.filter(pk=case.vote_session.pk).update(is_open=True))
    case._assert_rejects(lambda: VoteSession._base_manager.filter(pk=case.vote_session.pk).update(is_open=True))
    case.vote_session.is_open = True
    case._assert_rejects(lambda: case.vote_session.save(update_fields=["is_open"]))
    case.vote_session.is_open = True
    case._assert_rejects(lambda: VoteSession.objects.bulk_update([case.vote_session], ["is_open"]))


def _locked_round_raw_row(case, model, obj, field, value):
    case._lock_round()
    case._assert_rejects(lambda: model.objects.filter(pk=obj.pk).update(**{field: value}))
    case._assert_rejects(lambda: model._base_manager.filter(pk=obj.pk).update(**{field: value}))
    setattr(obj, field, value)
    case._assert_rejects(lambda: obj.save(update_fields=[field]))
    case._assert_rejects(lambda: model.objects.bulk_update([obj], [field]))
    case._assert_rejects(obj.delete)


def _locked_vote_raw_row(case, model, obj, field, value):
    case._lock_vote()
    case._assert_rejects(lambda: model.objects.filter(pk=obj.pk).update(**{field: value}))
    case._assert_rejects(lambda: model._base_manager.filter(pk=obj.pk).update(**{field: value}))
    setattr(obj, field, value)
    case._assert_rejects(lambda: obj.save(update_fields=[field]))
    case._assert_rejects(lambda: model.objects.bulk_update([obj], [field]))
    case._assert_rejects(obj.delete)


def _identity_row(case, model, obj, field, value):
    case._assert_rejects(lambda: model.objects.filter(pk=obj.pk).update(**{field: value}))
    case._assert_rejects(lambda: model._base_manager.filter(pk=obj.pk).update(**{field: value}))
    setattr(obj, field, value)
    case._assert_rejects(lambda: obj.save(update_fields=[field]))
    case._assert_rejects(lambda: model.objects.bulk_update([obj], [field]))


def _confirmed_child_row(case, model, obj, field, value):
    case._confirm_stage()
    case._assert_rejects(lambda: model.objects.filter(pk=obj.pk).update(**{field: value}))
    case._assert_rejects(lambda: model._base_manager.filter(pk=obj.pk).update(**{field: value}))
    setattr(obj, field, value)
    case._assert_rejects(lambda: obj.save(update_fields=[field]))
    case._assert_rejects(lambda: model.objects.bulk_update([obj], [field]))
    case._assert_rejects(obj.delete)


def _score_record(case):
    _locked_round_raw_row(case, ScoreRecord, case.score, "score", Decimal("91"))


def _score_summary(case):
    summary = ScoreSummary(
        round=case.round, singer=case.singer, average_score=Decimal("90"), is_test_data=True
    )
    with authority_write(SCORE_SUMMARY_RECALCULATE):
        summary.save()
    case._assert_rejects(lambda: ScoreSummary.objects.filter(pk=summary.pk).update(rank=1))
    case._assert_rejects(lambda: ScoreSummary._base_manager.filter(pk=summary.pk).update(rank=1))
    summary.rank = 1
    case._assert_rejects(lambda: summary.save(update_fields=["rank"]))
    case._assert_rejects(lambda: ScoreSummary.objects.bulk_update([summary], ["rank"]))
    case._assert_rejects(summary.delete)


def _audience_score(case):
    case._confirm_stage()
    _confirmed_child_row(case, AudienceScore, case.audience, "score", Decimal("91"))


def _vote_option(case):
    _locked_vote_raw_row(case, VoteOption, case.option, "sort_order", 1)
    # Both old locked and new unlocked origins are checked; changing only the new FK is no bypass.
    case._assert_rejects(
        lambda: VoteOption._base_manager.filter(pk=case.option.pk).update(
            vote_session_id=case.alternate_vote_session.pk
        )
    )
    case._assert_rejects(
        lambda: VoteOption._base_manager.filter(pk=case.alternate_option.pk).update(
            vote_session_id=case.vote_session.pk
        )
    )


def _vote_ballot(case):
    _locked_vote_raw_row(case, VoteBallot, case.ballot, "browser_session_key", "changed")
    case._assert_rejects(
        lambda: VoteBallot._base_manager.filter(pk=case.ballot.pk).update(
            vote_session_id=case.alternate_vote_session.pk
        )
    )
    case._assert_rejects(
        lambda: VoteBallot._base_manager.filter(pk=case.alternate_ballot.pk).update(
            vote_session_id=case.vote_session.pk
        )
    )


def _vote_record(case):
    _locked_vote_raw_row(case, VoteRecord, case.record, "browser_session_key", "changed")
    case._assert_rejects(
        lambda: VoteRecord._base_manager.filter(pk=case.record.pk).update(
            vote_session_id=case.alternate_vote_session.pk
        )
    )
    case._assert_rejects(
        lambda: VoteRecord._base_manager.filter(pk=case.alternate_record.pk).update(
            vote_session_id=case.vote_session.pk
        )
    )


def _performance_group(case):
    _locked_round_raw_row(case, PerformanceGroup, case.group, "name", "Changed group")


def _performance(case):
    _locked_round_raw_row(case, Performance, case.performance, "song_title", "Changed song")


def _criterion(case):
    _locked_round_raw_row(case, RubricCriterion, case.criterion, "name", "Changed criterion")


def _criterion_score(case):
    _locked_round_raw_row(case, CriterionScore, case.criterion_score, "value", Decimal("91"))


def _stage_result(case):
    case._confirm_stage()
    case._assert_rejects(lambda: StageResult.objects.filter(pk=case.stage.pk).update(stage_key="changed"))
    case._assert_rejects(lambda: StageResult._base_manager.filter(pk=case.stage.pk).update(stage_key="changed"))
    case.stage.stage_key = "changed"
    case._assert_rejects(lambda: case.stage.save(update_fields=["stage_key"]))
    case._assert_rejects(lambda: StageResult.objects.bulk_update([case.stage], ["stage_key"]))
    case._assert_rejects(case.stage.delete)


def _stage_decision(case):
    _confirmed_child_row(case, StageDecision, case.decision, "outcome_code", "changed")


def _stage_award_decision(case):
    _confirmed_child_row(case, StageAwardDecision, case.award_decision, "name", "changed")


def _composite(case):
    _confirmed_child_row(case, CompositeResult, case.composite, "value", Decimal("91"))


def _award(case):
    case._confirm_stage()
    case.award.source_stage_result = case.stage
    case._assert_rejects(lambda: case.award.save(update_fields=["source_stage_result"]))
    case._assert_rejects(
        lambda: Award._base_manager.filter(pk=case.award.pk).update(source_stage_result_id=case.stage.pk)
    )


def _singer(case):
    _identity_row(case, SingerRegistration, case.singer, "activity_id", case.other_activity.pk)
    case.singer.refresh_from_db()
    _identity_row(case, SingerRegistration, case.singer, "user_id", case.other_user.pk)


def _judge(case):
    _identity_row(case, Judge, case.judge, "activity_id", case.other_activity.pk)


def _ruleset_version(case):
    case._assert_rejects(lambda: RulesetVersion.objects.filter(pk=case.version.pk).update(definition='{"schema_version": 1, "nodes": []}'))
    case._assert_rejects(lambda: RulesetVersion._base_manager.filter(pk=case.version.pk).update(version=2))
    case.version.version = 2
    case._assert_rejects(lambda: case.version.save(update_fields=["version"]))
    case._assert_rejects(lambda: RulesetVersion.objects.bulk_update([case.version], ["version"]))
    case._assert_rejects(case.version.delete)


MODEL_MATRIX = (
    AuthorityDescriptor("User", User, "accounts.change_user_role", _user_row),
    AuthorityDescriptor("Activity", Activity, "core activity lifecycle", _activity_row),
    AuthorityDescriptor("ContestRound", ContestRound, "round lifecycle", _round_row),
    AuthorityDescriptor("VoteSession", VoteSession, "vote session lifecycle", _vote_session_row),
    AuthorityDescriptor("ScoreRecord", ScoreRecord, "raw score authority", _score_record),
    AuthorityDescriptor("ScoreSummary", ScoreSummary, "score recalculation", _score_summary),
    AuthorityDescriptor("AudienceScore", AudienceScore, "unconsumed audience fact", _audience_score),
    AuthorityDescriptor("VoteOption", VoteOption, "unlocked vote session", _vote_option),
    AuthorityDescriptor("VoteBallot", VoteBallot, "unlocked vote session", _vote_ballot),
    AuthorityDescriptor("VoteRecord", VoteRecord, "unlocked vote session", _vote_record),
    AuthorityDescriptor("PerformanceGroup", PerformanceGroup, "round configuration", _performance_group),
    AuthorityDescriptor("Performance", Performance, "round configuration", _performance),
    AuthorityDescriptor("RubricCriterion", RubricCriterion, "rubric configuration", _criterion),
    AuthorityDescriptor("CriterionScore", CriterionScore, "raw score authority", _criterion_score),
    AuthorityDescriptor("StageResult", StageResult, "stage confirmation", _stage_result),
    AuthorityDescriptor("StageDecision", StageDecision, "stage result authority", _stage_decision),
    AuthorityDescriptor("StageAwardDecision", StageAwardDecision, "stage result authority", _stage_award_decision),
    AuthorityDescriptor("CompositeResult", CompositeResult, "stage result authority", _composite),
    AuthorityDescriptor("Award", Award, "award materialization", _award),
    AuthorityDescriptor("SingerRegistration", SingerRegistration, "identity ownership", _singer),
    AuthorityDescriptor("Judge", Judge, "identity ownership", _judge),
    AuthorityDescriptor("RulesetVersion", RulesetVersion, "ruleset freeze", _ruleset_version),
)
