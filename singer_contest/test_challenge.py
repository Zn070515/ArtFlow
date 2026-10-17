import json
from decimal import Decimal

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    LIVE_CHALLENGE_STATE,
    RULESET_FREEZE,
    SCORE_SUMMARY_RECALCULATE,
    SINGER_CONTESTANT_NUMBER,
    authority_write,
)
from core.models import Activity
from core.services import transition_activity_phase
from django.core.exceptions import ValidationError
from django.test import TestCase, TransactionTestCase
from django.urls import reverse
from django.utils import timezone
from entry_access.services import redeem_access_grant
from questionnaire.services import get_or_create_response, mark_submitted, save_draft_answers
from ruleset.live_format import freeze_blocker
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import freeze_ruleset_version, supersede_ruleset_version
from tests.helpers import postgresql_only

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
    issue_judge_grant,
    lock_performance_score,
    prepare_judge_panel,
    submit_judge_score,
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
from .services import (
    apply_scores,
    current_round_roster,
    reset_round_to_draft,
    round_execution_authority_message,
    unlock_round,
)


class _LiveChallengeFixtureMixin:
    """The frozen 2026 fixture, sized by ``PARTICIPANTS``/``SEATS``.

    The counts are operator parameters now, so a subclass can move them and re-run the same
    runtime against a different shape.
    """

    PARTICIPANTS = 15
    SEATS = 10
    IS_TEST_MODE = True

    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="challenge-staff", password="pass", role=User.Role.ADMIN
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Live challenge",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=self.IS_TEST_MODE,
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
        for number in range(1, self.PARTICIPANTS + 1):
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
                    is_advanced=number <= self.SEATS,
                    is_test_data=self.IS_TEST_MODE,
                )
        ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="2026 现场赛制",
            is_test_data=self.IS_TEST_MODE,
        )
        with authority_write(RULESET_FREEZE):
            self.version = RulesetVersion.objects.create(
                ruleset=ruleset,
                version=1,
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
                definition=json.dumps(
                    {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]}
                ),
                authority_hash="a" * 64,
                binding={
                    "round_keys": {"r1": self.round.pk},
                    "live_challenge": {
                        "participant_count": self.PARTICIPANTS,
                        "seat_count": self.SEATS,
                        "challenge_count": self.PARTICIPANTS - self.SEATS,
                        "first_round_weight": "0.5000",
                        "challenge_round_weight": "0.5000",
                        "order_policy": "official_number",
                        "challenge_judge_ids": [judge.pk for judge in judges[:4]],
                        "challenge_minimum_judge_count": 4,
                        "final_judge_ids": [judge.pk for judge in judges[1:]],
                        "final_minimum_judge_count": 4,
                        "podium_third_round_key": "third_round",
                    },
                },
            )

    def _seed_distinct_questionnaire_songs(self):
        for singer in self.singers:
            response = get_or_create_response(
                registration=singer,
                ruleset_version=self.version,
                questionnaire_key="singer_submission",
                is_test_data=True,
            )
            response = save_draft_answers(
                response,
                answers={
                    "r1.song": f"第一轮曲目 {singer.official_number}",
                    "r2.song": f"踢馆曲目 {singer.official_number}",
                    "r3.song": f"决赛曲目 {singer.official_number}",
                },
            )
            mark_submitted(response)


