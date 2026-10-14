from decimal import Decimal

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    ROUND_PERFORMANCE_STATE,
    RULESET_FREEZE,
    SCORE_SUMMARY_RECALCULATE,
    SINGER_CONTESTANT_NUMBER,
    authority_write,
)
from core.models import Activity
from core.services import transition_activity_phase
from django.core.exceptions import ValidationError
from django.test import SimpleTestCase, TestCase
from django.utils import timezone
from ruleset.models import ContestRuleset, RulesetVersion

from .challenge_services import (
    confirm_challenge_session,
    create_challenge_session,
    create_final_round_from_challenge,
    start_challenge_turn,
    waive_challenge_turn,
)
from .models import (
    ContestRound,
    Performance,
    PerformanceScoreState,
    ScoreSummary,
    SingerRegistration,
    StageResult,
)
from .podium_services import build_podium_result
from .scoring import official_weighted_score


class PodiumScoringTests(SimpleTestCase):
    def test_weighted_podium_score_is_official_two_decimal_half_up(self):
        self.assertEqual(
            official_weighted_score(
                [(Decimal("99.99"), Decimal("0.30")), (Decimal("98.98"), Decimal("0.70"))]
            ),
            Decimal("99.28"),
        )

    def test_podium_service_is_the_explicit_result_boundary(self):
        self.assertTrue(callable(build_podium_result))


class PodiumResultServiceTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="podium-staff", password="pass", role=User.Role.ADMIN
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Podium test",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        transition_activity_phase(self.activity, Activity.Phase.TESTING, actor=self.staff)
        with authority_write(CONTEST_ROUND_STATE):
            self.first_round = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="第一轮",
                sequence=1,
                judge_count=5,
                minimum_judge_count=4,
                score_completion_mode=ContestRound.CompletionMode.MINIMUM_VALID,
            )
            self.first_round.status = ContestRound.Status.LOCKED
            self.first_round.is_locked = True
            self.first_round.advancement_status = ContestRound.AdvancementStatus.FINALIZED
            self.first_round.save(update_fields=["status", "is_locked", "advancement_status"])
        self.singers = []
        for number in range(1, 16):
            with authority_write(ACCOUNT_AUTHORITY):
                user = User.objects.create_user(
                    username=f"podium-singer-{number}", password="pass"
                )
            singer = SingerRegistration.objects.create(
                activity=self.activity,
                user=user,
                name=f"选手 {number}",
                student_id=f"podium-{number:02d}",
                college="艺术学院",
                class_name="一班",
                phone=f"1380000{number:04d}",
                song_name=f"歌曲 {number}",
                pre_status=SingerRegistration.PreStatus.APPROVED,
            )
            with authority_write(SINGER_CONTESTANT_NUMBER):
                singer.official_number = number
                singer.save(update_fields=["official_number", "updated_at"])
            self.singers.append(singer)
            with authority_write(SCORE_SUMMARY_RECALCULATE):
                ScoreSummary.objects.create(
                    round=self.first_round,
                    singer=singer,
                    average_score=Decimal(100 - number),
                    rank=number,
                    is_advanced=number <= 10,
                    is_test_data=True,
                )
        ruleset = ContestRuleset.objects.create(
            activity=self.activity, name="冠亚季军规则", is_test_data=True
        )
        from .models import Judge

        with authority_write(CONTEST_ROUND_STATE):
            judges = [
                Judge.objects.create(activity=self.activity, name=f"决赛评委 {index}")
                for index in range(1, 6)
            ]
        with authority_write(RULESET_FREEZE):
            self.version = RulesetVersion.objects.create(
                ruleset=ruleset,
                version=1,
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
                definition={"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
                authority_hash="b" * 64,
                binding={
                    "round_keys": {"first_round": self.first_round.pk},
                    "live_challenge": {
                        "participant_count": 15,
                        "seat_count": 10,
                        "challenge_count": 5,
                        "first_round_weight": "0.4000",
                        "challenge_round_weight": "0.6000",
                        "podium_stage_key": "final_podium",
                        "podium_first_round_key": "first_round",
                        "podium_third_round_key": "third_round",
                        "podium_aggregate_node": "podium_total",
                        "podium_first_round_weight": "0.3000",
                        "podium_third_round_weight": "0.7000",
                        "challenge_judge_ids": [judge.pk for judge in judges],
                        "challenge_minimum_judge_count": 4,
                        "final_judge_ids": [judge.pk for judge in judges],
                        "final_minimum_judge_count": 4,
                    },
                },
            )
        # The podium tests do not score the challenge matches, but the final-round
        # production path still requires independent configured judge identities.
        session = create_challenge_session(
            self.first_round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="podium-create",
        )
        for sequence in range(1, 6):
            turn = start_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"podium-start-{sequence}",
                expected_revision=session.revision,
            )
            session = waive_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"podium-waive-{sequence}",
                expected_revision=turn.session.revision,
                reason="测试无对手评分",
            ).session
        session = confirm_challenge_session(
            session.pk,
            operator=self.staff,
            command_id="podium-confirm-session",
            expected_revision=session.revision,
        )
        self.final_round = create_final_round_from_challenge(
            session.pk,
            operator=self.staff,
            command_id="podium-create-final",
            expected_revision=session.revision,
        )
        with authority_write(CONTEST_ROUND_STATE):
            self.final_round.status = ContestRound.Status.LOCKED
            self.final_round.is_locked = True
            self.final_round.advancement_status = ContestRound.AdvancementStatus.FINALIZED
            self.final_round.save(update_fields=["status", "is_locked", "advancement_status"])
        with authority_write(SCORE_SUMMARY_RECALCULATE):
            for index, singer in enumerate(
                [entry.singer for entry in self.final_round.entries.order_by("running_order")],
                start=1,
            ):
                ScoreSummary.objects.create(
                    round=self.final_round,
                    singer=singer,
                    average_score=Decimal("100") - Decimal(index * 2),
                    rank=index,
                    is_advanced=True,
                    is_test_data=True,
                )
        now = timezone.now()
        with authority_write(ROUND_PERFORMANCE_STATE):
            PerformanceScoreState.objects.bulk_create(
                [
                    PerformanceScoreState(
                        performance=performance,
                        state=PerformanceScoreState.State.LOCKED,
                        context_version=1,
                        opened_by=self.staff,
                        opened_at=now,
                        locked_by=self.staff,
                        locked_at=now,
                        is_test_data=True,
                    )
                    for performance in Performance.objects.filter(round=self.final_round)
                ]
            )
        self.session = session

    def test_builds_weighted_official_podium_and_materializes_awards_only_on_confirm(self):
        from .models import Award, StageAwardDecision
        from .podium_services import persist_podium_result
        from .services import confirm_stage_result, unlock_round

        result = build_podium_result(self.version, self.activity)
        self.assertEqual(result.status, "ready")
        self.assertEqual(result.decisions[0].score, Decimal("98.30"))
        self.assertEqual([award.award for award in result.awards], ["冠军", "亚军", "季军"])

        stage = persist_podium_result(self.version, self.activity, computed_by=self.staff)
        self.assertEqual(Award.objects.count(), 0)
        self.activity.phase = Activity.Phase.RESULTS_PENDING
        with authority_write(ACTIVITY_STATE):
            self.activity.save(update_fields=["phase"])
        confirmed = confirm_stage_result(stage, confirmed_by=self.staff)
        self.assertEqual(confirmed.status, StageResult.Status.CONFIRMED)
        self.assertEqual(StageAwardDecision.objects.filter(stage_result=confirmed).count(), 3)
        self.assertEqual(Award.objects.filter(source_stage_result=confirmed).count(), 3)
        with self.assertRaises(ValidationError):
            unlock_round(self.first_round, self.staff)

    def test_unlocked_final_performance_keeps_podium_on_hold(self):
        state = PerformanceScoreState.objects.filter(performance__round=self.final_round).first()
        assert state is not None
        with authority_write(ROUND_PERFORMANCE_STATE):
            state.state = PerformanceScoreState.State.OPEN
            state.locked_at = None
            state.save(update_fields=["state", "locked_at"])
        result = build_podium_result(self.version, self.activity)
        self.assertEqual(result.status, "hold")
        self.assertIn("podium_third_round_performances_unlocked", result.reasons)
