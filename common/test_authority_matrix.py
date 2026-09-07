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
from functools import partial
from typing import Any, Callable, cast

from accounts.admin import CustomUserAdmin
from accounts.models import User
from accounts.services import change_user_role, require_current_admin
from core.admin import ActivityAdmin
from core.models import Activity
from core.services import transition_activity_phase
from django.contrib import admin
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import RequestFactory, TestCase
from django.utils import timezone
from ruleset.admin import RulesetVersionAdmin
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import create_ruleset_version, freeze_ruleset_version
from singer_contest.admin import (
    AwardAdmin,
    ContestRoundAdmin,
    CriterionScoreAdmin,
    JudgeAdmin,
    RubricCriterionAdmin,
    ScoreRecordAdmin,
    ScoreSummaryAdmin,
    ScoringRubricAdmin,
    SingerRegistrationAdmin,
)
from singer_contest.models import (
    AudienceScore,
    Award,
    CompositeResult,
    ContestRound,
    CriterionScore,
    DuelDecision,
    Judge,
    ManualDecision,
    Performance,
    PerformanceGroup,
    RoundEntry,
    RoundJudge,
    RubricCriterion,
    ScoreRecord,
    ScoreSummary,
    ScoreWriteReceipt,
    ScoringRubric,
    SingerRegistration,
    StageAwardDecision,
    StageDecision,
    StageResult,
)
from singer_contest.services import (
    _authorized_award_materialization,
    apply_scores,
    confirm_stage_result,
    lock_round,
    prepare_round,
    run_ruleset,
)
from voting.models import VoteBallot, VoteOption, VoteRecord, VoteSession
from voting.services import lock_vote_session

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
from common.models import AuditLog

Rejects = (ValidationError, PermissionDenied)


@dataclass(frozen=True)
class AuthorityDescriptor:
    """One protected mutation contract and its authoritative owner."""

    name: str
    model: type
    owner: str
    factory: Callable[["AuthorityMutationMatrixTests"], Any]
    mutations: tuple["MutationDescriptor", ...]


@dataclass(frozen=True)
class MutationDescriptor:
    """One independently named mutation path for a model row."""

    path: str
    attempt: Callable[["AuthorityMutationMatrixTests", Any], None]


@dataclass(frozen=True)
class BulkDeleteDescriptor:
    """A distinct bulk-insert and queryset-delete assertion for one protected model."""

    name: str
    model: type
    attempt: Callable[["AuthorityMutationMatrixTests"], None]