class LiveChallengeAuthorityTests(_LiveChallengeFixtureMixin, TestCase):
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

    def test_ruleset_weights_cannot_be_overridden_when_creating_challenge_session(self):
        with self.assertRaisesMessage(ValidationError, "只能从冻结赛制"):
            create_challenge_session(
                self.round,
                ruleset_version=self.version,
                operator=self.staff,
                command_id="override-ruleset-weight",
                first_round_weight="0.3000",
                challenge_round_weight="0.7000",
            )

    def test_2026_challenge_rejects_drop_high_low_source_round(self):
        with authority_write(CONTEST_ROUND_STATE):
            self.round.scoring_mode = ContestRound.ScoringMode.DROP_HIGH_LOW
            self.round.save(update_fields=["scoring_mode"])
        with authority_write(RULESET_FREEZE):
            RulesetVersion._base_manager.filter(pk=self.version.pk).update(
                binding={
                    **self.version.binding,
                    "live_challenge": {
                        **self.version.binding["live_challenge"],
                        "format_key": "2026_live_challenge",
                    },
                }
            )
        with self.assertRaisesMessage(ValidationError, "算术平均"):
            create_challenge_session(
                self.round,
                ruleset_version=self.version,
                operator=self.staff,
                command_id="reject-drop-high-low",
            )

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

    def test_challenge_match_uses_the_r2_questionnaire_song(self):
        self._seed_distinct_questionnaire_songs()
        session, match = self._paired_session(prefix="r2-song")
        match = prepare_challenge_match(
            session.pk,
            operator=self.staff,
            command_id="r2-song-prepare",
            expected_revision=match.session.revision,
        )

        self.assertEqual(
            list(
                Performance.objects.filter(round=match.score_round)
                .order_by("sequence")
                .values_list("song_title", flat=True)
            ),
            ["踢馆曲目 15", "踢馆曲目 1"],
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

    def test_two_challenge_matches_accept_real_judge_submissions_before_final_roster(self):
        """The public judge submission path must survive a dynamic-round handoff."""
        session, match = self._paired_session(prefix="direct-two-match")
        match = prepare_challenge_match(
            session.pk,
            operator=self.staff,
            command_id="direct-two-match-prepare-one",
            expected_revision=match.session.revision,
        )
        assert match.score_round is not None
        snapshot = RoundPanelSnapshot.objects.get(
            round=match.score_round, state=RoundPanelSnapshot.State.ACTIVE
        )
        tokens = []
        for member in snapshot.members.order_by("pk"):
            seat = member.seats.get()
            issued = issue_judge_grant(seat.pk, operator=self.staff, ttl_seconds=600)
            redeemed = redeem_access_grant(issued.token)
            get_judge_context(redeemed.token)
            tokens.append(redeemed.token)

        def score_current_match(current_match, prefix, values):
            score_round = current_match.score_round
            assert score_round is not None
            performances = list(score_round.performances.order_by("sequence"))
            for performance, score in zip(performances, values, strict=True):
                advance_performance(score_round.pk, performance.pk, operator=self.staff)
                for index, token in enumerate(tokens, start=1):
                    context = get_judge_context(token)
                    submit_judge_score(
                        token,
                        command_id=f"{prefix}-judge-{index}-{performance.sequence}",
                        expected_context_version=context.context_version,
                        expected_performance_id=performance.pk,
                        score_payload={"score": str(score), "notes": ""},
                    )
                run_state = PerformanceRunState.objects.get(round=score_round.pk)
                lock_performance_score(
                    score_round.pk,
                    performance.pk,
                    operator=self.staff,
                    expected_context_version=run_state.context_version,
                )
            locked = lock_challenge_match_scores(
                session.pk,
                operator=self.staff,
                command_id=f"{prefix}-lock",
                expected_revision=current_match.session.revision,
            )
            return confirm_challenge_match_result(
                session.pk,
                operator=self.staff,
                command_id=f"{prefix}-confirm",
                expected_revision=locked.session.revision,
            )

        first = score_current_match(match, "direct-two-match-one", (100, 80))
        self.assertEqual(first.status, ChallengeMatch.Status.CONFIRMED)
        session.refresh_from_db()

        turn = start_challenge_turn(
            session.pk,
            operator=self.staff,
            command_id="direct-two-match-start-two",
            expected_revision=session.revision,
        )
        target = record_challenge_target(
            session.pk,
            seat_position=2,
            operator=self.staff,
            command_id="direct-two-match-target-two",
            expected_revision=turn.session.revision,
        )
        second = confirm_challenge_pairing(
            session.pk,
            operator=self.staff,
            command_id="direct-two-match-pair-two",
            expected_revision=target.session.revision,
        )
        second = prepare_challenge_match(
            session.pk,
            operator=self.staff,
            command_id="direct-two-match-prepare-two",
            expected_revision=second.session.revision,
        )
        second = score_current_match(second, "direct-two-match-two", (95, 75))
        self.assertEqual(second.status, ChallengeMatch.Status.CONFIRMED)

        session.refresh_from_db()
        for sequence in range(3, 6):
            turn = start_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"direct-two-match-start-{sequence}",
                expected_revision=session.revision,
            )
            waive_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"direct-two-match-waive-{sequence}",
                expected_revision=turn.session.revision,
                reason="现场顺延",
            )
            session.refresh_from_db()

        self.assertEqual(
            ChallengeMatch.objects.filter(
                session=session, status=ChallengeMatch.Status.CONFIRMED
            ).count(),
            2,
        )
        session = confirm_challenge_session(
            session.pk,
            operator=self.staff,
            command_id="direct-two-match-confirm-session",
            expected_revision=session.revision,
        )
        final_round = create_final_round_from_challenge(
            session.pk,
            operator=self.staff,
            command_id="direct-two-match-final-round",
            expected_revision=session.revision,
        )
        self.assertEqual(final_round.entries.count(), 10)

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

    def test_final_round_uses_the_r3_questionnaire_song(self):
        self._seed_distinct_questionnaire_songs()
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="r3-song-create",
        )
        for sequence in range(1, 6):
            turn = start_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"r3-song-start-{sequence}",
                expected_revision=session.revision,
            )
            waive_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"r3-song-waive-{sequence}",
                expected_revision=turn.session.revision,
                reason="现场顺延",
            )
            session.refresh_from_db()
        session = confirm_challenge_session(
            session.pk,
            operator=self.staff,
            command_id="r3-song-confirm",
            expected_revision=session.revision,
        )
        final_round = create_final_round_from_challenge(
            session.pk,
            operator=self.staff,
            command_id="r3-song-final-round",
            expected_revision=session.revision,
        )

        self.assertEqual(
            list(
                final_round.performances.order_by("sequence").values_list("song_title", flat=True)
            ),
            [f"决赛曲目 {number}" for number in range(1, 11)],
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


class LiveChallengeAuthorityConsumerTests(_LiveChallengeFixtureMixin, TestCase):
    """A materialised challenge session is runtime authority, not a derived view.

    R1 does not need a judge panel to reach the challenge: a rapid-score path can lock and
    finalize it directly. The reset and freeze gates used to look only for panels and
    CONFIRMED stage results, so this window could reset R1 — deleting the scores, entries and
    judges the session had frozen — unlock it, and then freeze a successor, leaving an ACTIVE
    session under a v1 that is no longer the activity's current authority.
    """

    IS_TEST_MODE = False

    def _session(self):
        return create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="formal-consumer-create",
        )

    def _assert_takeover_is_closed(self) -> None:
        successor = supersede_ruleset_version(self.version, created_by=self.staff)

        blocker = freeze_blocker(successor)
        self.assertIsNotNone(blocker)
        assert blocker is not None  # for the type checker, not for the test
        self.assertEqual(blocker.key, "finality")
        self.assertIn("踢馆会话", blocker.message)
        # The reset is not an escape hatch here: it would delete the facts the session froze.
        self.assertNotIn("重置为草稿", blocker.message)
        with self.assertRaisesMessage(ValidationError, "踢馆会话"):
            freeze_ruleset_version(successor, self.staff)

        self.version.refresh_from_db()
        self.assertTrue(self.version.is_current)

    def test_a_live_session_blocks_reset_unlock_and_successor_freeze(self):
        session = self._session()

        with self.assertRaisesMessage(ValidationError, "踢馆会话"):
            reset_round_to_draft(self.round, self.staff, reason="换版前撤销现场准备")
        with self.assertRaisesMessage(ValidationError, "踢馆会话"):
            unlock_round(self.round, self.staff, note="换版前撤销现场准备")

        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.LOCKED)
        self.assertTrue(self.round.is_locked)
        self._assert_takeover_is_closed()
        session.refresh_from_db()
        self.assertEqual(session.ruleset_version_id, self.version.pk)

    def test_a_confirmed_session_before_the_third_round_blocks_the_same_actions(self):
        session = self._session()
        # The narrow window the reviewer named: the ten seats are confirmed, but no third
        # round exists yet, so neither the downstream-round guard nor a stage-result guard
        # can see the session.
        with authority_write(LIVE_CHALLENGE_STATE):
            session.state = ChallengeSession.State.CONFIRMED
            session.confirmed_by = self.staff
            session.confirmed_at = timezone.now()
            session.save(update_fields=["state", "confirmed_by", "confirmed_at"])

        with self.assertRaisesMessage(ValidationError, "踢馆会话"):
            reset_round_to_draft(self.round, self.staff, reason="换版前撤销现场准备")
        with self.assertRaisesMessage(ValidationError, "踢馆会话"):
            unlock_round(self.round, self.staff, note="换版前撤销现场准备")

        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.LOCKED)
        self._assert_takeover_is_closed()

    def test_a_revoked_match_no_longer_provides_round_provenance(self):
        session = self._session()
        turn = session.turns.order_by("sequence").first()
        seat = session.seats.order_by("position").first()
        assert turn is not None and seat is not None
        score_round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
            name="撤销的踢馆评分轮",
            judge_count=4,
            minimum_judge_count=4,
        )
        with authority_write(LIVE_CHALLENGE_STATE):
            ChallengeMatch.objects.create(
                session=session,
                turn=turn,
                seat=seat,
                challenger=turn.challenger,
                defender=seat.current_holder,
                status=ChallengeMatch.Status.REVOKED,
                score_round=score_round,
                is_test_data=session.is_test_data,
            )

        # The round is not bound by the format and its only challenge link is revoked, so it
        # must not be treated as one the current authority generated.
        self.assertIsNotNone(round_execution_authority_message(score_round))


