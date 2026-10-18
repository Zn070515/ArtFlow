import json
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
from .services import build_result_closure, maybe_resolve_checkpoints


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
                user = User.objects.create_user(username=f"podium-singer-{number}", password="pass")
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
                definition=json.dumps(
                    {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]}
                ),
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

    def test_normal_result_recompute_publishes_podium_candidate(self):
        self.activity.phase = Activity.Phase.RESULTS_PENDING
        with authority_write(ACTIVITY_STATE):
            self.activity.save(update_fields=["phase"])

        resolved = maybe_resolve_checkpoints(self.activity, self.staff)

        self.assertEqual(resolved, ["final_podium"])
        stage = StageResult.objects.get(activity=self.activity, stage_key="final_podium")
        self.assertEqual(stage.status, StageResult.Status.READY_TO_CONFIRM)
        closure = build_result_closure(self.activity)
        podium = next(stage for stage in closure.stages if stage.stage_key == "final_podium")
        self.assertEqual(
            podium.required_raw_facts["rounds"], (self.first_round.pk, self.final_round.pk)
        )
        self.assertTrue(podium.confirmable)

    def _make_podium_tie(self):
        """Make the top two finalists carry identical first- and third-round scores."""

        tied = self.singers[:2]
        first_score = ScoreSummary.objects.get(
            round=self.first_round, singer=tied[0]
        ).average_score
        third_score = ScoreSummary.objects.get(
            round=self.final_round, singer=tied[0]
        ).average_score
        with authority_write(SCORE_SUMMARY_RECALCULATE):
            for singer in tied:
                ScoreSummary.objects.filter(round=self.first_round, singer=singer).update(
                    average_score=first_score
                )
                ScoreSummary.objects.filter(round=self.final_round, singer=singer).update(
                    average_score=third_score
                )
        self.activity.phase = Activity.Phase.RESULTS_PENDING
        with authority_write(ACTIVITY_STATE):
            self.activity.save(update_fields=["phase"])
        return tied

    def test_a_podium_tie_needs_an_audited_manual_ordering_before_it_can_confirm(self):
        from .models import Award
        from .podium_services import create_podium_tie_decision, persist_podium_result
        from .services import confirm_stage_result

        tied = self._make_podium_tie()
        result = build_podium_result(self.version, self.activity)
        self.assertEqual(result.status, "review")
        self.assertIn("podium_tie_requires_review", result.reasons)
        self.assertEqual(result.awards, ())

        stage = persist_podium_result(self.version, self.activity, computed_by=self.staff)
        self.assertEqual(stage.status, StageResult.Status.REVIEW)
        with self.assertRaises(ValidationError):
            confirm_stage_result(stage, confirmed_by=self.staff)

        decision = create_podium_tie_decision(
            stage,
            ordering=[tied[1].pk, tied[0].pk],
            reason="同分，经评委组复议按第三轮表现排序",
            operator=self.staff,
            base_input_fingerprint=stage.input_fingerprint,
        )
        self.assertEqual(decision.ordering, [tied[1].pk, tied[0].pk])

        stage.refresh_from_db()
        self.assertEqual(stage.status, StageResult.Status.READY_TO_CONFIRM)
        rebuilt = build_podium_result(self.version, self.activity)
        self.assertEqual(rebuilt.status, "ready")
        self.assertEqual(
            [row.contestant for row in rebuilt.decisions[:2]],
            [str(tied[1].pk), str(tied[0].pk)],
        )

        confirmed = confirm_stage_result(stage, confirmed_by=self.staff)
        self.assertEqual(confirmed.status, StageResult.Status.CONFIRMED)
        champion = Award.objects.get(source_stage_result=confirmed, name="冠军")
        self.assertEqual(champion.singer_id, tied[1].pk)

    def test_a_tie_decision_is_ignored_after_the_raw_scores_change(self):
        from .podium_services import create_podium_tie_decision, persist_podium_result

        tied = self._make_podium_tie()
        stage = persist_podium_result(self.version, self.activity, computed_by=self.staff)
        create_podium_tie_decision(
            stage,
            ordering=[tied[1].pk, tied[0].pk],
            reason="同分裁决",
            operator=self.staff,
            base_input_fingerprint=stage.input_fingerprint,
        )
        stage.refresh_from_db()
        self.assertEqual(stage.status, StageResult.Status.READY_TO_CONFIRM)

        # Still tied, but at a different score: the decision's fingerprint is now stale.
        with authority_write(SCORE_SUMMARY_RECALCULATE):
            for singer in tied:
                ScoreSummary.objects.filter(round=self.final_round, singer=singer).update(
                    average_score=Decimal("90")
                )

        rebuilt = build_podium_result(self.version, self.activity)
        self.assertEqual(rebuilt.status, "review")
        self.assertIn("podium_tie_requires_review", rebuilt.reasons)

    def test_the_staff_page_records_a_podium_tie_decision(self):
        from django.urls import reverse

        from .podium_services import persist_podium_result

        tied = self._make_podium_tie()
        stage = persist_podium_result(self.version, self.activity, computed_by=self.staff)
        self.client.force_login(self.staff)

        response = self.client.post(
            reverse("staff:stage_result_podium_tie", args=[stage.pk]),
            {
                "base_input_fingerprint": stage.input_fingerprint,
                "base_candidate_revision": stage.candidate_revision,
                f"order_{tied[0].pk}": "2",
                f"order_{tied[1].pk}": "1",
                "reason": "同分，经评委组复议按第三轮表现排序",
            },
            follow=True,
        )

        self.assertContains(response, "已记录人工并列裁决")
        stage.refresh_from_db()
        self.assertEqual(stage.status, StageResult.Status.READY_TO_CONFIRM)

    def test_a_stale_tie_decision_page_cannot_overwrite_a_newer_ordering(self):
        from .models import PodiumTieDecision
        from .podium_services import create_podium_tie_decision, persist_podium_result

        tied = self._make_podium_tie()
        stage = persist_podium_result(self.version, self.activity, computed_by=self.staff)
        base_revision = stage.candidate_revision
        create_podium_tie_decision(
            stage,
            ordering=[tied[0].pk, tied[1].pk],
            reason="甲：同分复议",
            operator=self.staff,
            base_input_fingerprint=stage.input_fingerprint,
            base_candidate_revision=base_revision,
        )
        stage.refresh_from_db()

        with self.assertRaisesRegex(ValidationError, "候选结果已被其他工作人员更新"):
            create_podium_tie_decision(
                stage,
                ordering=[tied[1].pk, tied[0].pk],
                reason="乙：旧页面",
                operator=self.staff,
                base_input_fingerprint=stage.input_fingerprint,
                base_candidate_revision=base_revision,
            )

        decision = PodiumTieDecision.objects.get(
            activity=self.activity, ruleset_version=self.version, stage_key="final_podium"
        )
        self.assertEqual(decision.ordering, [tied[0].pk, tied[1].pk])

    def test_a_stale_confirmation_cannot_finalize_a_candidate_the_operator_did_not_see(self):
        from .podium_services import create_podium_tie_decision, persist_podium_result
        from .services import confirm_stage_result

        tied = self._make_podium_tie()
        stage = persist_podium_result(self.version, self.activity, computed_by=self.staff)
        create_podium_tie_decision(
            stage,
            ordering=[tied[0].pk, tied[1].pk],
            reason="甲：A 在前",
            operator=self.staff,
            base_input_fingerprint=stage.input_fingerprint,
            base_candidate_revision=stage.candidate_revision,
        )
        stage.refresh_from_db()
        seen_revision = stage.candidate_revision

        # Another staff member replaces the ordering while the first page stays open.
        create_podium_tie_decision(
            stage,
            ordering=[tied[1].pk, tied[0].pk],
            reason="乙：B 在前",
            operator=self.staff,
            base_input_fingerprint=stage.input_fingerprint,
            base_candidate_revision=seen_revision,
        )
        stage.refresh_from_db()
        self.assertGreater(stage.candidate_revision, seen_revision)

        with self.assertRaisesRegex(ValidationError, "候选结果已被其他工作人员更新"):
            confirm_stage_result(
                stage,
                confirmed_by=self.staff,
                expected_candidate_revision=seen_revision,
            )
        stage.refresh_from_db()
        self.assertNotEqual(stage.status, StageResult.Status.CONFIRMED)

        confirmed = confirm_stage_result(
            stage,
            confirmed_by=self.staff,
            expected_candidate_revision=stage.candidate_revision,
        )
        self.assertEqual(confirmed.status, StageResult.Status.CONFIRMED)

    def test_a_fresh_page_can_correct_a_tie_ordering(self):
        from common.models import AuditLog

        from .models import PodiumTieDecision
        from .podium_services import create_podium_tie_decision, persist_podium_result

        tied = self._make_podium_tie()
        stage = persist_podium_result(self.version, self.activity, computed_by=self.staff)
        create_podium_tie_decision(
            stage,
            ordering=[tied[0].pk, tied[1].pk],
            reason="第一次裁决",
            operator=self.staff,
            base_input_fingerprint=stage.input_fingerprint,
            base_candidate_revision=stage.candidate_revision,
        )
        stage.refresh_from_db()

        create_podium_tie_decision(
            stage,
            ordering=[tied[1].pk, tied[0].pk],
            reason="更正裁决",
            operator=self.staff,
            base_input_fingerprint=stage.input_fingerprint,
            base_candidate_revision=stage.candidate_revision,
        )

        decision = PodiumTieDecision.objects.get(
            activity=self.activity, ruleset_version=self.version, stage_key="final_podium"
        )
        self.assertEqual(decision.ordering, [tied[1].pk, tied[0].pk])
        audits = AuditLog.objects.filter(
            action_type=AuditLog.ActionType.MANUAL_DECISION,
            target=f"StageResult:{stage.pk}",
        ).order_by("pk")
        self.assertEqual(audits.count(), 2)
        self.assertIn('"ordering"', audits.last().old_value)
        self.assertIn(str(tied[1].pk), audits.last().new_value)

    def test_a_tie_decision_cannot_move_someone_across_score_groups(self):
        from .podium_services import create_podium_tie_decision, persist_podium_result

        tied = self._make_podium_tie()
        stage = persist_podium_result(self.version, self.activity, computed_by=self.staff)

        with self.assertRaisesRegex(ValidationError, "只能针对当前同分组"):
            create_podium_tie_decision(
                stage,
                ordering=[tied[0].pk, tied[1].pk, self.singers[2].pk],
                reason="跨分数组重排",
                operator=self.staff,
                base_input_fingerprint=stage.input_fingerprint,
            )