class AuthorityMutationMatrixTests(TestCase):
    """A common, table-driven safety net for authoritative model mutations."""

    def setUp(self):
        self.operator = User.objects.create_user(username="matrix-operator", password="pass")
        self.other_user = User.objects.create_user(username="matrix-other", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.admin_user = User.objects.create_user(
                username="matrix-admin", password="pass", role=User.Role.ADMIN
            )
            self.staff_user = User.objects.create_user(
                username="matrix-staff", password="pass", role=User.Role.STAFF
            )
            User.objects.filter(pk=self.admin_user.pk).update(is_superuser=True, is_staff=True)
        self.admin_user.refresh_from_db()
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
            pre_status=SingerRegistration.PreStatus.APPROVED,
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
        self.spare_singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=User.objects.create_user(username="matrix-spare", password="pass"),
            name="Spare singer",
            student_id="matrix-3",
            college="College",
            class_name="Class",
            phone="13200000000",
            song_name="Spare song",
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
        self.alternate_round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            name="Alternate matrix round",
        )
        self.alternate_judge = Judge.objects.create(
            activity=self.activity, name="Alternate judge", is_active=False
        )
        self.score = ScoreRecord.objects.create(
            round=self.round,
            singer=self.singer,
            judge=self.judge,
            score=Decimal("90"),
            is_test_data=True,
        )
        self.alternate_score = ScoreRecord.objects.create(
            round=self.alternate_round,
            singer=self.spare_singer,
            judge=self.alternate_judge,
            score=Decimal("80"),
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
        self.alternate_group = PerformanceGroup.objects.create(
            activity=self.activity,
            round=self.alternate_round,
            name="Alternate group",
            is_test_data=True,
        )
        self.performance = Performance.objects.create(
            activity=self.activity,
            round=self.round,
            singer=self.singer,
            group=self.group,
            is_test_data=True,
        )
        self.alternate_performance = Performance.objects.create(
            activity=self.activity,
            round=self.alternate_round,
            singer=self.spare_singer,
            group=self.alternate_group,
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
        from singer_contest.models import ScoringRubric

        self.alternate_rubric = ScoringRubric.objects.create(
            activity=self.activity, name="Alternate rubric", is_test_data=True
        )
        self.alternate_criterion = RubricCriterion.objects.create(
            rubric=self.alternate_rubric,
            name="Alternate criterion",
            max_score=Decimal("100"),
            is_test_data=True,
        )
        self.criterion_score = CriterionScore.objects.create(
            score_record=self.score,
            criterion=self.criterion,
            value=Decimal("90"),
            is_test_data=True,
        )
        self.alternate_criterion_score = CriterionScore.objects.create(
            score_record=self.alternate_score,
            criterion=self.alternate_criterion,
            value=Decimal("80"),
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
        self.alternate_stage = StageResult.objects.create(
            activity=self.activity,
            ruleset_version=self.version,
            stage_key="alternate-stage",
            is_test_data=True,
        )
        self.decision = StageDecision.objects.create(
            stage_result=self.stage,
            singer=self.singer,
            outcome_code="selected",
            is_test_data=True,
        )
        self.alternate_decision = StageDecision.objects.create(
            stage_result=self.alternate_stage,
            singer=self.spare_singer,
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
        self.alternate_award_decision = StageAwardDecision.objects.create(
            stage_result=self.alternate_stage,
            activity=self.activity,
            singer=self.spare_singer,
            name="Alternate matrix award",
            is_test_data=True,
        )
        self.composite = CompositeResult.objects.create(
            stage_result=self.stage,
            singer=self.singer,
            node_key="matrix-node",
            value=Decimal("90"),
            is_test_data=True,
        )
        self.alternate_composite = CompositeResult.objects.create(
            stage_result=self.alternate_stage,
            singer=self.spare_singer,
            node_key="alternate-node",
            value=Decimal("80"),
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
                "User",
                "Activity",
                "ContestRound",
                "VoteSession",
                "ScoreRecord",
                "ScoreSummary",
                "AudienceScore",
                "VoteOption",
                "VoteBallot",
                "VoteRecord",
                "PerformanceGroup",
                "Performance",
                "RubricCriterion",
                "CriterionScore",
                "StageResult",
                "StageDecision",
                "StageAwardDecision",
                "CompositeResult",
                "Award",
                "SingerRegistration",
                "Judge",
                "RulesetVersion",
            },
        )

    def test_unauthorized_mutation_matrix(self):
        for descriptor in MODEL_MATRIX:
            instance = descriptor.factory(self)
            self.assertIsNotNone(instance, descriptor.name)
            self.assertTrue(descriptor.mutations, descriptor.name)
            for mutation in descriptor.mutations:
                with self.subTest(
                    model=descriptor.name, owner=descriptor.owner, path=mutation.path
                ):
                    mutation.attempt(self, instance)

    def test_bulk_create_and_queryset_delete_matrix(self):
        for descriptor in BULK_DELETE_MATRIX:
            with self.subTest(model=descriptor.name):
                descriptor.attempt(self)

    def test_protected_fact_querysets_reject_positional_conflict_upsert_through_both_managers(
        self,
    ):
        """Unsupported fact/child upserts must be identified before validation or SQL."""

        entry = RoundEntry.objects.create(round=self.round, singer=self.singer)
        assignment = RoundJudge.objects.create(round=self.round, judge=self.judge)
        with authority_write(SCORE_SUMMARY_RECALCULATE):
            summary = ScoreSummary.objects.create(
                round=self.round,
                singer=self.singer,
                average_score=Decimal("90"),
                is_test_data=True,
            )
        receipt = ScoreWriteReceipt.objects.create(
            command_id="matrix-positional-receipt",
            operator=self.operator,
            operation="score",
            payload_hash="0" * 64,
            result_version=0,
            result_payload={},
            status=ScoreWriteReceipt.Status.PENDING,
        )

        cases: tuple[tuple[str, type[Any], Callable[[], Any], tuple[str, ...]], ...] = (
            (
                "SingerRegistration",
                SingerRegistration,
                lambda: SingerRegistration(
                    pk=self.singer.pk,
                    activity=self.activity,
                    user=self.operator,
                    name="Positional singer",
                    student_id=self.singer.student_id,
                    college="College",
                    class_name="Class",
                    phone="13000000000",
                    song_name="Song",
                    is_test_data=True,
                ),
                ("name",),
            ),
            (
                "Judge",
                Judge,
                lambda: Judge(pk=self.judge.pk, activity=self.activity, name="Positional judge"),
                ("name",),
            ),
            (
                "RoundEntry",
                RoundEntry,
                lambda: RoundEntry(pk=entry.pk, round=self.round, singer=self.singer),
                ("running_order",),
            ),
            (
                "RoundJudge",
                RoundJudge,
                lambda: RoundJudge(pk=assignment.pk, round=self.round, judge=self.judge),
                ("judge",),
            ),
            (
                "ScoreRecord",
                ScoreRecord,
                lambda: ScoreRecord(
                    pk=self.score.pk,
                    round=self.round,
                    singer=self.singer,
                    judge=self.judge,
                    score=Decimal("91"),
                    is_test_data=True,
                ),
                ("score",),
            ),
            (
                "ScoreWriteReceipt",
                ScoreWriteReceipt,
                lambda: ScoreWriteReceipt(
                    pk=receipt.pk,
                    command_id=receipt.command_id,
                    operator=self.operator,
                    operation="score",
                    payload_hash="1" * 64,
                    result_version=0,
                    result_payload={},
                    status=ScoreWriteReceipt.Status.PENDING,
                ),
                ("payload_hash",),
            ),
            (
                "ScoreSummary",
                ScoreSummary,
                lambda: ScoreSummary(
                    pk=summary.pk,
                    round=self.round,
                    singer=self.singer,
                    average_score=Decimal("91"),
                    is_test_data=True,
                ),
                ("average_score",),
            ),
            (
                "AudienceScore",
                AudienceScore,
                lambda: AudienceScore(
                    pk=self.audience.pk,
                    activity=self.activity,
                    stage_key=self.audience.stage_key,
                    singer=self.singer,
                    score=Decimal("91"),
                    is_test_data=True,
                ),
                ("score",),
            ),
            (
                "Award",
                Award,
                lambda: Award(
                    pk=self.award.pk,
                    activity=self.activity,
                    singer=self.singer,
                    name="Positional award",
                    is_test_data=True,
                ),
                ("name",),
            ),
            (
                "PerformanceGroup",
                PerformanceGroup,
                lambda: PerformanceGroup(
                    pk=self.group.pk,
                    activity=self.activity,
                    round=self.round,
                    name="Positional group",
                    is_test_data=True,
                ),
                ("name",),
            ),
            (
                "Performance",
                Performance,
                lambda: Performance(
                    pk=self.performance.pk,
                    activity=self.activity,
                    round=self.round,
                    singer=self.singer,
                    group=self.group,
                    song_title="Positional song",
                    is_test_data=True,
                ),
                ("song_title",),
            ),
            (
                "ScoringRubric",
                ScoringRubric,
                lambda: ScoringRubric(
                    pk=self.rubric.pk,
                    activity=self.activity,
                    name="Positional rubric",
                    is_test_data=True,
                ),
                ("name",),
            ),
            (
                "RubricCriterion",
                RubricCriterion,
                lambda: RubricCriterion(
                    pk=self.criterion.pk,
                    rubric=self.rubric,
                    name=self.criterion.name,
                    max_score=Decimal("90"),
                    is_test_data=True,
                ),
                ("max_score",),
            ),
            (
                "CriterionScore",
                CriterionScore,
                lambda: CriterionScore(
                    pk=self.criterion_score.pk,
                    score_record=self.score,
                    criterion=self.criterion,
                    value=Decimal("91"),
                    is_test_data=True,
                ),
                ("value",),
            ),
            (
                "StageResult",
                StageResult,
                lambda: StageResult(
                    pk=self.stage.pk,
                    activity=self.activity,
                    ruleset_version=self.version,
                    stage_key="positional-stage",
                    is_test_data=True,
                ),
                ("stage_key",),
            ),
            (
                "ManualDecision",
                ManualDecision,
                lambda: ManualDecision(
                    activity=self.activity,
                    ruleset_version=self.version,
                    manual_key="manual",
                    group="",
                    chosen=[],
                    is_test_data=True,
                ),
                ("chosen",),
            ),
            (
                "DuelDecision",
                DuelDecision,
                lambda: DuelDecision(
                    activity=self.activity,
                    ruleset_version=self.version,
                    duel_key="duel",
                    pair_key="1|2",
                    winner="1",
                    is_test_data=True,
                ),
                ("winner",),
            ),
        )
        for name, model, candidate_factory, update_fields in cases:
            for manager_name in ("objects", "_base_manager"):
                manager = getattr(model, manager_name)
                with self.subTest(model=name, manager=manager_name):
                    with self.assertRaisesRegex(ValidationError, "update_conflicts=True"):
                        manager.bulk_create(
                            [candidate_factory()],
                            None,
                            False,
                            True,
                            update_fields,
                            ["id"],
                        )

    def test_formal_fk_mutation_matrix_checks_old_and_new_origins(self):
        self._lock_round()
        for model, protected, unprotected, field in (
            (ScoreRecord, self.score, self.alternate_score, "round_id"),
            (PerformanceGroup, self.group, self.alternate_group, "round_id"),
            (Performance, self.performance, self.alternate_performance, "round_id"),
        ):
            with self.subTest(model=model.__name__, direction="protected-to-unprotected"):
                self._assert_rejects(
                    lambda model=model, protected=protected, field=field: (
                        model._base_manager.filter(pk=protected.pk).update(
                            **{field: self.alternate_round.pk}
                        )
                    )
                )
            with self.subTest(model=model.__name__, direction="unprotected-to-protected"):
                self._assert_rejects(
                    lambda model=model, unprotected=unprotected, field=field: (
                        model._base_manager.filter(pk=unprotected.pk).update(
                            **{field: self.round.pk}
                        )
                    )
                )

        self._assert_rejects(
            lambda: ScoreRecord._base_manager.filter(pk=self.score.pk).update(
                singer_id=self.spare_singer.pk
            )
        )
        self._assert_rejects(
            lambda: ScoreRecord._base_manager.filter(pk=self.score.pk).update(
                judge_id=self.alternate_judge.pk
            )
        )
        self._assert_rejects(
            lambda: RubricCriterion._base_manager.filter(pk=self.criterion.pk).update(
                rubric_id=self.alternate_rubric.pk
            )
        )
        self._assert_rejects(
            lambda: RubricCriterion._base_manager.filter(pk=self.alternate_criterion.pk).update(
                rubric_id=self.rubric.pk
            )
        )
        with self.subTest(model="CriterionScore", direction="protected-to-unprotected"):
            self._assert_rejects(
                lambda: CriterionScore._base_manager.filter(pk=self.criterion_score.pk).update(
                    score_record_id=self.alternate_score.pk
                )
            )
        with self.subTest(model="CriterionScore", direction="unprotected-to-protected"):
            self._assert_rejects(
                lambda: CriterionScore._base_manager.filter(
                    pk=self.alternate_criterion_score.pk
                ).update(score_record_id=self.score.pk)
            )

        self._confirm_stage()
        for stage_model, stage_protected, stage_unprotected in (
            (StageDecision, self.decision, self.alternate_decision),
            (StageAwardDecision, self.award_decision, self.alternate_award_decision),
            (CompositeResult, self.composite, self.alternate_composite),
        ):
            with self.subTest(model=stage_model.__name__, direction="protected-to-unprotected"):
                self._assert_rejects(
                    lambda stage_model=stage_model, stage_protected=stage_protected: (
                        stage_model._base_manager.filter(pk=stage_protected.pk).update(
                            stage_result_id=self.alternate_stage.pk
                        )
                    )
                )
            with self.subTest(model=stage_model.__name__, direction="unprotected-to-protected"):
                self._assert_rejects(
                    lambda stage_model=stage_model, stage_unprotected=stage_unprotected: (
                        stage_model._base_manager.filter(pk=stage_unprotected.pk).update(
                            stage_result_id=self.stage.pk
                        )
                    )
                )

    def test_stage_children_reject_cross_activity_queryset_updates_before_confirmation(self):
        other_ruleset = ContestRuleset.objects.create(
            activity=self.other_activity, name="Other matrix rules", is_test_data=True
        )
        with authority_write(RULESET_FREEZE):
            other_version = RulesetVersion.objects.create(
                ruleset=other_ruleset,
                definition='{"schema_version": 1, "nodes": [{"key": "r", "type": "ROSTER"}]}',
                binding={},
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
            )
        other_stage = StageResult.objects.create(
            activity=self.other_activity,
            ruleset_version=other_version,
            stage_key="other-stage",
            is_test_data=True,
        )

        for model, obj in (
            (StageDecision, self.decision),
            (StageAwardDecision, self.award_decision),
            (CompositeResult, self.composite),
        ):
            with self.subTest(model=model.__name__, field="stage_result"):
                self._assert_rejects(
                    lambda model=model, obj=obj: model._base_manager.filter(pk=obj.pk).update(
                        stage_result_id=other_stage.pk
                    )
                )
            with self.subTest(model=model.__name__, field="singer"):
                self._assert_rejects(
                    lambda model=model, obj=obj: model.objects.filter(pk=obj.pk).update(
                        singer_id=self.other_singer.pk
                    )
                )

        self._assert_rejects(
            lambda: StageAwardDecision._base_manager.filter(pk=self.award_decision.pk).update(
                activity_id=self.other_activity.pk
            )
        )

    def test_stage_children_reject_cross_activity_save_and_bulk_update_before_confirmation(self):
        other_ruleset = ContestRuleset.objects.create(
            activity=self.other_activity, name="Other stage child bulk rules", is_test_data=True
        )
        with authority_write(RULESET_FREEZE):
            other_version = RulesetVersion.objects.create(
                ruleset=other_ruleset,
                definition='{"schema_version": 1, "nodes": [{"key": "r", "type": "ROSTER"}]}',
                binding={},
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
            )
        other_stage = StageResult.objects.create(
            activity=self.other_activity,
            ruleset_version=other_version,
            stage_key="other-stage-bulk",
            is_test_data=True,
        )

        for model, source in (
            (StageDecision, self.decision),
            (StageAwardDecision, self.award_decision),
            (CompositeResult, self.composite),
        ):
            obj = model._base_manager.get(pk=source.pk)
            obj.stage_result = other_stage
            obj.singer = self.other_singer
            if isinstance(obj, StageAwardDecision):
                obj.activity = self.other_activity
            with self.subTest(model=model.__name__, path="save"):
                self._assert_rejects(lambda obj=obj: obj.save())
            with self.subTest(model=model.__name__, path="bulk_update"):
                fields = ["stage_result", "singer"]
                if isinstance(obj, StageAwardDecision):
                    fields.append("activity")
                self._assert_rejects(
                    lambda model=model, obj=obj, fields=fields: model.objects.bulk_update(
                        [obj], fields
                    )
                )

    def test_stage_children_allow_same_activity_queryset_updates_before_confirmation(self):
        updated = StageDecision.objects.filter(pk=self.decision.pk).update(
            stage_result_id=self.alternate_stage.pk
        )
        self.assertEqual(updated, 1)
        self.decision.refresh_from_db()
        self.assertEqual(self.decision.stage_result_id, self.alternate_stage.pk)

        updated = StageAwardDecision._base_manager.filter(pk=self.award_decision.pk).update(
            stage_result_id=self.alternate_stage.pk
        )
        self.assertEqual(updated, 1)
        self.award_decision.refresh_from_db()
        self.assertEqual(self.award_decision.stage_result_id, self.alternate_stage.pk)

        updated = CompositeResult.objects.filter(pk=self.composite.pk).update(
            singer_id=self.spare_singer.pk
        )
        self.assertEqual(updated, 1)
        self.composite.refresh_from_db()
        self.assertEqual(self.composite.singer_id, self.spare_singer.pk)

    def test_vote_children_reject_cross_session_queryset_updates_before_lock(self):
        other_option = VoteOption.objects.create(
            vote_session=self.other_vote_session, singer=self.other_singer, is_test_data=True
        )
        other_ballot = VoteBallot.objects.create(
            vote_session=self.other_vote_session,
            browser_session_key="matrix-other-record-browser",
            ip_address="127.0.0.1",
            is_test_data=True,
        )

        self._assert_rejects(
            lambda: VoteOption._base_manager.filter(pk=self.option.pk).update(
                vote_session_id=self.other_vote_session.pk
            )
        )
        self._assert_rejects(
            lambda: VoteOption.objects.filter(pk=self.option.pk).update(
                singer_id=self.other_singer.pk
            )
        )
        self._assert_rejects(
            lambda: VoteBallot._base_manager.filter(pk=self.ballot.pk).update(
                vote_session_id=self.other_vote_session.pk
            )
        )
        self._assert_rejects(
            lambda: VoteRecord.objects.filter(pk=self.record.pk).update(
                vote_session_id=self.other_vote_session.pk
            )
        )
        self._assert_rejects(
            lambda: VoteRecord._base_manager.filter(pk=self.record.pk).update(
                ballot_id=other_ballot.pk
            )
        )
        self._assert_rejects(
            lambda: VoteRecord.objects.filter(pk=self.record.pk).update(
                vote_option_id=other_option.pk
            )
        )

    def test_vote_children_reject_cross_session_save_and_bulk_update_before_lock(self):
        other_replacement_singer = SingerRegistration.objects.create(
            activity=self.other_activity,
            user=User.objects.create_user(
                username="matrix-other-option-replacement", password="pass"
            ),
            name="Other replacement singer",
            student_id="matrix-other-4",
            college="College",
            class_name="Class",
            phone="13400000000",
            song_name="Other replacement song",
            is_test_data=True,
        )
        other_option = VoteOption.objects.create(
            vote_session=self.other_vote_session, singer=self.other_singer, is_test_data=True
        )
        other_ballot = VoteBallot.objects.create(
            vote_session=self.other_vote_session,
            browser_session_key="matrix-other-bulk-browser",
            ip_address="127.0.0.1",
            is_test_data=True,
        )

        option = VoteOption._base_manager.get(pk=self.option.pk)
        option.vote_session = self.other_vote_session
        option.singer = other_replacement_singer
        self._assert_rejects(lambda: option.save())
        self._assert_rejects(
            lambda: VoteOption.objects.bulk_update([option], ["vote_session", "singer"])
        )

        ballot = VoteBallot._base_manager.get(pk=self.ballot.pk)
        ballot.vote_session = self.other_vote_session
        self._assert_rejects(lambda: ballot.save())
        self._assert_rejects(lambda: VoteBallot.objects.bulk_update([ballot], ["vote_session"]))

        record = VoteRecord._base_manager.get(pk=self.record.pk)
        record.vote_session = self.other_vote_session
        record.ballot = other_ballot
        record.vote_option = other_option
        self._assert_rejects(lambda: record.save())
        self._assert_rejects(
            lambda: VoteRecord.objects.bulk_update(
                [record], ["vote_session", "ballot", "vote_option"]
            )
        )

    def test_vote_children_allow_same_session_queryset_updates_before_lock(self):
        option_replacement_singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=User.objects.create_user(username="matrix-option-replacement", password="pass"),
            name="Option replacement singer",
            student_id="matrix-4",
            college="College",
            class_name="Class",
            phone="13300000000",
            song_name="Replacement song",
            is_test_data=True,
        )
        same_session_option = VoteOption.objects.create(
            vote_session=self.vote_session, singer=self.spare_singer, is_test_data=True
        )
        same_session_ballot = VoteBallot.objects.create(
            vote_session=self.vote_session,
            browser_session_key="matrix-same-record-browser",
            ip_address="127.0.0.1",
            is_test_data=True,
        )

        updated = VoteOption.objects.filter(pk=self.option.pk).update(
            singer_id=option_replacement_singer.pk
        )
        self.assertEqual(updated, 1)
        self.option.refresh_from_db()
        self.assertEqual(self.option.singer_id, option_replacement_singer.pk)

        updated = VoteRecord._base_manager.filter(pk=self.record.pk).update(
            ballot_id=same_session_ballot.pk,
            vote_option_id=same_session_option.pk,
        )
        self.assertEqual(updated, 1)
        self.record.refresh_from_db()
        self.assertEqual(self.record.ballot_id, same_session_ballot.pk)
        self.assertEqual(self.record.vote_option_id, same_session_option.pk)

    def test_protected_stage_and_vote_children_reject_conflict_upsert_through_both_managers(self):
        """Conflict-upsert is not an approved authority workflow for stored child facts."""

        def attempt_conflict_upsert(manager, candidate_factory, update_fields):
            manager.bulk_create(
                [candidate_factory()],
                update_conflicts=True,
                update_fields=update_fields,
                unique_fields=["id"],
            )

        def attempt_positional_conflict_upsert(manager, candidate_factory, update_fields):
            manager.bulk_create(
                [candidate_factory()],
                None,
                False,
                True,
                update_fields,
                ["id"],
            )

        self._confirm_stage()
        stage_relation_upserts: tuple[
            tuple[
                str,
                type[Any],
                Callable[[], Any],
                tuple[str, ...],
                tuple[str, ...],
                Callable[[], Any],
            ],
            ...,
        ] = (
            (
                "StageDecision",
                StageDecision,
                lambda: StageDecision(
                    pk=self.decision.pk,
                    stage_result=self.alternate_stage,
                    singer=self.singer,
                    outcome_code="selected",
                    is_test_data=True,
                ),
                ("stage_result_id", "singer_id", "outcome_code"),
                ("stage_result_id", "singer_id", "outcome_code"),
                lambda: StageDecision(
                    stage_result=self.alternate_stage,
                    singer=User.objects.create_user(
                        username="matrix-stage-upsert-singer-user", password="pass"
                    ).singer_registrations.create(
                        activity=self.activity,
                        name="Stage upsert singer",
                        student_id="matrix-upsert-stage",
                        college="College",
                        class_name="Class",
                        phone="13500000000",
                        song_name="Stage song",
                        is_test_data=True,
                    ),
                    outcome_code="selected",
                    is_test_data=True,
                ),
            ),
            (
                "StageAwardDecision",
                StageAwardDecision,
                lambda: StageAwardDecision(
                    pk=self.award_decision.pk,
                    stage_result=self.alternate_stage,
                    activity=self.activity,
                    singer=self.singer,
                    name="Matrix award",
                    is_test_data=True,
                ),
                ("stage_result_id", "activity_id", "singer_id", "name"),
                ("stage_result_id", "activity_id", "singer_id", "name"),
                lambda: StageAwardDecision(
                    stage_result=self.alternate_stage,
                    activity=self.activity,
                    singer=self.spare_singer,
                    name="Stage upsert ordinary award",
                    is_test_data=True,
                ),
            ),
            (
                "CompositeResult",
                CompositeResult,
                lambda: CompositeResult(
                    pk=self.composite.pk,
                    stage_result=self.alternate_stage,
                    singer=self.singer,
                    node_key="matrix-node",
                    value=Decimal("91"),
                    is_test_data=True,
                ),
                ("stage_result_id", "singer_id", "node_key", "value"),
                ("stage_result_id", "singer_id", "node_key", "value"),
                lambda: CompositeResult(
                    stage_result=self.alternate_stage,
                    singer=self.spare_singer,
                    node_key="stage-upsert-ordinary-node",
                    value=Decimal("81"),
                    is_test_data=True,
                ),
            ),
        )
        for (
            name,
            model,
            candidate_factory,
            update_fields,
            snapshot_fields,
            ordinary_factory,
        ) in stage_relation_upserts:
            with self.subTest(model=name, path="ordinary-bulk-create"):
                created = model.objects.bulk_create([ordinary_factory()])
                self.assertEqual(len(created), 1)

            before = model._base_manager.filter(pk=candidate_factory().pk).values(*snapshot_fields)[
                0
            ]
            for manager_name in ("objects", "_base_manager"):
                manager = getattr(model, manager_name)
                with self.subTest(model=name, manager=manager_name, call="keyword"):
                    self._assert_rejects(
                        partial(attempt_conflict_upsert, manager, candidate_factory, update_fields)
                    )
                    self.assertEqual(
                        model._base_manager.filter(pk=candidate_factory().pk).values(
                            *snapshot_fields
                        )[0],
                        before,
                    )
                with self.subTest(model=name, manager=manager_name, call="positional"):
                    with self.assertRaisesRegex(ValidationError, "update_conflicts=True"):
                        attempt_positional_conflict_upsert(
                            manager, candidate_factory, update_fields
                        )
                    self.assertEqual(
                        model._base_manager.filter(pk=candidate_factory().pk).values(
                            *snapshot_fields
                        )[0],
                        before,
                    )

        replacement_session = VoteSession.objects.create(
            activity=self.activity,
            name="Matrix vote upsert target",
            passcode="456789",
            start_time=timezone.now(),
            end_time=timezone.now() + timedelta(hours=1),
            is_test_data=True,
        )
        replacement_option = VoteOption.objects.create(
            vote_session=replacement_session,
            singer=self.singer,
            is_test_data=True,
        )
        replacement_ballot = VoteBallot.objects.create(
            vote_session=replacement_session,
            browser_session_key="matrix-upsert-target-browser",
            ip_address="127.0.0.1",
            is_test_data=True,
        )
        self._lock_vote()
        vote_relation_upserts: tuple[
            tuple[
                str,
                type[Any],
                Callable[[], Any],
                tuple[str, ...],
                tuple[str, ...],
                Callable[[], Any],
            ],
            ...,
        ] = (
            (
                "VoteOption",
                VoteOption,
                lambda: VoteOption(
                    pk=self.option.pk,
                    vote_session=replacement_session,
                    singer=self.singer,
                    sort_order=7,
                    is_test_data=True,
                ),
                ("vote_session", "singer", "sort_order"),
                ("vote_session_id", "singer_id", "sort_order"),
                lambda: VoteOption(
                    vote_session=replacement_session,
                    singer=self.spare_singer,
                    sort_order=8,
                    is_test_data=True,
                ),
            ),
            (
                "VoteBallot",
                VoteBallot,
                lambda: VoteBallot(
                    pk=self.ballot.pk,
                    vote_session=replacement_session,
                    browser_session_key="matrix-upsert-moved-browser",
                    ip_address="127.0.0.1",
                    is_test_data=True,
                ),
                ("vote_session", "browser_session_key", "ip_address"),
                ("vote_session_id", "browser_session_key", "ip_address"),
                lambda: VoteBallot(
                    vote_session=replacement_session,
                    browser_session_key="matrix-upsert-ordinary-browser",
                    ip_address="127.0.0.1",
                    is_test_data=True,
                ),
            ),
            (
                "VoteRecord",
                VoteRecord,
                lambda: VoteRecord(
                    pk=self.record.pk,
                    ballot=replacement_ballot,
                    vote_session=replacement_session,
                    vote_option=replacement_option,
                    browser_session_key="matrix-upsert-moved-record",
                    ip_address="127.0.0.1",
                    is_test_data=True,
                ),
                (
                    "ballot",
                    "vote_session",
                    "vote_option",
                    "browser_session_key",
                    "ip_address",
                ),
                (
                    "ballot_id",
                    "vote_session_id",
                    "vote_option_id",
                    "browser_session_key",
                    "ip_address",
                ),
                lambda: VoteRecord(
                    ballot=replacement_ballot,
                    vote_session=replacement_session,
                    vote_option=replacement_option,
                    browser_session_key="matrix-upsert-ordinary-record",
                    ip_address="127.0.0.1",
                    is_test_data=True,
                ),
            ),
        )
        for (
            name,
            model,
            candidate_factory,
            update_fields,
            snapshot_fields,
            ordinary_factory,
        ) in vote_relation_upserts:
            with self.subTest(model=name, path="ordinary-bulk-create"):
                created = model.objects.bulk_create([ordinary_factory()])
                self.assertEqual(len(created), 1)

            before = model._base_manager.filter(pk=candidate_factory().pk).values(*snapshot_fields)[
                0
            ]
            for manager_name in ("objects", "_base_manager"):
                manager = getattr(model, manager_name)
                with self.subTest(model=name, manager=manager_name, call="keyword"):
                    self._assert_rejects(
                        partial(attempt_conflict_upsert, manager, candidate_factory, update_fields)
                    )
                    self.assertEqual(
                        model._base_manager.filter(pk=candidate_factory().pk).values(
                            *snapshot_fields
                        )[0],
                        before,
                    )
                with self.subTest(model=name, manager=manager_name, call="positional"):
                    with self.assertRaisesRegex(ValidationError, "update_conflicts=True"):
                        attempt_positional_conflict_upsert(
                            manager, candidate_factory, update_fields
                        )
                    self.assertEqual(
                        model._base_manager.filter(pk=candidate_factory().pk).values(
                            *snapshot_fields
                        )[0],
                        before,
                    )

    def test_ruleset_version_conflict_upsert_rejects_existing_frozen_current_through_both_managers(
        self,
    ):
        """Direct conflict-upsert must not rewrite a stored frozen/current ruleset."""

        original = RulesetVersion._base_manager.filter(pk=self.version.pk).values(
            "definition",
            "status",
            "is_current",
            "content_hash",
            "binding",
        )[0]
        replacement_definition = (
            '{"schema_version": 1, "nodes": [{"key": "changed", "type": "ROSTER"}]}'
        )

        for manager_name in ("objects", "_base_manager"):
            manager = getattr(RulesetVersion, manager_name)
            with self.subTest(manager=manager_name, call="keyword"):
                self._assert_rejects(
                    lambda manager=manager: manager.bulk_create(
                        [
                            RulesetVersion(
                                pk=self.version.pk,
                                ruleset=self.ruleset,
                                version=self.version.version,
                                definition=replacement_definition,
                                binding={"stage_key": "changed"},
                            )
                        ],
                        update_conflicts=True,
                        update_fields=["definition", "binding"],
                        unique_fields=["pk"],
                    )
                )
                self.assertEqual(
                    RulesetVersion._base_manager.filter(pk=self.version.pk).values(
                        "definition",
                        "status",
                        "is_current",
                        "content_hash",
                        "binding",
                    )[0],
                    original,
                )
            with self.subTest(manager=manager_name, call="positional"):
                with self.assertRaises(ValidationError):
                    manager.bulk_create(
                        [
                            RulesetVersion(
                                pk=self.version.pk,
                                ruleset=self.ruleset,
                                version=self.version.version,
                                definition=replacement_definition,
                                binding={"stage_key": "changed"},
                            )
                        ],
                        None,
                        False,
                        True,
                        ["definition", "binding"],
                        ["pk"],
                    )
                self.assertEqual(
                    RulesetVersion._base_manager.filter(pk=self.version.pk).values(
                        "definition",
                        "status",
                        "is_current",
                        "content_hash",
                        "binding",
                    )[0],
                    original,
                )

    def test_admin_canonical_boundaries(self):
        request = RequestFactory().get("/admin/")
        request.user = self.admin_user
        self.assertFalse(
            ActivityAdmin(Activity, admin.site).has_delete_permission(None, self.activity)
        )
        self.assertEqual(
            CustomUserAdmin(User, admin.site).get_readonly_fields(None, self.admin_user),
            ("role", "is_active", "is_superuser", "is_staff"),
        )
        self.assertEqual(
            SingerRegistrationAdmin(SingerRegistration, admin.site).get_readonly_fields(
                None, self.singer
            ),
            ("activity", "user"),
        )
        self.assertEqual(
            JudgeAdmin(Judge, admin.site).get_readonly_fields(None, self.judge), ("activity",)
        )
        self.assertFalse(
            ContestRoundAdmin(ContestRound, admin.site).has_delete_permission(None, self.round)
        )
        for readonly_admin_class, readonly_model, instance in (
            (ScoreRecordAdmin, ScoreRecord, self.score),
            (CriterionScoreAdmin, CriterionScore, self.criterion_score),
            (ScoreSummaryAdmin, ScoreSummary, None),
            (AwardAdmin, Award, self.award),
            (RulesetVersionAdmin, RulesetVersion, self.version),
        ):
            model_admin = readonly_admin_class(readonly_model, admin.site)
            with self.subTest(model=readonly_model.__name__):
                self.assertFalse(model_admin.has_add_permission(None))
                self.assertFalse(model_admin.has_change_permission(None, instance))
                self.assertFalse(model_admin.has_delete_permission(None, instance))
        for admin_class, canonical_model, fixture_name, readonly_fields in ADMIN_CANONICAL_MATRIX:
            canonical_admin = admin_class(canonical_model, admin.site)
            instance = getattr(self, fixture_name)
            with self.subTest(model=canonical_model.__name__):
                self.assertEqual(
                    canonical_admin.get_readonly_fields(request, instance), readonly_fields
                )
                self.assertTrue(canonical_admin.has_add_permission(request))
                self.assertTrue(canonical_admin.has_change_permission(request, instance))
                self.assertTrue(canonical_admin.has_delete_permission(request, instance))

    def test_documented_authority_services_succeed(self):
        change_user_role(target=self.operator, new_role=User.Role.STAFF, actor=self.admin_user)
        self.operator.refresh_from_db()
        self.assertEqual(self.operator.role, User.Role.STAFF)
        transitioned = transition_activity_phase(
            self.activity, Activity.Phase.TESTING, actor=self.admin_user, note="matrix"
        )
        self.assertEqual(transitioned.phase, Activity.Phase.TESTING)
        prepared_round = prepare_round(self.round, self.admin_user)
        self.assertEqual(prepared_round.status, ContestRound.Status.PREPARED)
        changes = apply_scores(
            self.round,
            {(self.singer.pk, self.judge.pk): Decimal("91")},
            self.admin_user,
            note="matrix",
        )
        self.assertEqual(len(changes), 1)
        locked_round = lock_round(self.round, self.admin_user)
        self.assertTrue(locked_round.is_locked)
        locked_vote = lock_vote_session(self.vote_session, self.admin_user)
        self.assertTrue(locked_vote.is_locked)
        draft_version = create_ruleset_version(
            self.ruleset,
            definition='{"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]}',
            created_by=self.admin_user,
            binding={},
        )
        frozen_version = freeze_ruleset_version(draft_version, self.admin_user, binding={})
        self.assertEqual(frozen_version.status, RulesetVersion.Status.FROZEN)
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=self.activity.pk).update(
                phase=Activity.Phase.RESULTS_PENDING
            )
        resolved_stage = run_ruleset(
            frozen_version,
            self.activity,
            stage_key="matrix-service-stage",
            computed_by=self.admin_user,
            round_keys={},
            preview=False,
        )
        self.assertIsInstance(resolved_stage, StageResult)
        resolved_stage = cast(StageResult, resolved_stage)
        self.assertEqual(resolved_stage.status, StageResult.Status.READY_TO_CONFIRM)
        confirmed_stage = confirm_stage_result(resolved_stage, confirmed_by=self.admin_user)
        self.assertEqual(confirmed_stage.status, StageResult.Status.CONFIRMED)
        self.assertTrue(
            AuditLog.objects.filter(
                target=f"ContestRound:{self.round.pk}", action_type=AuditLog.ActionType.ENTER_SCORE
            ).exists()
        )
        self.assertTrue(
            AuditLog.objects.filter(
                target=f"VoteSession:{self.vote_session.pk}",
                action_type=AuditLog.ActionType.RELOCK_RESULT,
            ).exists()
        )
        self.assertTrue(
            AuditLog.objects.filter(
                target=f"RulesetVersion:{frozen_version.pk}",
                action_type=AuditLog.ActionType.FINALIZE_RULESET,
            ).exists()
        )
        self.assertTrue(
            AuditLog.objects.filter(
                target=f"StageResult:{confirmed_stage.pk}",
                action_type=AuditLog.ActionType.CONFIRM_STAGE_RESULT,
            ).exists()
        )

    def test_terminal_services_reject_current_non_admin_authority(self):
        from singer_contest.services import finalize_advancement
        from voting.services import unlock_vote_session

        with self.assertRaises(PermissionDenied):
            require_current_admin(self.staff_user)
        with self.assertRaises(PermissionDenied):
            transition_activity_phase(self.activity, Activity.Phase.TESTING, actor=self.staff_user)
        with self.assertRaises(PermissionDenied):
            finalize_advancement(self.round, [], self.staff_user)
        with self.assertRaises(PermissionDenied):
            confirm_stage_result(self.stage, confirmed_by=self.staff_user)
        with self.assertRaises(PermissionDenied):
            unlock_vote_session(self.vote_session, self.staff_user)


def _user_row(case):
    case.admin_user.role = User.Role.PARTICIPANT
    case._assert_rejects(lambda: case.admin_user.save(update_fields=["role"]))
    case._assert_rejects(
        lambda: User.objects.filter(pk=case.admin_user.pk).update(role=User.Role.PARTICIPANT)
    )
    case._assert_rejects(
        lambda: User._base_manager.filter(pk=case.admin_user.pk).update(role=User.Role.PARTICIPANT)
    )
    case.admin_user.role = User.Role.PARTICIPANT
    case._assert_rejects(lambda: User.objects.bulk_update([case.admin_user], ["role"]))


def _activity_row(case):
    case._assert_rejects(
        lambda: Activity.objects.filter(pk=case.activity.pk).update(phase=Activity.Phase.LIVE)
    )
    case._assert_rejects(
        lambda: Activity._base_manager.filter(pk=case.activity.pk).update(phase=Activity.Phase.LIVE)
    )
    case.activity.phase = Activity.Phase.LIVE
    case._assert_rejects(lambda: case.activity.save(update_fields=["phase"]))
    case.activity.phase = Activity.Phase.LIVE
    case._assert_rejects(lambda: Activity.objects.bulk_update([case.activity], ["phase"]))


def _round_row(case):
    case._assert_rejects(
        lambda: ContestRound.objects.filter(pk=case.round.pk).update(
            status=ContestRound.Status.LOCKED
        )
    )
    case._assert_rejects(
        lambda: ContestRound._base_manager.filter(pk=case.round.pk).update(
            status=ContestRound.Status.LOCKED
        )
    )
    case.round.status = ContestRound.Status.LOCKED
    case._assert_rejects(lambda: case.round.save(update_fields=["status"]))
    case.round.status = ContestRound.Status.LOCKED
    case._assert_rejects(lambda: ContestRound.objects.bulk_update([case.round], ["status"]))


def _vote_session_row(case):
    case._assert_rejects(
        lambda: VoteSession.objects.filter(pk=case.vote_session.pk).update(is_open=True)
    )
    case._assert_rejects(
        lambda: VoteSession._base_manager.filter(pk=case.vote_session.pk).update(is_open=True)
    )
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
    case._assert_rejects(
        lambda: StageResult.objects.filter(pk=case.stage.pk).update(stage_key="changed")
    )
    case._assert_rejects(
        lambda: StageResult._base_manager.filter(pk=case.stage.pk).update(stage_key="changed")
    )
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
        lambda: Award._base_manager.filter(pk=case.award.pk).update(
            source_stage_result_id=case.stage.pk
        )
    )