@postgresql_only
class LiveChallengeParameterizedCountsTests(_LiveChallengeFixtureMixin, TestCase):
    """The counts are operator parameters now, not constants.

    20 singers with 12 seats leaves 8 challengers — deliberately past both numbers the old
    schema pinned (``position <= 10``, ``sequence <= 5``), so this is also what proves those
    bounds really moved to the service.
    """

    PARTICIPANTS = 20
    SEATS = 12

    def test_challenge_session_uses_the_configured_counts(self):
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="param-create",
        )

        positions = list(
            ChallengeSeat.objects.filter(session=session)
            .order_by("position")
            .values_list("position", flat=True)
        )
        sequences = list(
            ChallengeTurn.objects.filter(session=session)
            .order_by("sequence")
            .values_list("sequence", flat=True)
        )

        self.assertEqual(positions, list(range(1, self.SEATS + 1)))
        self.assertEqual(sequences, list(range(1, self.PARTICIPANTS - self.SEATS + 1)))

    def test_session_becomes_confirmable_after_the_configured_number_of_turns(self):
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="param-ready-create",
        )
        challenge_count = self.PARTICIPANTS - self.SEATS
        for sequence in range(1, challenge_count + 1):
            turn = start_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"param-start-{sequence}",
                expected_revision=session.revision,
            )
            waive_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"param-waive-{sequence}",
                expected_revision=turn.session.revision,
                reason="现场顺延",
            )
            session.refresh_from_db()
            expected_state = (
                ChallengeSession.State.READY_TO_CONFIRM
                if sequence == challenge_count
                else ChallengeSession.State.ACTIVE
            )
            self.assertEqual(session.state, expected_state, f"after turn {sequence}")

        confirmed = confirm_challenge_session(
            session.pk,
            operator=self.staff,
            command_id="param-confirm",
            expected_revision=session.revision,
        )
        self.assertEqual(confirmed.state, ChallengeSession.State.CONFIRMED)
        final_seats = ChallengeSeat.objects.filter(session=confirmed)
        self.assertEqual(final_seats.count(), self.SEATS)
        self.assertEqual(
            len({seat.current_holder_id for seat in final_seats}),
            self.SEATS,
        )


