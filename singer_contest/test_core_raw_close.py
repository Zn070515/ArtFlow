from decimal import Decimal

from accounts.models import User
from common.authority import RULESET_FREEZE, STAGE_RESULT_CONFIRM, authority_write
from core.models import Activity
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.utils import timezone
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.schema import parse_definition
from ruleset.templates import seed_ruleset_templates
from voting.models import VoteBallot, VoteOption, VoteSession
from voting.services import lock_vote_session

from singer_contest.models import (
    ContestRound,
    CriterionScore,
    Judge,
    Performance,
    PerformanceGroup,
    RubricCriterion,
    ScoreRecord,
    ScoringRubric,
    SingerRegistration,
    StageAwardDecision,
    StageResult,
)


class CoreRawAuthorityTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="raw-staff", password="pass")
        self.activity = Activity.objects.create(
            title="Raw authority",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REHEARSAL,
        )
        self.round = ContestRound.objects.create(activity=self.activity)
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.user,
            name="Singer",
            student_id="raw-1",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        self.judge = Judge.objects.create(activity=self.activity, name="Judge")
        self.record = ScoreRecord.objects.create(
            round=self.round,
            singer=self.singer,
            judge=self.judge,
            score=Decimal("90"),
            is_test_data=True,
        )

    def _lock_round(self):
        ContestRound._base_manager.filter(pk=self.round.pk).update(
            status=ContestRound.Status.LOCKED, is_locked=True
        )
        self.round.refresh_from_db()

    def test_score_record_cannot_be_changed_after_round_lock(self):
        self._lock_round()
        self.record.score = Decimal("10")
        with self.assertRaises(ValidationError):
            self.record.save()
        with self.assertRaises(ValidationError):
            ScoreRecord.objects.filter(pk=self.record.pk).update(score=Decimal("11"))

    def test_criterion_score_cannot_be_changed_after_round_lock(self):
        rubric = ScoringRubric.objects.create(activity=self.activity, name="Rubric")
        criterion = RubricCriterion.objects.create(
            rubric=rubric, name="Tone", max_score=Decimal("100")
        )
        self.round.rubric = rubric
        self.round.save(update_fields=["rubric"])
        criterion_score = CriterionScore.objects.create(
            score_record=self.record, criterion=criterion, value=Decimal("90")
        )
        self._lock_round()
        criterion_score.value = Decimal("10")
        with self.assertRaises(ValidationError):
            criterion_score.save()

    def test_locking_a_vote_session_does_not_create_an_award(self):
        session = VoteSession.objects.create(
            activity=self.activity,
            name="Selection vote",
            passcode="1234",
            start_time="2026-01-01T10:00:00Z",
            end_time="2026-01-01T11:00:00Z",
        )
        VoteOption.objects.create(vote_session=session, singer=self.singer)
        lock_vote_session(session, self.user)
        self.assertFalse(self.activity.awards.exists())

    def test_locked_vote_ballot_cannot_be_mutated_through_any_orm_path(self):
        session = VoteSession.objects.create(
            activity=self.activity,
            name="Ballot lock",
            passcode="1234",
            start_time="2026-01-01T10:00:00Z",
            end_time="2026-01-01T11:00:00Z",
        )
        ballot = VoteBallot.objects.create(
            vote_session=session,
            browser_session_key="browser-raw",
            ip_address="127.0.0.1",
        )
        session.is_locked = True
        session.is_open = False
        session.save(update_fields=["is_locked", "is_open"])
        ballot.ip_address = "127.0.0.2"
        with self.assertRaises(ValidationError):
            ballot.save()
        with self.assertRaises(ValidationError):
            VoteBallot.objects.filter(pk=ballot.pk).update(ip_address="127.0.0.3")

    def test_audience_score_rejects_foreign_singer(self):
        other = Activity.objects.create(
            title="Other activity",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REHEARSAL,
        )
        foreign = SingerRegistration.objects.create(
            activity=other,
            user=User.objects.create_user(username="foreign-singer"),
            name="Foreign",
            student_id="foreign-1",
            college="College",
            class_name="Class",
            phone="13800000001",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        from singer_contest.models import AudienceScore

        with self.assertRaises(ValidationError):
            AudienceScore.objects.create(
                activity=self.activity,
                stage_key="audience",
                singer=foreign,
                score=Decimal("80"),
            )

    def test_prepared_round_blocks_rubric_queryset_update(self):
        rubric = ScoringRubric.objects.create(activity=self.activity, name="Frozen rubric")
        self.round.rubric = rubric
        self.round.save(update_fields=["rubric"])
        ContestRound._base_manager.filter(pk=self.round.pk).update(
            status=ContestRound.Status.PREPARED
        )
        with self.assertRaises(ValidationError):
            ScoringRubric.objects.filter(pk=rubric.pk).update(name="Changed")

    def test_group_assignment_service_writes_a_complete_operator_partition(self):
        from singer_contest.services import set_round_groups

        groups = set_round_groups(
            self.round,
            [{"name": "A组", "singer_ids": [str(self.singer.pk)]}],
            self.user,
        )
        self.assertEqual([group.name for group in groups], ["A组"])
        self.assertEqual(list(PerformanceGroup.objects.values_list("name", flat=True)), ["A组"])
        self.assertEqual(Performance.objects.get(round=self.round).group_id, groups[0].pk)

    def test_ready_award_is_candidate_until_stage_confirmation(self):
        ruleset = ContestRuleset.objects.create(
            activity=self.activity, name="award-rules", is_test_data=True
        )
        with authority_write(RULESET_FREEZE):
            version = RulesetVersion.objects.create(
                ruleset=ruleset,
                definition='{"schema_version": 1, "nodes": [{"key": "r", "type": "ROSTER"}]}',
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
            )
        stage = StageResult.objects.create(
            activity=self.activity,
            ruleset_version=version,
            stage_key="award",
            status=StageResult.Status.READY_TO_CONFIRM,
            ruleset_hash="hash",
            input_fingerprint="fingerprint",
            is_test_data=True,
        )
        candidate = StageAwardDecision.objects.create(
            stage_result=stage,
            activity=self.activity,
            singer=self.singer,
            name="Best",
            is_test_data=True,
        )
        with self.assertRaises(ValidationError):
            from singer_contest.models import Award

            Award.objects.create(
                activity=self.activity,
                singer=self.singer,
                name="Best",
                source_stage_result=stage,
            )
        stage.status = StageResult.Status.CONFIRMED
        stage.confirmed_by = self.user
        stage.confirmed_at = timezone.now()
        with authority_write(STAGE_RESULT_CONFIRM):
            stage.save(update_fields=["status", "confirmed_by", "confirmed_at"])
        from singer_contest.services import materialize_stage_awards

        award = materialize_stage_awards(stage, operator=self.user)[0]
        self.assertEqual(award.source_award_decision_id, candidate.pk)


class CapabilityAndPairContractTests(TestCase):
    def test_seeded_templates_expose_capability_status(self):
        seed_ruleset_templates()
        from ruleset.models import RulesetTemplate

        production = RulesetTemplate.objects.get(name="院十佳")
        unsupported = RulesetTemplate.objects.get(name="校十佳屏峰_历史未决回退")
        self.assertEqual(production.capability_status, RulesetTemplate.CapabilityStatus.PRODUCTION)
        self.assertEqual(
            unsupported.capability_status, RulesetTemplate.CapabilityStatus.UNSUPPORTED
        )

    def test_pair_requires_an_explicit_pairing_policy(self):
        definition = {
            "schema_version": 1,
            "nodes": [{"key": "pair", "type": "PAIR", "source": "entry"}],
        }
        with self.assertRaises(ValidationError):
            parse_definition(definition)
