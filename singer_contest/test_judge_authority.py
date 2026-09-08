from decimal import Decimal

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    ENTRY_POINT_CONFIG,
    EPHEMERAL_SESSION_STATE,
    JUDGE_PANEL_STATE,
    JUDGE_SCORE_SUBMISSION,
    JUDGE_SESSION_STATE,
    SCORE_FACT_WRITE,
    TICKET_SESSION_STATE,
    authority_write,
)
from common.models import AuditLog
from core.models import Activity
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import TestCase
from entry_access.services import redeem_access_grant

from .judge_authority import (
    JudgeIdempotencyConflict,
    advance_performance,
    authenticate_judge_session,
    get_judge_context,
    hold_judge_panel,
    hold_performance,
    issue_judge_grant,
    prepare_judge_panel,
    resume_judge_panel,
    resume_performance,
    submit_judge_score,
    submit_paper_score,
    submit_staff_proxy_score,
)
from .models import (
    ContestRound,
    CriterionScore,
    JudgeSeat,
    JudgeSeatGrant,
    JudgeSession,
    PerformanceRunState,
    RoundPanelSnapshot,
    RoundPanelSnapshotMember,
    RubricCriterion,
    ScoreRecord,
    ScoreSource,
    ScoringRubric,
)


class JudgeAuthorityVocabularyTests(TestCase):
    def test_judge_authority_scopes_are_explicit_and_distinct(self):
        scopes = {
            JUDGE_PANEL_STATE,
            JUDGE_SESSION_STATE,
            JUDGE_SCORE_SUBMISSION,
            SCORE_FACT_WRITE,
        }

        self.assertEqual(len(scopes), 4)
        self.assertTrue(scopes.isdisjoint({ENTRY_POINT_CONFIG, EPHEMERAL_SESSION_STATE}))
        self.assertTrue(scopes.isdisjoint({TICKET_SESSION_STATE}))

    def test_judge_audit_actions_fit_storage_limit(self):
        action_names = (
            "JUDGE_PANEL_PREPARE",
            "JUDGE_PANEL_CHANGE",
            "JUDGE_PANEL_HOLD",
            "JUDGE_SEAT_ASSIGN",
            "JUDGE_SEAT_REVOKE",
            "JUDGE_SESSION_ISSUE",
            "JUDGE_SESSION_REVOKE",
            "JUDGE_PERF_ADVANCE",
            "JUDGE_PERF_HOLD",
            "JUDGE_SCORE_SUBMIT",
            "JUDGE_SCORE_PROXY",
            "JUDGE_SCORE_PAPER",
        )

        for action_name in action_names:
            action = getattr(AuditLog.ActionType, action_name)
            max_length = AuditLog._meta.get_field("action_type").max_length
            assert max_length is not None
            self.assertLessEqual(len(action), max_length)

    def test_judge_model_contracts_exist_and_are_guarded(self):
        for model in (
            RoundPanelSnapshot,
            RoundPanelSnapshotMember,
            JudgeSeat,
            JudgeSeatGrant,
            JudgeSession,
            PerformanceRunState,
        ):
            self.assertTrue(hasattr(model, "objects"))

        self.assertTrue(hasattr(JudgeSession, "expires_at"))
        self.assertTrue(hasattr(JudgeSession, "revoked_at"))
        self.assertTrue(hasattr(PerformanceRunState, "context_version"))

    def test_direct_authority_model_creation_rejects_missing_service_scope(self):
        for model in (
            RoundPanelSnapshot,
            RoundPanelSnapshotMember,
            JudgeSeat,
            JudgeSeatGrant,
            JudgeSession,
            PerformanceRunState,
        ):
            with self.subTest(model=model.__name__), self.assertRaises(ValidationError):
                model().save()


class JudgeAuthorityModelGuardTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.operator = User.objects.create_user(
                username="judge-authority", password="pass", role=User.Role.STAFF
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Judge authority",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        with authority_write(CONTEST_ROUND_STATE):
            self.round = self.activity.rounds.create(round_type="preliminary", name="Preliminary")
        from .models import Judge, RoundJudge

        self.judge = Judge.objects.create(activity=self.activity, name="Judge A")
        self.round_judge = RoundJudge.objects.create(round=self.round, judge=self.judge)

    def _panel_rows(self):
        with authority_write(JUDGE_PANEL_STATE):
            snapshot = RoundPanelSnapshot.objects.create(
                round=self.round,
                activity=self.activity,
                version=1,
                change_policy=RoundPanelSnapshot.ChangePolicy.HOLD_ONLY,
                state=RoundPanelSnapshot.State.ACTIVE,
                expected_judge_count=1,
                minimum_judge_count=1,
                scoring_method="average",
                roster_digest="a" * 64,
                captured_by=self.operator,
                is_test_data=True,
            )
            member = RoundPanelSnapshotMember.objects.create(
                panel_snapshot=snapshot,
                judge=self.judge,
                source_round_judge=self.round_judge,
                seat_key="seat-1",
            )
            seat = JudgeSeat.objects.create(
                panel_member=member,
                state=JudgeSeat.State.ASSIGNED,
                assigned_by=self.operator,
                is_test_data=True,
            )
        return snapshot, member, seat

    def test_query_mutations_require_explicit_authority_scope(self):
        snapshot, member, seat = self._panel_rows()

        with self.assertRaises(ValidationError):
            RoundPanelSnapshot.objects.filter(pk=snapshot.pk).update(
                state=RoundPanelSnapshot.State.HOLD
            )
        with self.assertRaises(ValidationError):
            RoundPanelSnapshot.objects.bulk_update(
                [RoundPanelSnapshot(pk=snapshot.pk, state=RoundPanelSnapshot.State.HOLD)],
                ["state"],
            )
        with self.assertRaises(ValidationError):
            RoundPanelSnapshot.objects.bulk_create(
                [
                    RoundPanelSnapshot(
                        round=self.round,
                        activity=self.activity,
                        version=2,
                        change_policy=RoundPanelSnapshot.ChangePolicy.HOLD_ONLY,
                        state=RoundPanelSnapshot.State.ACTIVE,
                        expected_judge_count=1,
                        minimum_judge_count=1,
                        scoring_method="average",
                        roster_digest="b" * 64,
                        is_test_data=True,
                    )
                ]
            )
        with self.assertRaises(ValidationError):
            JudgeSeat.objects.filter(pk=seat.pk).delete()

        self.assertEqual(RoundPanelSnapshot._base_manager.get(pk=snapshot.pk).state, "active")
        self.assertEqual(
            RoundPanelSnapshotMember._base_manager.get(pk=member.pk).seat_key, "seat-1"
        )

    def test_direct_score_source_cannot_be_fabricated_by_ordinary_orm_write(self):
        snapshot, _, seat = self._panel_rows()
        from .models import SingerRegistration

        with authority_write(ACCOUNT_AUTHORITY):
            singer_user = User.objects.create_user(
                username="judge-authority-singer", password="pass", role=User.Role.PARTICIPANT
            )
        singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=singer_user,
            name="Singer",
            student_id="guard-001",
            college="Arts",
            class_name="Class 1",
            phone="13800000000",
            song_name="Song",
            is_test_data=True,
        )
        with self.assertRaises(ValidationError):
            ScoreRecord.objects.create(
                round=self.round,
                singer=singer,
                judge=self.judge,
                score=90,
                source=ScoreSource.DIRECT_JUDGE,
                panel_snapshot=snapshot,
                judge_seat=seat,
                source_command_id="forged-command",
                is_test_data=True,
            )

    def test_snapshot_member_rejects_cross_round_source(self):
        snapshot, _, _ = self._panel_rows()
        with authority_write(CONTEST_ROUND_STATE):
            other_round = self.activity.rounds.create(round_type="semi_final", name="Semi-final")
        from .models import RoundJudge

        with authority_write(JUDGE_PANEL_STATE):
            other_round_judge = RoundJudge.objects.create(round=other_round, judge=self.judge)
            member = RoundPanelSnapshotMember(
                panel_snapshot=snapshot,
                judge=self.judge,
                source_round_judge=other_round_judge,
                seat_key="seat-2",
            )
            with self.assertRaises(ValidationError):
                member.save()


class JudgePanelServiceTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.operator = User.objects.create_user(
                username="judge-service", password="pass", role=User.Role.STAFF
            )
            self.singer_user = User.objects.create_user(
                username="judge-singer", password="pass", role=User.Role.PARTICIPANT
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Judge service",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_OPEN,
                is_test_mode=True,
            )
        from .models import Judge, Performance, RoundEntry, RoundJudge, SingerRegistration

        with authority_write(CONTEST_ROUND_STATE):
            self.round = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="Service round",
            )
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.singer_user,
            name="Singer",
            student_id="judge-001",
            college="Arts",
            class_name="Class 1",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        self.judge = Judge.objects.create(activity=self.activity, name="Judge A")
        RoundEntry.objects.create(round=self.round, singer=self.singer, running_order=1)
        RoundJudge.objects.create(round=self.round, judge=self.judge)
        self.performance = Performance.objects.create(
            activity=self.activity,
            round=self.round,
            singer=self.singer,
            sequence=1,
            song_title="Song title",
            is_test_data=True,
        )
        with authority_write(CONTEST_ROUND_STATE):
            self.round.status = ContestRound.Status.PREPARED
            self.round.save(update_fields=["status"])

    def _bind_rubric(self, *max_scores: str) -> tuple[ScoringRubric, list[RubricCriterion]]:
        rubric = ScoringRubric.objects.create(
            activity=self.activity,
            name="Judge rubric",
            is_test_data=True,
        )
        criteria = [
            RubricCriterion.objects.create(
                rubric=rubric,
                name=f"Criterion {index}",
                max_score=Decimal(max_score),
                sequence=index,
                is_test_data=True,
            )
            for index, max_score in enumerate(max_scores, start=1)
        ]
        with authority_write(CONTEST_ROUND_STATE):
            self.round.rubric = rubric
            self.round.save(update_fields=["rubric"])
        return rubric, criteria

    def test_prepare_panel_creates_immutable_snapshot_seat_and_live_context(self):
        snapshot = prepare_judge_panel(self.round.pk, operator=self.operator)

        self.assertEqual(snapshot.version, 1)
        self.assertEqual(snapshot.change_policy, RoundPanelSnapshot.ChangePolicy.HOLD_ONLY)
        self.assertEqual(snapshot.expected_judge_count, 1)
        self.assertEqual(snapshot.minimum_judge_count, 1)
        self.assertEqual(snapshot.members.count(), 1)
        member = snapshot.members.first()
        assert member is not None
        self.assertEqual(member.seats.count(), 1)
        run_state = self.round.performance_run_state
        self.assertEqual(run_state.state, PerformanceRunState.State.IDLE)
        self.assertEqual(run_state.context_version, 0)

    def test_prepare_panel_is_idempotent_for_existing_active_snapshot(self):
        first = prepare_judge_panel(self.round.pk, operator=self.operator)
        second = prepare_judge_panel(self.round.pk, operator=self.operator)

        self.assertEqual(first.pk, second.pk)
        self.assertEqual(RoundPanelSnapshot.objects.count(), 1)
        self.assertEqual(JudgeSeat.objects.count(), 1)


    def test_prepare_panel_rejects_draft_round(self):
        from django.core.exceptions import ValidationError

        with authority_write(CONTEST_ROUND_STATE):
            self.round.status = ContestRound.Status.DRAFT
            self.round.save(update_fields=["status"])

        with self.assertRaises(ValidationError):
            prepare_judge_panel(self.round.pk, operator=self.operator)

    def test_hold_panel_blocks_context_and_records_reason(self):
        snapshot = prepare_judge_panel(self.round.pk, operator=self.operator)

        held = hold_judge_panel(self.round.pk, operator=self.operator, reason="裁判席位核验")

        self.assertEqual(held.pk, snapshot.pk)
        self.assertEqual(held.state, RoundPanelSnapshot.State.HOLD)
        self.assertEqual(self.round.performance_run_state.state, PerformanceRunState.State.HOLD)
        self.assertEqual(self.round.performance_run_state.hold_reason, "裁判席位核验")

    def test_panel_resume_is_explicit_before_live_resume(self):
        prepare_judge_panel(self.round.pk, operator=self.operator)
        hold_judge_panel(self.round.pk, operator=self.operator, reason="裁判席位核验")

        with self.assertRaises(PermissionDenied):
            resume_performance(self.round.pk, operator=self.operator)

        resumed_panel = resume_judge_panel(self.round.pk, operator=self.operator)
        self.assertEqual(resumed_panel.state, RoundPanelSnapshot.State.ACTIVE)
        self.assertEqual(
            self.round.performance_run_state.state,
            PerformanceRunState.State.IDLE,
        )

    def test_judge_grant_binds_one_seat_and_redeemed_session(self):
        snapshot = prepare_judge_panel(self.round.pk, operator=self.operator)
        seat = snapshot.members.get(seat_key="seat-1").seats.get()

        issued = issue_judge_grant(seat.pk, operator=self.operator, ttl_seconds=600)
        redeemed = redeem_access_grant(issued.token)
        session = authenticate_judge_session(redeemed.token)
        replay = authenticate_judge_session(redeemed.token)

        self.assertEqual(session.pk, replay.pk)
        self.assertEqual(session.seat_id, seat.pk)
        self.assertEqual(session.panel_snapshot_id, snapshot.pk)
        self.assertEqual(session.ephemeral_session_id, redeemed.session.pk)
        self.assertNotIn(issued.token, str(session))
        self.assertFalse(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.JUDGE_SESSION_ISSUE,
                new_value__contains=issued.token,
            ).exists()
        )

    def test_judge_context_handles_nullable_current_performance(self):
        snapshot = prepare_judge_panel(self.round.pk, operator=self.operator)
        seat = snapshot.members.get(seat_key="seat-1").seats.get()
        issued = issue_judge_grant(seat.pk, operator=self.operator, ttl_seconds=600)
        redeemed = redeem_access_grant(issued.token)

        context = get_judge_context(redeemed.token)

        self.assertEqual(context.round_id, self.round.pk)
        self.assertIsNone(context.performance_id)

    def test_judge_context_includes_current_performance_display_fields(self):
        snapshot = prepare_judge_panel(self.round.pk, operator=self.operator)
        seat = snapshot.members.get(seat_key="seat-1").seats.get()
        issued = issue_judge_grant(seat.pk, operator=self.operator, ttl_seconds=600)
        redeemed = redeem_access_grant(issued.token)
        advance_performance(self.round.pk, self.performance.pk, operator=self.operator)

        context = get_judge_context(redeemed.token)

        self.assertEqual(context.round_name, "Service round")
        self.assertEqual(context.performance_label, "第 1 个节目")
        self.assertEqual(context.singer_name, "Singer")
        self.assertEqual(context.song_title, "Song title")

    def test_rubric_score_materializes_criterion_facts_and_server_computed_total(self):
        _, criteria = self._bind_rubric("40", "60")
        snapshot = prepare_judge_panel(self.round.pk, operator=self.operator)
        seat = snapshot.members.get(seat_key="seat-1").seats.get()
        issued = issue_judge_grant(seat.pk, operator=self.operator, ttl_seconds=600)
        redeemed = redeem_access_grant(issued.token)
        advance_performance(self.round.pk, self.performance.pk, operator=self.operator)

        result = submit_judge_score(
            redeemed.token,
            command_id="judge-rubric-command-1",
            expected_context_version=1,
            expected_performance_id=self.performance.pk,
            score_payload={
                "criteria": [
                    {"criterion_id": criteria[0].pk, "value": "36.00"},
                    {"criterion_id": criteria[1].pk, "value": "54.00"},
                ],
                "notes": "rubric note",
            },
        )

        record = ScoreRecord.objects.get(pk=result.score_record_id)
        self.assertEqual(record.score, Decimal("90.00"))
        self.assertEqual(record.notes, "rubric note")
        self.assertEqual(
            list(
                CriterionScore.objects.filter(score_record=record)
                .order_by("criterion_id")
                .values_list("criterion_id", "value")
            ),
            [(criteria[0].pk, Decimal("36.00")), (criteria[1].pk, Decimal("54.00"))],
        )

    def test_rubric_score_rejects_total_only_and_keeps_authoritative_rows_empty(self):
        self._bind_rubric("100")
        snapshot = prepare_judge_panel(self.round.pk, operator=self.operator)
        seat = snapshot.members.get(seat_key="seat-1").seats.get()
        issued = issue_judge_grant(seat.pk, operator=self.operator, ttl_seconds=600)
        redeemed = redeem_access_grant(issued.token)
        advance_performance(self.round.pk, self.performance.pk, operator=self.operator)

        with self.assertRaises(ValidationError):
            submit_judge_score(
                redeemed.token,
                command_id="judge-rubric-total-only",
                expected_context_version=1,
                expected_performance_id=self.performance.pk,
                score_payload={"score": "90"},
            )

        self.assertFalse(ScoreRecord.objects.exists())
        self.assertFalse(CriterionScore.objects.exists())

    def test_rubric_score_rejects_incomplete_duplicate_and_out_of_range_criteria(self):
        _, criteria = self._bind_rubric("40", "60")
        snapshot = prepare_judge_panel(self.round.pk, operator=self.operator)
        seat = snapshot.members.get(seat_key="seat-1").seats.get()
        issued = issue_judge_grant(seat.pk, operator=self.operator, ttl_seconds=600)
        redeemed = redeem_access_grant(issued.token)
        advance_performance(self.round.pk, self.performance.pk, operator=self.operator)

        payloads = (
            [
                {"criterion_id": criteria[0].pk, "value": "36"},
            ],
            [
                {"criterion_id": criteria[0].pk, "value": "36"},
                {"criterion_id": criteria[0].pk, "value": "35"},
                {"criterion_id": criteria[1].pk, "value": "54"},
            ],
            [
                {"criterion_id": criteria[0].pk, "value": "40.01"},
                {"criterion_id": criteria[1].pk, "value": "59.99"},
            ],
        )
        for index, criterion_payload in enumerate(payloads, start=1):
            with self.subTest(case=index), self.assertRaises(ValidationError):
                submit_judge_score(
                    redeemed.token,
                    command_id=f"judge-rubric-invalid-{index}",
                    expected_context_version=1,
                    expected_performance_id=self.performance.pk,
                    score_payload={"criteria": criterion_payload, "notes": ""},
                )

        self.assertFalse(ScoreRecord.objects.exists())
        self.assertFalse(CriterionScore.objects.exists())

    def test_live_performance_transitions_increment_context_version(self):
        prepare_judge_panel(self.round.pk, operator=self.operator)

        started = advance_performance(self.round.pk, self.performance.pk, operator=self.operator)
        self.assertEqual(started.current_performance_id, self.performance.pk)
        self.assertEqual(started.state, PerformanceRunState.State.PERFORMING)
        self.assertEqual(started.context_version, 1)

        held = hold_performance(self.round.pk, operator=self.operator, reason="舞台暂停")
        self.assertEqual(held.state, PerformanceRunState.State.HOLD)
        resumed = resume_performance(self.round.pk, operator=self.operator)
        self.assertEqual(resumed.state, PerformanceRunState.State.PERFORMING)
        self.assertEqual(resumed.context_version, 1)

    def test_judge_score_is_idempotent_and_provenance_bound(self):
        snapshot = prepare_judge_panel(self.round.pk, operator=self.operator)
        seat = snapshot.members.get(seat_key="seat-1").seats.get()
        issued = issue_judge_grant(seat.pk, operator=self.operator, ttl_seconds=600)
        redeemed = redeem_access_grant(issued.token)
        advance_performance(self.round.pk, self.performance.pk, operator=self.operator)

        first = submit_judge_score(
            redeemed.token,
            command_id="judge-command-1",
            expected_context_version=1,
            expected_performance_id=self.performance.pk,
            score_payload={"score": "91.50"},
        )
        replay = submit_judge_score(
            redeemed.token,
            command_id="judge-command-1",
            expected_context_version=1,
            expected_performance_id=self.performance.pk,
            score_payload={"score": "91.50"},
        )

        self.assertEqual(first.receipt_id, replay.receipt_id)
        self.assertEqual(first.score_record_id, replay.score_record_id)
        record = ScoreRecord.objects.get(pk=first.score_record_id)
        self.assertEqual(record.source, ScoreSource.DIRECT_JUDGE)
        self.assertEqual(record.judge_seat_id, seat.pk)
        self.assertEqual(record.panel_snapshot_id, snapshot.pk)

    def test_judge_score_rejects_command_reuse_with_changed_payload(self):
        snapshot = prepare_judge_panel(self.round.pk, operator=self.operator)
        seat = snapshot.members.get(seat_key="seat-1").seats.get()
        issued = issue_judge_grant(seat.pk, operator=self.operator, ttl_seconds=600)
        redeemed = redeem_access_grant(issued.token)
        advance_performance(self.round.pk, self.performance.pk, operator=self.operator)

        submit_judge_score(
            redeemed.token,
            command_id="judge-command-conflict",
            expected_context_version=1,
            expected_performance_id=self.performance.pk,
            score_payload={"score": "91.50"},
        )
        with self.assertRaises(JudgeIdempotencyConflict):
            submit_judge_score(
                redeemed.token,
                command_id="judge-command-conflict",
                expected_context_version=1,
                expected_performance_id=self.performance.pk,
                score_payload={"score": "91.51"},
            )

    def test_judge_score_rejects_stale_context_without_partial_write(self):
        snapshot = prepare_judge_panel(self.round.pk, operator=self.operator)
        seat = snapshot.members.get(seat_key="seat-1").seats.get()
        issued = issue_judge_grant(seat.pk, operator=self.operator, ttl_seconds=600)
        redeemed = redeem_access_grant(issued.token)
        advance_performance(self.round.pk, self.performance.pk, operator=self.operator)

        with self.assertRaises(ValidationError):
            submit_judge_score(
                redeemed.token,
                command_id="judge-command-stale",
                expected_context_version=0,
                expected_performance_id=self.performance.pk,
                score_payload={"score": "91.50"},
            )
        self.assertFalse(ScoreRecord.objects.exists())

    def test_staff_proxy_and_paper_sources_are_explicit_and_idempotent(self):
        snapshot = prepare_judge_panel(self.round.pk, operator=self.operator)
        seat = snapshot.members.get(seat_key="seat-1").seats.get()
        advance_performance(self.round.pk, self.performance.pk, operator=self.operator)

        proxy = submit_staff_proxy_score(
            self.round.pk,
            self.performance.pk,
            seat.pk,
            operator=self.operator,
            command_id="proxy-command-1",
            expected_context_version=1,
            score_payload={"score": "89"},
            source_reference="现场代录表-001",
            reason="评委终端临时不可用",
        )
        proxy_record = ScoreRecord.objects.get(pk=proxy.score_record_id)
        self.assertEqual(proxy_record.source, ScoreSource.STAFF_PROXY)
        self.assertEqual(proxy_record.source_reference, "现场代录表-001")
        self.assertEqual(proxy_record.source_command_id, "proxy-command-1")

        with self.assertRaises(ValidationError):
            submit_paper_score(
                self.round.pk,
                self.performance.pk,
                seat.pk,
                operator=self.operator,
                command_id="paper-command-1",
                expected_context_version=1,
                score_payload={"score": "88"},
                paper_reference="纸面评分-001",
                reason="重复录入测试",
            )


class ActualPanelPolicyTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.operator = User.objects.create_user(
                username="actual-panel-operator", password="pass", role=User.Role.STAFF
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Actual panel policy",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_OPEN,
                is_test_mode=True,
            )
        from .models import Judge, RoundJudge

        with authority_write(CONTEST_ROUND_STATE):
            self.round = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                minimum_judge_count=4,
            )
        self.judges = [
            Judge.objects.create(activity=self.activity, name=f"Judge {index}")
            for index in range(1, 6)
        ]
        for judge in self.judges:
            RoundJudge.objects.create(round=self.round, judge=judge)
        with authority_write(CONTEST_ROUND_STATE):
            self.round.status = ContestRound.Status.PREPARED
            self.round.save(update_fields=["status"])

    def test_prepare_panel_accepts_four_attendees_from_five_judge_roster(self):
        snapshot = prepare_judge_panel(
            self.round.pk,
            operator=self.operator,
            attending_judge_ids=[judge.pk for judge in self.judges[:4]],
        )

        self.assertEqual(snapshot.expected_judge_count, 5)
        self.assertEqual(snapshot.minimum_judge_count, 4)
        self.assertEqual(snapshot.members.filter(is_active=True).count(), 4)
        self.assertEqual(
            set(snapshot.members.values_list("judge_id", flat=True)),
            {judge.pk for judge in self.judges[:4]},
        )

    def test_prepare_panel_rejects_insufficient_attendance_with_stable_reason(self):
        with self.assertRaisesMessage(ValidationError, "INSUFFICIENT_JUDGES"):
            prepare_judge_panel(
                self.round.pk,
                operator=self.operator,
                attending_judge_ids=[judge.pk for judge in self.judges[:3]],
            )

        self.assertFalse(
            RoundPanelSnapshot.objects.filter(
                round=self.round, state=RoundPanelSnapshot.State.ACTIVE
            ).exists()
        )

    def test_unconfigured_minimum_fails_safe_to_expected_roster(self):
        with authority_write(CONTEST_ROUND_STATE):
            self.round.minimum_judge_count = None
            self.round.save(update_fields=["minimum_judge_count"])

        with self.assertRaisesMessage(ValidationError, "INSUFFICIENT_JUDGES"):
            prepare_judge_panel(
                self.round.pk,
                operator=self.operator,
                attending_judge_ids=[judge.pk for judge in self.judges[:4]],
            )
