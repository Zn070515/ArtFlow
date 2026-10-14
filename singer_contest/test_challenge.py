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
    advance_challenge_performance,
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
    _current_challenge_target,
    advance_performance,
    claim_judge_session,
    get_judge_context,
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
    RoundPanelSnapshot,
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
            self.judges = judges
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
                        "challenge_judge_ids": [judge.pk for judge in judges[:4]],
                        "challenge_minimum_judge_count": 4,
                        "final_judge_ids": [judge.pk for judge in judges[1:]],
                        "final_minimum_judge_count": 4,
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
            list(
                session.turns.order_by("sequence").values_list(
                    "challenger__official_number", flat=True
                )
            ),
            [15, 14, 13, 12, 11],
        )
        self.assertEqual(
            list(
                session.seats.order_by("third_round_position").values_list(
                    "current_holder__official_number", flat=True
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
        assert match.score_round_id is not None
        assert match.score_round is not None
        score_round_id = match.score_round_id
        score_round = match.score_round
        self.assertEqual(
            RoundPanelSnapshot.objects.filter(
                round=score_round, state=RoundPanelSnapshot.State.ACTIVE
            ).count(),
            1,
        )
        prepare_judge_panel(score_round_id, operator=self.staff)
        performances = list(
            Performance.objects.filter(round=match.score_round).order_by("sequence")
        )
        self.assertEqual(
            [performance.song_title for performance in performances],
            ["歌曲 15", "歌曲 1"],
        )
        judges = list(Judge.objects.filter(activity=self.activity).order_by("pk"))
        for performance, score in zip(performances, (Decimal("100"), Decimal("80"))):
            advance_performance(score_round_id, performance.pk, operator=self.staff)
            apply_scores(
                score_round,
                {(performance.singer_id, judge.pk): score for judge in judges[:4]},
                self.staff,
            )
            run_state = PerformanceRunState.objects.get(round=score_round_id)
            lock_performance_score(
                score_round_id,
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

    def test_judge_claimed_on_challenge_round_resolves_the_live_match(self):
        """A judge scanned before the dynamic round still follows its active match."""
        session, match = self._paired_session(prefix="dynamic-judge")
        match = prepare_challenge_match(
            session.pk,
            operator=self.staff,
            command_id="dynamic-judge-prepare",
            expected_revision=match.session.revision,
        )
        assert match.score_round_id is not None

        claimed = claim_judge_session(self.activity)

        target_round = _current_challenge_target(claimed.session)
        self.assertIsNotNone(target_round)
        self.assertEqual(target_round.pk, match.score_round_id)

    def test_same_judge_session_follows_the_next_challenge_match(self):
        """A connected judge can continue after the challenge score round changes."""
        session, match = self._paired_session(prefix="handoff")
        match = prepare_challenge_match(
            session.pk,
            operator=self.staff,
            command_id="handoff-prepare-one",
            expected_revision=match.session.revision,
        )
        claimed = claim_judge_session(self.activity)
        score_round = match.score_round
        assert score_round is not None
        performances = list(score_round.performances.order_by("sequence"))
        judges = list(Judge.objects.filter(activity=self.activity).order_by("pk"))
        for performance, score in zip(performances, (Decimal("100"), Decimal("80"))):
            advance_performance(score_round.pk, performance.pk, operator=self.staff)
            apply_scores(
                score_round,
                {(performance.singer_id, judge.pk): score for judge in judges[:4]},
                self.staff,
            )
            run_state = PerformanceRunState.objects.get(round=score_round.pk)
            lock_performance_score(
                score_round.pk,
                performance.pk,
                operator=self.staff,
                expected_context_version=run_state.context_version,
            )
        match = lock_challenge_match_scores(
            session.pk,
            operator=self.staff,
            command_id="handoff-lock-one",
            expected_revision=match.session.revision,
        )
        confirm_challenge_match_result(
            session.pk,
            operator=self.staff,
            command_id="handoff-confirm-one",
            expected_revision=match.session.revision,
        )
        session.refresh_from_db()
        turn = start_challenge_turn(
            session.pk,
            operator=self.staff,
            command_id="handoff-start-two",
            expected_revision=session.revision,
        )
        target = record_challenge_target(
            session.pk,
            seat_position=2,
            operator=self.staff,
            command_id="handoff-target-two",
            expected_revision=turn.session.revision,
        )
        match = confirm_challenge_pairing(
            session.pk,
            operator=self.staff,
            command_id="handoff-pair-two",
            expected_revision=target.session.revision,
        )
        match = prepare_challenge_match(
            session.pk,
            operator=self.staff,
            command_id="handoff-prepare-two",
            expected_revision=match.session.revision,
        )

        context = get_judge_context(claimed.token)

        assert match.score_round_id is not None
        self.assertEqual(context.round_id, match.score_round_id)

    def test_challenge_console_service_requires_challenger_before_defender(self):
        session, match = self._paired_session(prefix="open-order")
        match = prepare_challenge_match(
            session.pk,
            operator=self.staff,
            command_id="open-order-prepare",
            expected_revision=match.session.revision,
        )
        assert match.score_round_id is not None
        prepare_judge_panel(match.score_round_id, operator=self.staff)

        with self.assertRaisesMessage(ValidationError, "请先开放挑战者评分"):
            advance_challenge_performance(
                session.pk,
                role="defender",
                operator=self.staff,
                command_id="open-order-defender-first",
                expected_revision=match.session.revision,
            )

        opened = advance_challenge_performance(
            session.pk,
            role="challenger",
            operator=self.staff,
            command_id="open-order-challenger",
            expected_revision=match.session.revision,
        )
        session.refresh_from_db()
        replay = advance_challenge_performance(
            session.pk,
            role="challenger",
            operator=self.staff,
            command_id="open-order-challenger",
            expected_revision=match.session.revision,
        )
        self.assertEqual(replay.pk, opened.pk)

        defender_opened = advance_challenge_performance(
            session.pk,
            role="defender",
            operator=self.staff,
            command_id="open-order-defender",
            expected_revision=session.revision,
        )
        self.assertIsNotNone(defender_opened.current_performance_id)

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
                reason="现场顺延",
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
                reason="现场顺延",
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
        self.assertEqual(
            list(final_round.round_judges.order_by("pk").values_list("judge_id", flat=True)),
            [judge.pk for judge in self.judges[1:]],
        )
        self.assertEqual(Performance.objects.filter(round=final_round).count(), 10)
        self.assertEqual(
            list(
                final_round.performances.order_by("sequence").values_list("song_title", flat=True)
            ),
            [f"歌曲 {number}" for number in range(1, 11)],
        )

    def test_prepared_final_round_preserves_challenge_seat_order(self):
        session, match = self._paired_session(prefix="seat-order")
        match = prepare_challenge_match(
            session.pk,
            operator=self.staff,
            command_id="seat-order-prepare",
            expected_revision=match.session.revision,
        )
        assert match.score_round_id is not None
        score_round = match.score_round
        assert score_round is not None
        prepare_judge_panel(score_round.pk, operator=self.staff)
        performances = list(Performance.objects.filter(round=score_round).order_by("sequence"))
        judges = list(Judge.objects.filter(activity=self.activity).order_by("pk"))
        for performance, score in zip(performances, (Decimal("100"), Decimal("80"))):
            advance_performance(score_round.pk, performance.pk, operator=self.staff)
            apply_scores(
                score_round,
                {(performance.singer_id, judge.pk): score for judge in judges[:4]},
                self.staff,
            )
            run_state = PerformanceRunState.objects.get(round=score_round.pk)
            lock_performance_score(
                score_round.pk,
                performance.pk,
                operator=self.staff,
                expected_context_version=run_state.context_version,
            )
        match = lock_challenge_match_scores(
            session.pk,
            operator=self.staff,
            command_id="seat-order-lock",
            expected_revision=match.session.revision,
        )
        confirm_challenge_match_result(
            session.pk,
            operator=self.staff,
            command_id="seat-order-confirm",
            expected_revision=match.session.revision,
        )
        session.refresh_from_db()
        for sequence in range(2, 6):
            turn = start_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"seat-order-start-{sequence}",
                expected_revision=session.revision,
            )
            waive_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"seat-order-waive-{sequence}",
                expected_revision=turn.session.revision,
                reason="现场顺延",
            )
            session.refresh_from_db()
        session = confirm_challenge_session(
            session.pk,
            operator=self.staff,
            command_id="seat-order-session-confirm",
            expected_revision=session.revision,
        )
        final_round = create_final_round_from_challenge(
            session.pk,
            operator=self.staff,
            command_id="seat-order-final-round",
            expected_revision=session.revision,
        )

        from .services import _order_singers_for_round

        ordered = _order_singers_for_round(
            final_round,
            list(
                SingerRegistration.objects.filter(
                    pk__in=final_round.entries.values_list("singer_id", flat=True)
                )
            ),
        )
        self.assertEqual(
            [singer.official_number for singer in ordered],
            [15, *range(2, 11)],
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
            reason="挑战者主动放弃",
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

    def test_target_selected_turn_requires_a_reason_to_waive(self):
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="create-reason",
        )
        turn = start_challenge_turn(
            session.pk,
            operator=self.staff,
            command_id="start-reason",
            expected_revision=session.revision,
        )
        target = record_challenge_target(
            session.pk,
            seat_position=1,
            operator=self.staff,
            command_id="target-reason",
            expected_revision=turn.session.revision,
        )

        with self.assertRaisesMessage(ValidationError, "放弃挑战必须填写原因"):
            waive_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id="waive-reason-empty",
                expected_revision=target.session.revision,
                reason=" ",
            )

        waived = waive_challenge_turn(
            session.pk,
            operator=self.staff,
            command_id="waive-reason-ok",
            expected_revision=target.session.revision,
            reason="挑战者确认不再继续",
        )
        self.assertEqual(waived.state, ChallengeTurn.State.WAIVED)
        self.assertEqual(waived.waive_reason, "挑战者确认不再继续")

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
                reason="现场顺延",
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
        assert match.score_round_id is not None
        assert match.score_round is not None
        score_round_id = match.score_round_id
        score_round = match.score_round
        prepare_judge_panel(score_round_id, operator=self.staff)
        performances = list(
            Performance.objects.filter(round=match.score_round_id).order_by("sequence")
        )
        judges = list(Judge.objects.filter(activity=self.activity).order_by("pk"))
        for performance, score in zip(performances, (Decimal("100"), Decimal("86"))):
            advance_performance(score_round_id, performance.pk, operator=self.staff)
            apply_scores(
                score_round,
                {(performance.singer_id, judge.pk): score for judge in judges[:4]},
                self.staff,
            )
            run_state = PerformanceRunState.objects.get(round=score_round_id)
            lock_performance_score(
                score_round_id,
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
