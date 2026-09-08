from common.authority import (
    EPHEMERAL_SESSION_STATE,
    ENTRY_POINT_CONFIG,
    JUDGE_PANEL_STATE,
    JUDGE_SCORE_SUBMISSION,
    JUDGE_SESSION_STATE,
    SCORE_FACT_WRITE,
    TICKET_SESSION_STATE,
)
from common.models import AuditLog
from django.core.exceptions import ValidationError
from django.test import TestCase

from .models import (
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
            "JUDGE_PERFORMANCE_ADVANCE",
            "JUDGE_PERFORMANCE_HOLD",
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
        with self.assertRaises(ValidationError):
            RoundPanelSnapshot().save()

