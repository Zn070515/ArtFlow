"""Positive PostgreSQL-sized acceptance path for the 2026 live format."""

import json
from decimal import Decimal

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    RULESET_FREEZE,
    SINGER_CONTESTANT_NUMBER,
    authority_write,
)
from core.models import Activity
from core.services import transition_activity_phase
from django.test import TestCase
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import freeze_ruleset_version

from .challenge_services import (
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
from .judge_authority import advance_performance, lock_performance_score, prepare_judge_panel
from .models import (
    ContestRound,
    Judge,
    PerformanceRunState,
    RubricCriterion,
    ScoreSummary,
    ScoringRubric,
    SingerRegistration,
)
from .podium_services import build_podium_result
from .services import apply_scores, lock_round, prepare_round


def _live_questionnaire():
    questions = []
    for round_key, label in (("r2", "踢馆曲目"), ("r3", "第三轮曲目")):
        questions.extend(
            [
                {
                    "key": f"{round_key}.song",
                    "type": "text",
                    "label": label,
                    "round": round_key,
                    "required": True,
                },
                {
                    "key": f"{round_key}.accompaniment",
                    "type": "file",
                    "label": f"{label}伴奏",
                    "round": round_key,
                    "required": True,
                    "file": {
                        "purpose": "accompaniment",
                        "extensions": [".mp3"],
                        "max_mb": 100,
                    },
                },
            ]
        )
    return {
        "schema_version": 1,
        "key": "singer_submission",
        "pages": [
            {
                "key": "materials",
                "title": "现场材料",
                "sections": [{"key": "songs", "title": "歌曲", "questions": questions}],
            }
        ],
    }


class Live2026AcceptanceTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.admin = User.objects.create_user(
                username="live-2026-admin", password="pass", role=User.Role.ADMIN
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="2026 院十佳验收",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        transition_activity_phase(self.activity, Activity.Phase.TESTING, actor=self.admin)

        self.judges = [
            Judge.objects.create(activity=self.activity, name=f"现场评委 {index}")
            for index in range(1, 6)
        ]
        rubric = ScoringRubric.objects.create(
            activity=self.activity, name="2026 统一评分标准", is_test_data=True
        )
        RubricCriterion.objects.create(
            rubric=rubric, name="综合表现", max_score=100, is_test_data=True
        )
        with authority_write(CONTEST_ROUND_STATE):
            self.first_round = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="第一轮",
                sequence=1,
                scoring_mode=ContestRound.ScoringMode.AVERAGE,
                score_completion_mode=ContestRound.CompletionMode.MINIMUM_VALID,
                judge_count=5,
                minimum_judge_count=4,
                advance_count=10,
                rubric=rubric,
            )

        self.singers = []
        for number in range(1, 16):
            with authority_write(ACCOUNT_AUTHORITY):
                user = User.objects.create_user(
                    username=f"live-2026-singer-{number}", password="pass"
                )
            singer = SingerRegistration.objects.create(
                activity=self.activity,
                user=user,
                name=f"选手 {number}",
                student_id=f"live-2026-{number:02d}",
                college="艺术学院",
                class_name="一班",
                phone=f"1390000{number:04d}",
                song_name=f"第一轮曲目 {number}",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            )
            with authority_write(SINGER_CONTESTANT_NUMBER):
                singer.official_number = number
                singer.save(update_fields=["official_number", "updated_at"])
            self.singers.append(singer)

        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="2026 院十佳现场赛制",
            is_test_data=True,
        )
        self.ruleset.round_keys = {"r1": self.first_round.pk}
        self.ruleset.live_challenge = {
            "format_key": "2026_live_challenge",
            "participant_count": 15,
            "seat_count": 10,
            "challenge_count": 5,
            "first_round_weight": "40%",
            "challenge_round_weight": "60%",
            "order_policy": "official_number",
            "podium_stage_key": "final_podium",
            "podium_first_round_key": "r1",
            "podium_third_round_key": "r3",
            "podium_aggregate_node": "podium_total",
            "podium_first_round_weight": "30%",
            "podium_third_round_weight": "70%",
            "challenge_judge_ids": [judge.pk for judge in self.judges[:4]],
            "challenge_minimum_judge_count": 4,
            "final_judge_ids": [judge.pk for judge in self.judges[1:]],
            "final_minimum_judge_count": 4,
        }
        self.ruleset.save(update_fields=["round_keys", "live_challenge"])
        definition = {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
                {"key": "rank1", "type": "RANK", "source": "assess_r1"},
                {"key": "top10", "type": "SELECT", "source": "rank1", "count": 10},
            ],
            "questionnaire": _live_questionnaire(),
        }
        with authority_write(RULESET_FREEZE):
            self.version = RulesetVersion.objects.create(
                ruleset=self.ruleset,
                version=1,
                definition=json.dumps(definition, ensure_ascii=False),
                created_by=self.admin,
            )

    def _score_performances(self, round_, scores, judges):
        prepare_judge_panel(round_.pk, operator=self.admin)
        for performance, score in zip(
            round_.performances.order_by("sequence", "pk"), scores, strict=True
        ):
            advance_performance(round_.pk, performance.pk, operator=self.admin)
            apply_scores(
                round_,
                {(performance.singer_id, judge.pk): score for judge in judges},
                self.admin,
            )
            run_state = PerformanceRunState.objects.get(round=round_.pk)
            lock_performance_score(
                round_.pk,
                performance.pk,
                operator=self.admin,
                expected_context_version=run_state.context_version,
            )

    def _score_challenge_match(self, session, match, challenger_score, defender_score, command):
        match = prepare_challenge_match(
            session.pk,
            operator=self.admin,
            command_id=f"{command}-prepare",
            expected_revision=match.session.revision,
        )
        score_round = match.score_round
        assert score_round is not None
        self.assertEqual(score_round.scoring_mode, ContestRound.ScoringMode.AVERAGE)
        self._score_performances(
            score_round,
            [challenger_score, defender_score],
            self.judges[:4],
        )
        match = lock_challenge_match_scores(
            session.pk,
            operator=self.admin,
            command_id=f"{command}-lock",
            expected_revision=match.session.revision,
        )
        return confirm_challenge_match_result(
            session.pk,
            operator=self.admin,
            command_id=f"{command}-confirm",
            expected_revision=match.session.revision,
        )

    def test_freeze_dynamic_rounds_and_weighted_podium_without_audience(self):
        frozen = freeze_ruleset_version(self.version, self.admin)
        frozen.refresh_from_db()
        self.assertEqual(frozen.status, RulesetVersion.Status.FROZEN)
        self.assertEqual(frozen.binding["round_keys"], {"r1": self.first_round.pk})
        self.assertEqual(
            frozen.binding["live_challenge"]["scoring_standard"]["scoring_mode"], "average"
        )
        self.assertNotIn("r2", frozen.binding["round_keys"])
        self.assertNotIn("r3", frozen.binding["round_keys"])
        self.assertEqual(frozen.binding.get("vote_keys"), {})

        prepared_first = prepare_round(self.first_round, self.admin)
        first_judges = list(
            prepared_first.round_judges.select_related("judge").values_list("judge", flat=True)
        )
        apply_scores(
            prepared_first,
            {
                (singer.pk, judge_id): Decimal(100 - singer.official_number)
                for singer in self.singers
                for judge_id in first_judges
            },
            self.admin,
        )
        lock_round(prepared_first, self.admin)
        self.first_round.refresh_from_db()
        self.assertEqual(
            set(
                ScoreSummary.objects.filter(round=self.first_round, is_advanced=True).values_list(
                    "singer_id", flat=True
                )
            ),
            {singer.pk for singer in self.singers[:10]},
        )

        session = create_challenge_session(
            self.first_round,
            ruleset_version=frozen,
            operator=self.admin,
            command_id="acceptance-create",
        )
        turn = start_challenge_turn(
            session.pk,
            operator=self.admin,
            command_id="acceptance-start-1",
            expected_revision=session.revision,
        )
        target = record_challenge_target(
            session.pk,
            seat_position=1,
            operator=self.admin,
            command_id="acceptance-target-1",
            expected_revision=turn.session.revision,
        )
        match = confirm_challenge_pairing(
            session.pk,
            operator=self.admin,
            command_id="acceptance-pair-1",
            expected_revision=target.session.revision,
        )
        first_match = self._score_challenge_match(session, match, 100, 80, "acceptance-match-1")
        self.assertEqual(first_match.winner_id, self.singers[14].pk)

        session.refresh_from_db()
        turn = start_challenge_turn(
            session.pk,
            operator=self.admin,
            command_id="acceptance-start-2",
            expected_revision=session.revision,
        )
        target = record_challenge_target(
            session.pk,
            seat_position=2,
            operator=self.admin,
            command_id="acceptance-target-2",
            expected_revision=turn.session.revision,
        )
        match = confirm_challenge_pairing(
            session.pk,
            operator=self.admin,
            command_id="acceptance-pair-2",
            expected_revision=target.session.revision,
        )
        second_match = self._score_challenge_match(session, match, 100, 80, "acceptance-match-2")
        self.assertEqual(second_match.winner_id, self.singers[13].pk)

        session.refresh_from_db()
        for sequence in range(3, 6):
            turn = start_challenge_turn(
                session.pk,
                operator=self.admin,
                command_id=f"acceptance-start-{sequence}",
                expected_revision=session.revision,
            )
            waive_challenge_turn(
                session.pk,
                operator=self.admin,
                command_id=f"acceptance-waive-{sequence}",
                expected_revision=turn.session.revision,
                reason="验收流程顺延",
            )
            session.refresh_from_db()
        session = confirm_challenge_session(
            session.pk,
            operator=self.admin,
            command_id="acceptance-confirm-session",
            expected_revision=session.revision,
        )
        final_round = create_final_round_from_challenge(
            session.pk,
            operator=self.admin,
            command_id="acceptance-create-final",
            expected_revision=session.revision,
        )
        self.assertEqual(final_round.status, ContestRound.Status.PREPARED)
        self.assertEqual(
            list(final_round.entries.order_by("running_order").values_list("singer_id", flat=True)),
            [
                self.singers[14].pk,
                self.singers[13].pk,
                *[singer.pk for singer in self.singers[2:10]],
            ],
        )
        self.assertEqual(final_round.scoring_mode, ContestRound.ScoringMode.AVERAGE)

        final_entries = list(final_round.entries.order_by("running_order", "pk"))
        self._score_performances(
            final_round,
            [Decimal(100 - index) for index in range(len(final_entries))],
            self.judges[1:],
        )
        lock_round(final_round, self.admin)
        result = build_podium_result(frozen, self.activity)
        self.assertEqual(result.status, "ready")
        singer_three_score = next(
            decision.score
            for decision in result.decisions
            if decision.contestant == str(self.singers[2].pk)
        )
        self.assertEqual(singer_three_score, Decimal("97.70"))
        self.assertEqual([award.award for award in result.awards], ["冠军", "亚军", "季军"])