def _singer(case):
    _identity_row(case, SingerRegistration, case.singer, "activity_id", case.other_activity.pk)
    case.singer.refresh_from_db()
    _identity_row(case, SingerRegistration, case.singer, "user_id", case.other_user.pk)


def _judge(case):
    _identity_row(case, Judge, case.judge, "activity_id", case.other_activity.pk)


def _ruleset_version(case):
    case._assert_rejects(
        lambda: RulesetVersion.objects.filter(pk=case.version.pk).update(
            definition='{"schema_version": 1, "nodes": []}'
        )
    )
    case._assert_rejects(
        lambda: RulesetVersion._base_manager.filter(pk=case.version.pk).update(version=2)
    )
    case.version.version = 2
    case._assert_rejects(lambda: case.version.save(update_fields=["version"]))
    case._assert_rejects(lambda: RulesetVersion.objects.bulk_update([case.version], ["version"]))
    case._assert_rejects(case.version.delete)


def _score_bulk_and_delete(case):
    case._lock_round()
    case._assert_rejects(
        lambda: ScoreRecord.objects.bulk_create(
            [
                ScoreRecord(
                    round=case.round,
                    singer=case.spare_singer,
                    judge=case.judge,
                    score=Decimal("80"),
                    is_test_data=True,
                )
            ]
        )
    )
    case._assert_rejects(lambda: ScoreRecord.objects.filter(pk=case.score.pk).delete())


