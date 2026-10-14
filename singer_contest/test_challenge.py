from decimal import Decimal

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    RULESET_FREEZE,
    SCORE_SUMMARY_RECALCULATE,
    SINGER_CONTESTANT_NUMBER,
    authority_write,
)
from core.models import Activity
from core.services import transition_activity_phase
from django.core.exceptions import ValidationError
from django.test import TestCase
from ruleset.models import ContestRuleset, RulesetVersion

from .challenge_services import (
    challenge_final_roster,
    confirm_challenge_match_result,
    confirm_challenge_pairing,
    confirm_challenge_session,
    create_challenge_session,
    create_final_round_from_challenge,
    lock_challenge_match_scores,
    prepare_challenge_match,
    record_challenge_target,
    start_challenge_turn,
    waive_challenge_turn,
)
from .judge_authority import (
    advance_performance,
    lock_performance_score,
    prepare_judge_panel,
)
from .models import (
    ChallengeMatch,
    ChallengeSeat,
    ChallengeSession,
    ChallengeTurn,
    ContestRound,
    Judge,
    Performance,
    PerformanceRunState,
    RoundJudge,
    ScoreSummary,
    SingerRegistration,
)
from .services import apply_scores, current_round_roster


class LiveChallengeAuthorityTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="challenge-staff", password="pass", role=User.Role.ADMIN
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Live challenge",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        transition_activity_phase(self.activity, Activity.Phase.TESTING, actor=self.staff)
        with authority_write(CONTEST_ROUND_STATE):
            self.round = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="第一轮",
                sequence=1,
                judge_count=5,
                minimum_judge_count=4,
                score_completion_mode=ContestRound.CompletionMode.MINIMUM_VALID,
            )
            judges = [
                Judge.objects.create(activity=self.activity, name=f"评委 {index}")
                for index in range(1, 6)
            ]
            RoundJudge.objects.bulk_create(
                [RoundJudge(round=self.round, judge=judge) for judge in judges]
            )
            self.round.status = ContestRound.Status.LOCKED
            self.round.is_locked = True
            self.round.advancement_status = ContestRound.AdvancementStatus.FINALIZED
            self.round.score_version = 7
            self.round.save(
                update_fields=[
                    "status",
                    "is_locked",
                    "advancement_status",
                    "score_version",
                ]
            )
        self.singers = []
        for number in range(1, 16):
            with authority_write(ACCOUNT_AUTHORITY):
                user = User.objects.create_user(
                    username=f"challenge-singer-{number}", password="pass"
                )
            singer = SingerRegistration.objects.create(
                activity=self.activity,
                user=user,
                name=f"选手 {number}",
                student_id=f"challenge-{number:02d}",
                college="艺术学院",
                class_name="一班",
                phone=f"1390000{number:04d}",
                song_name=f"歌曲 {number}",
                pre_status=SingerRegistration.PreStatus.APPROVED,
            )
            with authority_write(SINGER_CONTESTANT_NUMBER):
                singer.official_number = number
                singer.save(update_fields=["official_number", "updated_at"])
            self.singers.append(singer)
            with authority_write(SCORE_SUMMARY_RECALCULATE):
                ScoreSummary.objects.create(
                    round=self.round,
                    singer=singer,
                    average_score=Decimal(100 - number),
                    rank=number,
                    is_advanced=number <= 10,
                    is_test_data=True,
                )
        ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="2026 现场赛制",
            is_test_data=True,
        )
        with authority_write(RULESET_FREEZE):
            self.version = RulesetVersion.objects.create(
                ruleset=ruleset,
                version=1,
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
                definition={"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
                authority_hash="a" * 64,
                binding={
                    "live_challenge": {
                        "participant_count": 15,
                        "seat_count": 10,
                        "challenge_count": 5,
                        "first_round_weight": "0.5000",
                        "challenge_round_weight": "0.5000",
                        "order_policy": "official_number",
                    }
                },
            )

    def test_first_round_confirmation_freezes_queue_and_ten_seats(self):
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="create-1",
        )

        self.assertEqual(session.state, ChallengeSession.State.ACTIVE)
        self.assertEqual(
            list(session.turns.values_list("challenger_id", flat=True)), [15, 14, 13, 12, 11]
        )
        self.assertEqual(
            list(
                session.seats.order_by("third_round_position").values_list(
                    "current_holder_id", flat=True
                )
            ),
            list(range(1, 11)),
        )
        self.assertEqual(session.source_score_version, 7)
        self.assertEqual(ChallengeSeat.objects.filter(session=session).count(), 10)

    def _paired_session(self, prefix="score"):
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id=f"{prefix}-create",
        )
        turn = start_challenge_turn(
            session.pk,
            operator=self.staff,
            command_id=f"{prefix}-start",
            expected_revision=session.revision,
        )
        target = record_challenge_target(
            session.pk,
            seat_position=1,
            operator=self.staff,
            command_id=f"{prefix}-target",
            expected_revision=turn.session.revision,
        )
        match = confirm_challenge_pairing(
            session.pk,
            operator=self.staff,
            command_id=f"{prefix}-pair",
            expected_revision=target.session.revision,
        )
        return session, match

    def test_challenge_match_uses_two_contestant_round_and_weighted_official_result(self):
        session, match = self._paired_session()
        match = prepare_challenge_match(
            session.pk,
            operator=self.staff,
            command_id="score-prepare",
            expected_revision=match.session.revision,
        )
        self.assertEqual(Performance.objects.filter(round=match.score_round).count(), 2)
        self.assertEqual(ScoreSummary.objects.filter(round=match.score_round).count(), 0)
        prepare_judge_panel(match.score_round_id, operator=self.staff)
        performances = list(
            Performance.objects.filter(round=match.score_round).order_by("sequence")
        )
        judges = list(Judge.objects.filter(activity=self.activity).order_by("pk"))
        for performance, score in zip(performances, (Decimal("100"), Decimal("80"))):
            advance_performance(match.score_round_id, performance.pk, operator=self.staff)
            apply_scores(
                match.score_round,
                {(performance.singer_id, judge.pk): score for judge in judges[:4]},
                self.staff,
            )
            run_state = PerformanceRunState.objects.get(round=match.score_round_id)
            lock_performance_score(
                match.score_round_id,
                performance.pk,
                operator=self.staff,
                expected_context_version=run_state.context_version,
            )
        match = lock_challenge_match_scores(
            session.pk,
            operator=self.staff,
            command_id="score-lock",
            expected_revision=match.session.revision,
        )
        match = confirm_challenge_match_result(
            session.pk,
            operator=self.staff,
            command_id="score-confirm",
            expected_revision=match.session.revision,
        )

        self.assertEqual(match.status, ChallengeMatch.Status.CONFIRMED)
        self.assertEqual(match.winner_id, match.challenger_id)
        self.assertEqual(match.challenger_combined_score, Decimal("92.50"))
        self.assertEqual(match.defender_combined_score, Decimal("89.50"))
        self.assertEqual(
            ChallengeSeat.objects.get(session=session, position=1).current_holder_id,
            match.challenger_id,
        )

    def test_confirmed_challenge_session_is_the_only_final_round_roster(self):
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="create-roster",
        )
        for sequence in range(1, 6):
            turn = start_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"start-roster-{sequence}",
                expected_revision=session.revision,
            )
            turn = waive_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"waive-roster-{sequence}",
                expected_revision=turn.session.revision,
            )
            session.refresh_from_db()
        with self.assertRaisesMessage(ValidationError, "尚未核定"):
            challenge_final_roster(session.pk)
        session = confirm_challenge_session(
            session.pk,
            operator=self.staff,
            command_id="confirm-roster",
            expected_revision=session.revision,
        )
        with authority_write(CONTEST_ROUND_STATE):
            final_round = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.SEMI_FINAL,
                name="第三轮",
                sequence=3,
                judge_count=5,
                minimum_judge_count=4,
                roster_source=ContestRound.RosterSource.CHALLENGE_SESSION,
                roster_source_challenge_session=session,
            )
        self.assertEqual(
            [singer.official_number for singer in current_round_roster(final_round)],
            list(range(1, 11)),
        )

    def test_confirmed_session_generates_one_number_ordered_final_round_roster(self):
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="create-final-round",
        )
        for sequence in range(1, 6):
            turn = start_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"start-final-round-{sequence}",
                expected_revision=session.revision,
            )
            waive_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"waive-final-round-{sequence}",
                expected_revision=turn.session.revision,
            )
            session.refresh_from_db()
        session = confirm_challenge_session(
            session.pk,
            operator=self.staff,
            command_id="confirm-final-round",
            expected_revision=session.revision,
        )
        final_round = create_final_round_from_challenge(
            session.pk,
            operator=self.staff,
            command_id="prepare-final-round",
            expected_revision=session.revision,
        )
        self.assertEqual(final_round.roster_source, ContestRound.RosterSource.CHALLENGE_SESSION)
        self.assertEqual(
            list(
                final_round.entries.order_by("running_order").values_list(
                    "singer__official_number", flat=True
                )
            ),
            list(range(1, 11)),
        )

    def test_pre_pairing_waiver_does_not_consume_a_seat(self):
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="create-2",
        )
        turn = start_challenge_turn(
            session.pk,
            operator=self.staff,
            command_id="start-2",
            expected_revision=session.revision,
        )
        waived = waive_challenge_turn(
            session.pk,
            operator=self.staff,
            command_id="waive-2",
            expected_revision=turn.session.revision,
        )

        self.assertEqual(waived.state, ChallengeTurn.State.WAIVED)
        self.assertFalse(ChallengeSeat.objects.filter(session=session, is_challenged=True).exists())
        next_turn = start_challenge_turn(
            session.pk,
            operator=self.staff,
            command_id="start-3",
            expected_revision=waived.session.revision,
        )
        self.assertEqual(next_turn.sequence, 2)

    def test_retried_start_command_returns_the_original_turn(self):
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="create-retry",
        )
        first = start_challenge_turn(
            session.pk,
            operator=self.staff,
            command_id="start-retry",
            expected_revision=session.revision,
        )
        retry = start_challenge_turn(
            session.pk,
            operator=self.staff,
            command_id="start-retry",
            expected_revision=session.revision,
        )
        self.assertEqual(retry.pk, first.pk)
        self.assertEqual(ChallengeTurn.objects.filter(session=session).count(), 5)

    def test_five_waived_opportunities_make_session_ready_for_final_confirmation(self):
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="create-final",
        )
        for sequence in range(1, 6):
            turn = start_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"start-final-{sequence}",
                expected_revision=session.revision,
            )
            turn = waive_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"waive-final-{sequence}",
                expected_revision=turn.session.revision,
            )
            session.refresh_from_db()
        self.assertEqual(session.state, ChallengeSession.State.READY_TO_CONFIRM)
        session = confirm_challenge_session(
            session.pk,
            operator=self.staff,
            command_id="confirm-final",
            expected_revision=session.revision,
        )
        self.assertEqual(session.state, ChallengeSession.State.CONFIRMED)
        self.assertEqual(
            ChallengeSeat.objects.filter(session=session)
            .values("current_holder_id")
            .distinct()
            .count(),
            10,
        )

    def test_a_confirmed_pairing_consumes_the_seat_and_cannot_be_reused(self):
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="create-3",
        )
        turn = start_challenge_turn(
            session.pk,
            operator=self.staff,
            command_id="start-3",
            expected_revision=session.revision,
        )
        target = record_challenge_target(
            session.pk,
            seat_position=1,
            operator=self.staff,
            command_id="target-3",
            expected_revision=turn.session.revision,
        )
        match = confirm_challenge_pairing(
            session.pk,
            operator=self.staff,
            command_id="pair-3",
            expected_revision=target.session.revision,
        )

        self.assertEqual(match.status, ChallengeMatch.Status.READY_FOR_SCORING)
        self.assertTrue(ChallengeSeat.objects.get(pk=match.seat_id).is_challenged)
        with self.assertRaisesMessage(ValidationError, "请先开始当前挑战者的选择"):
            record_challenge_target(
                session.pk,
                seat_position=1,
                operator=self.staff,
                command_id="target-3-repeat",
                expected_revision=match.session.revision,
            )

    def test_first_round_changes_block_an_old_challenge_session(self):
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="create-drift",
        )
        with authority_write(CONTEST_ROUND_STATE):
            self.round.score_version += 1
            self.round.save(update_fields=["score_version"])
        with self.assertRaisesMessage(ValidationError, "第一轮正式结果已变化"):
            start_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id="start-drift",
                expected_revision=session.revision,
            )

    def test_direct_challenge_model_write_is_rejected(self):
        with self.assertRaisesMessage(ValidationError, "authority service"):
            ChallengeSession.objects.create(
                activity=self.activity,
                source_round=self.round,
                ruleset_version=self.version,
                state=ChallengeSession.State.ACTIVE,
                source_score_version=1,
                source_roster_fingerprint="a" * 64,
                ruleset_hash="b" * 64,
                input_fingerprint="c" * 64,
                is_test_data=True,
            )

    def test_equal_weighted_result_blocks_automatic_confirmation(self):
        session, match = self._paired_session("tie")
        match = prepare_challenge_match(
            session.pk,
            operator=self.staff,
            command_id="tie-prepare",
            expected_revision=match.session.revision,
        )
        prepare_judge_panel(match.score_round_id, operator=self.staff)
        performances = list(
            Performance.objects.filter(round=match.score_round_id).order_by("sequence")
        )
        judges = list(Judge.objects.filter(activity=self.activity).order_by("pk"))
        for performance, score in zip(performances, (Decimal("100"), Decimal("86"))):
            advance_performance(match.score_round_id, performance.pk, operator=self.staff)
            apply_scores(
                match.score_round,
                {(performance.singer_id, judge.pk): score for judge in judges[:4]},
                self.staff,
            )
            run_state = PerformanceRunState.objects.get(round=match.score_round_id)
            lock_performance_score(
                match.score_round_id,
                performance.pk,
                operator=self.staff,
                expected_context_version=run_state.context_version,
            )
        match = lock_challenge_match_scores(
            session.pk,
            operator=self.staff,
            command_id="tie-lock",
            expected_revision=match.session.revision,
        )
        with self.assertRaisesMessage(ValidationError, "实际综合成绩相同"):
            confirm_challenge_match_result(
                session.pk,
                operator=self.staff,
                command_id="tie-confirm",
                expected_revision=match.session.revision,
            )