class RoundListPostgreSQLTransactionTests(_LiveChallengeFixtureMixin, TransactionTestCase):
    staff: User
    round: ContestRound
    version: RulesetVersion

    def test_staff_round_list_reads_a_generated_third_round_in_autocommit(self):
        # The mixin's setUp already ran: this deliberately uses TransactionTestCase so the
        # real GET is not wrapped in Django's TestCase transaction. That is the production
        # boundary where select_for_update() must not leak into a read-only readiness check.
        session = create_challenge_session(
            self.round,
            ruleset_version=self.version,
            operator=self.staff,
            command_id="round-list-autocommit-create",
        )
        for sequence in range(1, 6):
            turn = start_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"round-list-autocommit-start-{sequence}",
                expected_revision=session.revision,
            )
            session = waive_challenge_turn(
                session.pk,
                operator=self.staff,
                command_id=f"round-list-autocommit-waive-{sequence}",
                expected_revision=turn.session.revision,
                reason="测试回归：现场顺延",
            ).session
        session = confirm_challenge_session(
            session.pk,
            operator=self.staff,
            command_id="round-list-autocommit-confirm",
            expected_revision=session.revision,
        )
        final_round = create_final_round_from_challenge(
            session.pk,
            operator=self.staff,
            command_id="round-list-autocommit-final-round",
            expected_revision=session.revision,
        )

        self.client.force_login(self.staff)
        response = self.client.get(reverse("staff:round_list"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, final_round.name)