def _activity_bulk_and_delete(case):
    case._assert_rejects(
        lambda: Activity.objects.bulk_create(
            [
                Activity(
                    title="bulk activity",
                    activity_type=Activity.Type.SINGER_CONTEST,
                    phase=Activity.Phase.LIVE,
                )
            ]
        )
    )
    with authority_write(ACTIVITY_STATE):
        Activity.objects.filter(pk=case.other_activity.pk).update(phase=Activity.Phase.LIVE)
    case._assert_rejects(lambda: Activity.objects.filter(pk=case.other_activity.pk).delete())


def _round_bulk_and_delete(case):
    case._assert_rejects(
        lambda: ContestRound.objects.bulk_create(
            [
                ContestRound(
                    activity=case.activity,
                    round_type=ContestRound.RoundType.PRELIMINARY,
                    status=ContestRound.Status.LOCKED,
                    is_locked=True,
                )
            ]
        )
    )
    case._lock_round()
    case._assert_rejects(lambda: ContestRound.objects.filter(pk=case.round.pk).delete())


def _vote_session_bulk_and_delete(case):
    case._assert_rejects(
        lambda: VoteSession.objects.bulk_create(
            [
                VoteSession(
                    activity=case.activity,
                    name="bulk vote",
                    passcode="345678",
                    start_time=timezone.now(),
                    end_time=timezone.now() + timedelta(hours=1),
                    is_locked=True,
                    is_test_data=True,
                )
            ]
        )
    )
    case._lock_vote()
    case._assert_rejects(lambda: VoteSession.objects.filter(pk=case.vote_session.pk).delete())


