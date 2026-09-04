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
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.test import TestCase
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
