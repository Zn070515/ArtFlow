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

from .judge_authority import (
    advance_performance,
    hold_judge_panel,
    hold_performance,
    prepare_judge_panel,
    resume_judge_panel,
    resume_performance,
)
from .models import (
    ContestRound,
    JudgeSeat,
    JudgeSeatGrant,
    JudgeSession,
    PerformanceRunState,
    RoundPanelSnapshot,
    RoundPanelSnapshotMember,
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
            self.assertLessEqual(len(action), AuditLog._meta.get_field("action_type").max_length)

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
            is_test_data=True,
        )
        with authority_write(CONTEST_ROUND_STATE):
            self.round.status = ContestRound.Status.PREPARED
            self.round.save(update_fields=["status"])

    def test_prepare_panel_creates_immutable_snapshot_seat_and_live_context(self):
        snapshot = prepare_judge_panel(self.round.pk, operator=self.operator)

        self.assertEqual(snapshot.version, 1)
        self.assertEqual(snapshot.change_policy, RoundPanelSnapshot.ChangePolicy.HOLD_ONLY)
        self.assertEqual(snapshot.expected_judge_count, 1)
        self.assertEqual(snapshot.minimum_judge_count, 1)
        self.assertEqual(snapshot.members.count(), 1)
        self.assertEqual(snapshot.members.first().seats.count(), 1)
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