def _summary_bulk_and_delete(case):
    with authority_write(SCORE_SUMMARY_RECALCULATE):
        summary = ScoreSummary.objects.create(
            round=case.round, singer=case.singer, average_score=Decimal("90"), is_test_data=True
        )
    case._assert_rejects(
        lambda: ScoreSummary.objects.bulk_create(
            [
                ScoreSummary(
                    round=case.round,
                    singer=case.spare_singer,
                    average_score=Decimal("80"),
                    is_test_data=True,
                )
            ]
        )
    )
    case._assert_rejects(lambda: ScoreSummary.objects.filter(pk=summary.pk).delete())


def _audience_bulk_and_delete(case):
    case._confirm_stage()
    case._assert_rejects(
        lambda: AudienceScore.objects.bulk_create(
            [
                AudienceScore(
                    activity=case.activity,
                    stage_key="matrix-audience",
                    singer=case.spare_singer,
                    score=Decimal("80"),
                    is_test_data=True,
                )
            ]
        )
    )
    case._assert_rejects(lambda: AudienceScore.objects.filter(pk=case.audience.pk).delete())


def _option_bulk_and_delete(case):
    case._lock_vote()
    case._assert_rejects(
        lambda: VoteOption.objects.bulk_create(
            [
                VoteOption(
                    vote_session=case.vote_session, singer=case.spare_singer, is_test_data=True
                )
            ]
        )
    )
    case._assert_rejects(lambda: VoteOption.objects.filter(pk=case.option.pk).delete())


