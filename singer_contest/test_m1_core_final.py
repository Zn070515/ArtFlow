from datetime import timedelta
from decimal import Decimal

from accounts.models import User
from common.authority import (
    CONTEST_ROUND_STATE,
    SCORE_SUMMARY_RECALCULATE,
    VOTE_SESSION_STATE,
    authority_write,
)
from core.models import Activity
from django.contrib import admin
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models.deletion import ProtectedError
from django.test import RequestFactory, TestCase
from django.utils import timezone
from voting.models import VoteBallot, VoteOption, VoteSession

from .models import (
    Award,
    ContestRound,
    Judge,
    ScoreRecord,
    ScoreSummary,
    SingerRegistration,
    StageResult,
)


class M1CoreFinalAuthorityTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="m1-singer", password="pass")
        self.activity = Activity.objects.create(
            title="M1 Activity", activity_type=Activity.Type.SINGER_CONTEST
        )
        self.other_activity = Activity.objects.create(
            title="M1 Other", activity_type=Activity.Type.SINGER_CONTEST
        )
        self.round = ContestRound.objects.create(
            activity=self.activity, round_type=ContestRound.RoundType.PRELIMINARY
        )
        self.other_round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
            sequence=2,
        )
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.user,
            name="M1 Singer",
            student_id="m1-001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.judge = Judge.objects.create(activity=self.activity, name="M1 Judge")

    def test_activity_state_cannot_be_changed_by_direct_save_or_queryset(self):
        self.activity.phase = Activity.Phase.LIVE
        with self.assertRaises(ValidationError):
            self.activity.save(update_fields=["phase"])

        with self.assertRaises(ValidationError):
            Activity.objects.filter(pk=self.activity.pk).update(is_locked=True)

    def test_round_state_and_prepared_configuration_require_authority(self):
        self.round.status = ContestRound.Status.PREPARED
        with self.assertRaises(ValidationError):
            self.round.save(update_fields=["status"])
        with authority_write(CONTEST_ROUND_STATE):
            self.round.save(update_fields=["status"])

        self.round.name = "Changed after preparation"
        with self.assertRaises(ValidationError):
            self.round.save(update_fields=["name"])
        with self.assertRaises(ValidationError):
            ContestRound.objects.filter(pk=self.round.pk).update(name="ORM bypass")

    def test_vote_session_state_cannot_be_changed_by_direct_save_or_queryset(self):
        now = timezone.now()
        session = VoteSession.objects.create(
            activity=self.activity,
            name="State",
            passcode="state",
            start_time=now - timedelta(minutes=1),
            end_time=now + timedelta(minutes=10),
        )
        session.is_open = True
        with self.assertRaises(ValidationError):
            session.save(update_fields=["is_open"])
        with self.assertRaises(ValidationError):
            VoteSession.objects.filter(pk=session.pk).update(is_open=True)

        session.is_locked = True
        with authority_write(VOTE_SESSION_STATE):
            session.save(update_fields=["is_locked"])
        session.name = "Changed after lock"
        with self.assertRaises(ValidationError):
            session.save(update_fields=["name"])
        with self.assertRaises(ValidationError):
            VoteSession.objects.filter(pk=session.pk).update(name="ORM bypass")
        session.activity = self.other_activity
        with self.assertRaises(ValidationError):
            session.save(update_fields=["activity"])
        with self.assertRaises(ValidationError):
            VoteSession.objects.filter(pk=session.pk).update(activity=self.other_activity)

    def test_score_record_cannot_move_from_locked_round_to_draft_round(self):
        record = ScoreRecord.objects.create(
            round=self.round, singer=self.singer, judge=self.judge, score=Decimal("90")
        )
        self.round.status = ContestRound.Status.LOCKED
        self.round.is_locked = True
        with authority_write(CONTEST_ROUND_STATE):
            self.round.save(update_fields=["status", "is_locked"])
        record.round = self.other_round

        with self.assertRaises(ValidationError):
            record.save(update_fields=["round"])

    def test_vote_ballot_cannot_move_from_locked_session_to_open_session(self):
        now = timezone.now()
        old_session = VoteSession.objects.create(
            activity=self.activity,
            name="Old",
            passcode="old",
            start_time=now - timedelta(minutes=1),
            end_time=now + timedelta(minutes=10),
        )
        new_session = VoteSession.objects.create(
            activity=self.activity,
            name="New",
            passcode="new",
            start_time=now - timedelta(minutes=1),
            end_time=now + timedelta(minutes=10),
        )
        ballot = VoteBallot.objects.create(
            vote_session=old_session,
            browser_session_key="m1-browser",
            ip_address="192.0.2.1",
        )
        old_session.is_locked = True
        with authority_write(VOTE_SESSION_STATE):
            old_session.save(update_fields=["is_locked"])
        ballot.vote_session = new_session

        with self.assertRaises(ValidationError):
            ballot.save(update_fields=["vote_session"])

    def test_locked_vote_option_cannot_be_deleted(self):
        now = timezone.now()
        session = VoteSession.objects.create(
            activity=self.activity,
            name="Options",
            passcode="options",
            start_time=now - timedelta(minutes=1),
            end_time=now + timedelta(minutes=10),
        )
        option = VoteOption.objects.create(vote_session=session, singer=self.singer)
        session.is_locked = True
        with authority_write(VOTE_SESSION_STATE):
            session.save(update_fields=["is_locked"])

        with self.assertRaises(ValidationError):
            option.delete()

    def test_score_summary_is_not_directly_mutable(self):
        with authority_write(SCORE_SUMMARY_RECALCULATE):
            summary = ScoreSummary.objects.create(
                round=self.round, singer=self.singer, average_score=90, rank=1
            )

        with self.assertRaises(ValidationError):
            summary.save(update_fields=["rank"])
        with self.assertRaises(ValidationError):
            ScoreSummary.objects.filter(pk=summary.pk).update(rank=2)

    def test_award_provenance_can_only_be_attached_by_materialization(self):
        from ruleset.models import ContestRuleset, RulesetVersion

        ruleset = ContestRuleset.objects.create(
            activity=self.activity, name="M1 Ruleset", is_test_data=True
        )
        version = RulesetVersion.objects.create(
            ruleset=ruleset,
            version=1,
            status=RulesetVersion.Status.DRAFT,
            definition={"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
            authority_hash="m1-award-hash",
        )
        stage = StageResult.objects.create(
            activity=self.activity,
            ruleset_version=version,
            stage_key="m1-award",
            status=StageResult.Status.READY_TO_CONFIRM,
            is_test_data=True,
        )
        award = Award.objects.create(
            activity=self.activity,
            singer=self.singer,
            name="Manual award",
            is_test_data=True,
        )

        with self.assertRaises(ValidationError):
            Award.objects.filter(pk=award.pk).update(source_stage_result=stage)

        award.source_stage_result = stage
        with self.assertRaises(ValidationError):
            Award.objects.bulk_update([award], ["source_stage_result"])

    def test_round_sequence_is_unique_per_activity_when_explicitly_configured(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.SEMI_FINAL,
                sequence=self.round.sequence,
            )

    def test_protected_models_use_their_guarded_default_manager_as_base_manager(self):
        from ruleset.models import RulesetVersion
        from voting.models import VoteBallot, VoteOption, VoteRecord, VoteSession

        from .models import (
            AudienceScore,
            Award,
            CompositeResult,
            CriterionScore,
            Performance,
            PerformanceGroup,
            RubricCriterion,
            StageAwardDecision,
            StageDecision,
            StageResult,
        )

        protected_models = [
            ContestRound,
            ScoreRecord,
            ScoreSummary,
            AudienceScore,
            Award,
            PerformanceGroup,
            Performance,
            RubricCriterion,
            CriterionScore,
            StageResult,
            StageDecision,
            StageAwardDecision,
            CompositeResult,
            RulesetVersion,
            VoteSession,
            VoteOption,
            VoteBallot,
            VoteRecord,
        ]
        for model in protected_models:
            self.assertEqual(model._meta.base_manager_name, "objects")
            self.assertIs(model._base_manager.model, model)


class AdminAuthoritySurfaceTests(TestCase):
    def setUp(self):
        self.request = RequestFactory().get("/admin/")
        self.request.user = User.objects.create_superuser(
            "authority-surface-admin", "authority@example.com", "pass"
        )

    def assert_observation_only(self, model):
        model_admin = admin.site._registry.get(model)
        self.assertIsNotNone(model_admin, f"{model.__name__} must be observable in Admin")
        self.assertTrue(model_admin.has_view_permission(self.request))
        self.assertFalse(model_admin.has_add_permission(self.request))
        self.assertFalse(model_admin.has_change_permission(self.request))
        self.assertFalse(model_admin.has_delete_permission(self.request))

    def assert_editable_metadata(self, model):
        model_admin = admin.site._registry[model]
        self.assertTrue(model_admin.has_add_permission(self.request))
        self.assertTrue(model_admin.has_change_permission(self.request))
        self.assertTrue(model_admin.has_delete_permission(self.request))

    def test_raw_and_derived_contest_facts_are_observation_only(self):
        from .models import CriterionScore, RoundEntry, RoundJudge

        for model in (
            ContestRound,
            RoundEntry,
            RoundJudge,
            ScoreRecord,
            CriterionScore,
            ScoreSummary,
            Award,
        ):
            with self.subTest(model=model.__name__):
                self.assert_observation_only(model)

    def test_contest_profile_and_rubric_metadata_remain_editable(self):
        from .models import RubricCriterion, ScoringRubric

        for model in (SingerRegistration, Judge, ScoringRubric, RubricCriterion):
            with self.subTest(model=model.__name__):
                self.assert_editable_metadata(model)

    def test_activity_authority_is_service_only_but_presentation_metadata_remains_editable(self):
        from core.admin import ActivityAdmin

        activity_admin = ActivityAdmin(Activity, admin.site)
        self.assertFalse(activity_admin.has_add_permission(self.request))
        self.assertTrue(activity_admin.has_change_permission(self.request))
        self.assertFalse(activity_admin.has_delete_permission(self.request))
        self.assertEqual(
            set(activity_admin.get_readonly_fields(self.request)),
            {"phase", "is_test_mode", "data_lifecycle", "is_locked", "locked_at", "locked_by"},
        )

    def test_vote_authority_and_raw_vote_facts_are_observation_only(self):
        from voting.models import VoteRecord

        for model in (VoteSession, VoteOption, VoteBallot, VoteRecord):
            with self.subTest(model=model.__name__):
                self.assert_observation_only(model)

    def test_file_facts_are_observation_only_but_operational_metadata_remains_editable(self):
        from files.models import MaterialCheck, MaterialRequirement, StaffNote, SubmissionFile

        for model in (SubmissionFile, MaterialCheck):
            with self.subTest(model=model.__name__):
                self.assert_observation_only(model)
        for model in (StaffNote, MaterialRequirement):
            with self.subTest(model=model.__name__):
                self.assert_editable_metadata(model)


class ContestRoundCreationAuthorityTests(TestCase):
    def setUp(self):
        self.activity = Activity.objects.create(
            title="Round creation", activity_type=Activity.Type.SINGER_CONTEST
        )

    def test_round_creation_rejects_non_initial_state_through_both_managers(self):
        for manager, sequence in (
            (ContestRound.objects, 1),
            (ContestRound._base_manager, 2),
        ):
            with self.subTest(manager=manager.name):
                with self.assertRaises(ValidationError):
                    manager.create(
                        activity=self.activity,
                        round_type=ContestRound.RoundType.PRELIMINARY,
                        sequence=sequence,
                        status=ContestRound.Status.LOCKED,
                        is_locked=True,
                    )
                self.assertFalse(
                    ContestRound.objects.filter(activity=self.activity, sequence=sequence).exists()
                )

    def test_round_bulk_create_rejects_scoring_initial_state_through_both_managers(self):
        for manager, sequence in (
            (ContestRound.objects, 1),
            (ContestRound._base_manager, 2),
        ):
            with self.subTest(manager=manager.name):
                with self.assertRaises(ValidationError):
                    manager.bulk_create(
                        [
                            ContestRound(
                                activity=self.activity,
                                round_type=ContestRound.RoundType.PRELIMINARY,
                                sequence=sequence,
                                status=ContestRound.Status.SCORING,
                            )
                        ]
                    )
                self.assertFalse(
                    ContestRound.objects.filter(activity=self.activity, sequence=sequence).exists()
                )

    def test_round_bulk_create_update_conflicts_rejects_state_change(self):
        contest_round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            sequence=1,
        )

        with self.assertRaises(ValidationError):
            ContestRound.objects.bulk_create(
                [
                    ContestRound(
                        activity=self.activity,
                        round_type=contest_round.round_type,
                        sequence=contest_round.sequence,
                        status=ContestRound.Status.SCORING,
                    )
                ],
                update_conflicts=True,
                update_fields=["status"],
                unique_fields=["activity", "sequence"],
            )

        contest_round.refresh_from_db()
        self.assertEqual(contest_round.status, ContestRound.Status.DRAFT)

    def test_round_bulk_create_update_conflicts_rejects_prepared_configuration_change(self):
        contest_round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            sequence=1,
            name="Original",
        )
        with authority_write(CONTEST_ROUND_STATE):
            ContestRound.objects.filter(pk=contest_round.pk).update(
                status=ContestRound.Status.PREPARED
            )

        with self.assertRaises(ValidationError):
            ContestRound.objects.bulk_create(
                [
                    ContestRound(
                        activity=self.activity,
                        round_type=contest_round.round_type,
                        sequence=contest_round.sequence,
                        name="Bypass",
                    )
                ],
                update_conflicts=True,
                update_fields=["name"],
                unique_fields=["activity", "sequence"],
            )

        contest_round.refresh_from_db()
        self.assertEqual(contest_round.name, "Original")


class ContestRoundDeletionAuthorityTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="round-delete", password="pass")
        self.activity = Activity.objects.create(
            title="Round delete", activity_type=Activity.Type.SINGER_CONTEST
        )

    def _round(self, sequence):
        return ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            sequence=sequence,
        )

    def test_round_delete_rejects_non_draft_and_unauthorized_manager_paths(self):
        direct = self._round(1)
        queryset = self._round(2)
        base_queryset = self._round(3)
        with authority_write(CONTEST_ROUND_STATE):
            ContestRound.objects.filter(pk=direct.pk).update(status=ContestRound.Status.PREPARED)

        with self.assertRaises(ValidationError):
            direct.delete()
        with self.assertRaises(ValidationError):
            ContestRound.objects.filter(pk=queryset.pk).delete()
        with self.assertRaises(ValidationError):
            ContestRound._base_manager.filter(pk=base_queryset.pk).delete()

        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), 3)

    def test_round_delete_preserves_prepared_child_protect(self):
        contest_round = self._round(1)
        singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.user,
            name="Round delete singer",
            student_id="round-delete-1",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        from .models import RoundEntry

        RoundEntry.objects.create(round=contest_round, singer=singer)
        with authority_write(CONTEST_ROUND_STATE):
            ContestRound.objects.filter(pk=contest_round.pk).update(
                status=ContestRound.Status.PREPARED
            )

        with authority_write("test_data.cleanup"):
            with self.assertRaises(ProtectedError):
                contest_round.delete()

        self.assertTrue(ContestRound.objects.filter(pk=contest_round.pk).exists())

    def test_prepared_round_admin_disables_delete(self):
        from .admin import ContestRoundAdmin

        contest_round = self._round(1)
        with authority_write(CONTEST_ROUND_STATE):
            ContestRound.objects.filter(pk=contest_round.pk).update(
                status=ContestRound.Status.PREPARED
            )
        contest_round.refresh_from_db()
        request = RequestFactory().get("/admin/singer_contest/contestround/")
        request.user = User.objects.create_superuser("round-delete-admin", "admin@example.com", "pass")

        self.assertFalse(
            ContestRoundAdmin(ContestRound, admin.site).has_delete_permission(request, contest_round)
        )