def _ballot_bulk_and_delete(case):
    case._lock_vote()
    case._assert_rejects(
        lambda: VoteBallot.objects.bulk_create(
            [
                VoteBallot(
                    vote_session=case.vote_session,
                    browser_session_key="bulk-browser",
                    ip_address="127.0.0.1",
                    is_test_data=True,
                )
            ]
        )
    )
    case._assert_rejects(lambda: VoteBallot.objects.filter(pk=case.ballot.pk).delete())


def _record_bulk_and_delete(case):
    case._lock_vote()
    case._assert_rejects(
        lambda: VoteRecord.objects.bulk_create(
            [
                VoteRecord(
                    ballot=case.ballot,
                    vote_session=case.vote_session,
                    vote_option=case.option,
                    browser_session_key="bulk-browser",
                    ip_address="127.0.0.1",
                    is_test_data=True,
                )
            ]
        )
    )
    case._assert_rejects(lambda: VoteRecord.objects.filter(pk=case.record.pk).delete())


def _group_bulk_and_delete(case):
    case._lock_round()
    case._assert_rejects(
        lambda: PerformanceGroup.objects.bulk_create(
            [
                PerformanceGroup(
                    activity=case.activity, round=case.round, name="bulk", is_test_data=True
                )
            ]
        )
    )
    case._assert_rejects(lambda: PerformanceGroup.objects.filter(pk=case.group.pk).delete())


def _performance_bulk_and_delete(case):
    case._lock_round()
    case._assert_rejects(
        lambda: Performance.objects.bulk_create(
            [
                Performance(
                    activity=case.activity,
                    round=case.round,
                    singer=case.spare_singer,
                    group=case.group,
                    is_test_data=True,
                )
            ]
        )
    )
    case._assert_rejects(lambda: Performance.objects.filter(pk=case.performance.pk).delete())


def _criterion_bulk_and_delete(case):
    case._lock_round()
    case._assert_rejects(
        lambda: RubricCriterion.objects.bulk_create(
            [
                RubricCriterion(
                    rubric=case.rubric,
                    name="Bulk criterion",
                    max_score=Decimal("100"),
                    is_test_data=True,
                )
            ]
        )
    )
    case._assert_rejects(lambda: RubricCriterion.objects.filter(pk=case.criterion.pk).delete())


def _criterion_score_bulk_and_delete(case):
    case._lock_round()
    case._assert_rejects(
        lambda: CriterionScore.objects.bulk_create(
            [
                CriterionScore(
                    score_record=case.score,
                    criterion=case.criterion,
                    value=Decimal("80"),
                    is_test_data=True,
                )
            ]
        )
    )
    case._assert_rejects(lambda: CriterionScore.objects.filter(pk=case.criterion_score.pk).delete())


def _stage_bulk_and_delete(case):
    case._confirm_stage()
    case._assert_rejects(
        lambda: StageResult.objects.bulk_create(
            [
                StageResult(
                    activity=case.activity,
                    ruleset_version=case.version,
                    stage_key="bulk-stage",
                    status=StageResult.Status.CONFIRMED,
                    is_test_data=True,
                )
            ]
        )
    )
    case._assert_rejects(lambda: StageResult.objects.filter(pk=case.stage.pk).delete())


def _stage_decision_bulk_and_delete(case):
    case._confirm_stage()
    case._assert_rejects(
        lambda: StageDecision.objects.bulk_create(
            [
                StageDecision(
                    stage_result=case.stage,
                    singer=case.spare_singer,
                    outcome_code="selected",
                    is_test_data=True,
                )
            ]
        )
    )
    case._assert_rejects(lambda: StageDecision.objects.filter(pk=case.decision.pk).delete())


def _stage_award_bulk_and_delete(case):
    case._confirm_stage()
    case._assert_rejects(
        lambda: StageAwardDecision.objects.bulk_create(
            [
                StageAwardDecision(
                    stage_result=case.stage,
                    activity=case.activity,
                    singer=case.spare_singer,
                    name="Bulk award",
                    is_test_data=True,
                )
            ]
        )
    )
    case._assert_rejects(
        lambda: StageAwardDecision.objects.filter(pk=case.award_decision.pk).delete()
    )


def _composite_bulk_and_delete(case):
    case._confirm_stage()
    case._assert_rejects(
        lambda: CompositeResult.objects.bulk_create(
            [
                CompositeResult(
                    stage_result=case.stage,
                    singer=case.spare_singer,
                    node_key="bulk-node",
                    value=Decimal("80"),
                    is_test_data=True,
                )
            ]
        )
    )
    case._assert_rejects(lambda: CompositeResult.objects.filter(pk=case.composite.pk).delete())


def _ruleset_bulk_and_delete(case):
    case._assert_rejects(
        lambda: RulesetVersion.objects.bulk_create(
            [
                RulesetVersion(
                    ruleset=case.ruleset,
                    version=2,
                    definition='{"schema_version": 1, "nodes": [{"key": "r", "type": "ROSTER"}]}',
                    status=RulesetVersion.Status.FROZEN,
                    is_current=True,
                )
            ]
        )
    )
    case._assert_rejects(lambda: RulesetVersion.objects.filter(pk=case.version.pk).delete())


def _award_bulk_and_delete(case):
    with _authorized_award_materialization():
        sourced = Award.objects.create(
            activity=case.activity,
            singer=case.singer,
            name="Sourced matrix award",
            source_stage_result=case.stage,
            is_test_data=True,
        )
    case._assert_rejects(
        lambda: Award.objects.bulk_create(
            [
                Award(
                    activity=case.activity,
                    singer=case.singer,
                    name="Unauthorized sourced award",
                    source_stage_result=case.stage,
                    is_test_data=True,
                )
            ]
        )
    )
    case._assert_rejects(lambda: Award.objects.filter(pk=sourced.pk).delete())


BULK_DELETE_MATRIX = (
    BulkDeleteDescriptor("Activity", Activity, _activity_bulk_and_delete),
    BulkDeleteDescriptor("ContestRound", ContestRound, _round_bulk_and_delete),
    BulkDeleteDescriptor("VoteSession", VoteSession, _vote_session_bulk_and_delete),
    BulkDeleteDescriptor("ScoreRecord", ScoreRecord, _score_bulk_and_delete),
    BulkDeleteDescriptor("ScoreSummary", ScoreSummary, _summary_bulk_and_delete),
    BulkDeleteDescriptor("AudienceScore", AudienceScore, _audience_bulk_and_delete),
    BulkDeleteDescriptor("VoteOption", VoteOption, _option_bulk_and_delete),
    BulkDeleteDescriptor("VoteBallot", VoteBallot, _ballot_bulk_and_delete),
    BulkDeleteDescriptor("VoteRecord", VoteRecord, _record_bulk_and_delete),
    BulkDeleteDescriptor("PerformanceGroup", PerformanceGroup, _group_bulk_and_delete),
    BulkDeleteDescriptor("Performance", Performance, _performance_bulk_and_delete),
    BulkDeleteDescriptor("RubricCriterion", RubricCriterion, _criterion_bulk_and_delete),
    BulkDeleteDescriptor("CriterionScore", CriterionScore, _criterion_score_bulk_and_delete),
    BulkDeleteDescriptor("StageResult", StageResult, _stage_bulk_and_delete),
    BulkDeleteDescriptor("StageDecision", StageDecision, _stage_decision_bulk_and_delete),
    BulkDeleteDescriptor("StageAwardDecision", StageAwardDecision, _stage_award_bulk_and_delete),
    BulkDeleteDescriptor("CompositeResult", CompositeResult, _composite_bulk_and_delete),
    BulkDeleteDescriptor("RulesetVersion", RulesetVersion, _ruleset_bulk_and_delete),
    BulkDeleteDescriptor("Award", Award, _award_bulk_and_delete),
)


def _factory(fixture_name: str) -> Callable[[AuthorityMutationMatrixTests], Any]:
    return lambda case: getattr(case, fixture_name)


def _mutation(
    path: str, check: Callable[[AuthorityMutationMatrixTests], None]
) -> MutationDescriptor:
    return MutationDescriptor(path, lambda case, _instance: check(case))


def _descriptor(
    name: str,
    model: type,
    owner: str,
    fixture_name: str,
    *mutations: MutationDescriptor,
) -> AuthorityDescriptor:
    return AuthorityDescriptor(
        name=name,
        model=model,
        owner=owner,
        factory=_factory(fixture_name),
        mutations=mutations,
    )


MODEL_MATRIX = (
    _descriptor(
        "User",
        User,
        "accounts.change_user_role",
        "admin_user",
        _mutation("protected instance/queryset/base-manager/bulk", _user_row),
    ),
    _descriptor(
        "Activity",
        Activity,
        "core activity lifecycle",
        "activity",
        _mutation("protected instance/queryset/base-manager/bulk", _activity_row),
    ),
    _descriptor(
        "ContestRound",
        ContestRound,
        "round lifecycle",
        "round",
        _mutation("protected instance/queryset/base-manager/bulk", _round_row),
    ),
    _descriptor(
        "VoteSession",
        VoteSession,
        "vote session lifecycle",
        "vote_session",
        _mutation("protected instance/queryset/base-manager/bulk", _vote_session_row),
    ),
    _descriptor(
        "ScoreRecord",
        ScoreRecord,
        "raw score authority",
        "score",
        _mutation("protected instance/queryset/base-manager/bulk/FK", _score_record),
    ),
    _descriptor(
        "ScoreSummary",
        ScoreSummary,
        "score recalculation",
        "score",
        _mutation("protected instance/queryset/base-manager/bulk/delete", _score_summary),
    ),
    _descriptor(
        "AudienceScore",
        AudienceScore,
        "unconsumed audience fact",
        "audience",
        _mutation("protected instance/queryset/base-manager/bulk/delete", _audience_score),
    ),
    _descriptor(
        "VoteOption",
        VoteOption,
        "unlocked vote session",
        "option",
        _mutation("protected instance/queryset/base-manager/bulk/FK/delete", _vote_option),
    ),
    _descriptor(
        "VoteBallot",
        VoteBallot,
        "unlocked vote session",
        "ballot",
        _mutation("protected instance/queryset/base-manager/bulk/FK/delete", _vote_ballot),
    ),
    _descriptor(
        "VoteRecord",
        VoteRecord,
        "unlocked vote session",
        "record",
        _mutation("protected instance/queryset/base-manager/bulk/FK/delete", _vote_record),
    ),
    _descriptor(
        "PerformanceGroup",
        PerformanceGroup,
        "round configuration",
        "group",
        _mutation("protected instance/queryset/base-manager/bulk/delete", _performance_group),
    ),
    _descriptor(
        "Performance",
        Performance,
        "round configuration",
        "performance",
        _mutation("protected instance/queryset/base-manager/bulk/delete", _performance),
    ),
    _descriptor(
        "RubricCriterion",
        RubricCriterion,
        "rubric configuration",
        "criterion",
        _mutation("protected instance/queryset/base-manager/bulk/FK/delete", _criterion),
    ),
    _descriptor(
        "CriterionScore",
        CriterionScore,
        "raw score authority",
        "criterion_score",
        _mutation("protected instance/queryset/base-manager/bulk/delete", _criterion_score),
    ),
    _descriptor(
        "StageResult",
        StageResult,
        "stage confirmation",
        "stage",
        _mutation("protected instance/queryset/base-manager/bulk/delete", _stage_result),
    ),
    _descriptor(
        "StageDecision",
        StageDecision,
        "stage result authority",
        "decision",
        _mutation("protected instance/queryset/base-manager/bulk/delete", _stage_decision),
    ),
    _descriptor(
        "StageAwardDecision",
        StageAwardDecision,
        "stage result authority",
        "award_decision",
        _mutation("protected instance/queryset/base-manager/bulk/delete", _stage_award_decision),
    ),
    _descriptor(
        "CompositeResult",
        CompositeResult,
        "stage result authority",
        "composite",
        _mutation("protected instance/queryset/base-manager/bulk/delete", _composite),
    ),
    _descriptor(
        "Award",
        Award,
        "award materialization",
        "award",
        _mutation("provenance instance/queryset", _award),
    ),
    _descriptor(
        "SingerRegistration",
        SingerRegistration,
        "identity ownership",
        "singer",
        _mutation("immutable identity instance/queryset/base-manager/bulk/FK", _singer),
    ),
    _descriptor(
        "Judge",
        Judge,
        "identity ownership",
        "judge",
        _mutation("immutable identity instance/queryset/base-manager/bulk/FK", _judge),
    ),
    _descriptor(
        "RulesetVersion",
        RulesetVersion,
        "ruleset freeze",
        "version",
        _mutation("protected instance/queryset/base-manager/bulk/delete", _ruleset_version),
    ),
)


ADMIN_CANONICAL_MATRIX = (
    (RubricCriterionAdmin, RubricCriterion, "criterion", ()),
    (ScoringRubricAdmin, ScoringRubric, "rubric", ()),
)
