from common.models import AuditLog
from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import TestCase

from .models import Activity, ActivityPhase, QRCodeLink
from .policies import ActivityAction, allowed_actions, ensure_activity_action_allowed
from .services import enter_archived_phase, transition_activity_phase

User = get_user_model()


class CoreModelTests(TestCase):
    def test_activity_phase_and_qr_link_models_exist(self):
        activity = Activity.objects.create(
            title="Singer Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
        )
        phase = ActivityPhase.objects.create(
            activity=activity,
            phase=Activity.Phase.REGISTRATION_OPEN,
            name="Registration",
        )
        qr_link = QRCodeLink.objects.create(
            activity=activity,
            kind=QRCodeLink.Kind.REGISTRATION,
            title="Apply",
            target_url="/contest/apply/",
        )
        self.assertEqual(str(phase), "Singer Contest - Registration")
        self.assertEqual(str(qr_link), "Singer Contest - Apply")

    def test_activity_requires_lifecycle_service_to_promote_to_formal(self):
        activity = Activity.objects.create(
            title="Test Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=True,
        )
        activity.is_test_mode = False
        with self.assertRaises(ValidationError):
            activity.save()

    def test_activity_forbids_formal_activity_reentering_test_mode(self):
        activity = Activity.objects.create(
            title="Formal Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
        )
        activity.is_test_mode = True
        with self.assertRaises(ValidationError):
            activity.save()

    def test_activity_allows_transition_when_lifecycle_flag_set(self):
        activity = Activity.objects.create(
            title="Test Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=True,
        )
        activity.is_test_mode = False
        activity.save(_allow_lifecycle_transition=True)
        activity.refresh_from_db()
        self.assertFalse(activity.is_test_mode)
        self.assertEqual(activity.data_lifecycle, Activity.DataLifecycle.FORMAL)


class ActivityPhasePolicyTests(TestCase):
    def _activity(self, phase=None):
        return Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            **({"phase": phase} if phase is not None else {}),
        )

    def test_draft_does_not_allow_scoring(self):
        activity = self._activity()
        self.assertEqual(activity.phase, Activity.Phase.DRAFT)
        self.assertNotIn(ActivityAction.SCORE, allowed_actions(activity))

    def test_registration_open_allows_submission(self):
        activity = self._activity(Activity.Phase.REGISTRATION_OPEN)
        self.assertIn(ActivityAction.SUBMIT_REGISTRATION, allowed_actions(activity))

    def test_results_published_cannot_change_registration_state(self):
        activity = self._activity(Activity.Phase.RESULTS_PUBLISHED)
        for action in (
            ActivityAction.SUBMIT_REGISTRATION,
            ActivityAction.REVIEW_REGISTRATION,
            ActivityAction.UPLOAD_MATERIAL,
            ActivityAction.SCORE,
        ):
            self.assertNotIn(action, allowed_actions(activity))

    def test_archived_is_read_only(self):
        activity = self._activity(Activity.Phase.ARCHIVED)
        for action in (
            ActivityAction.SUBMIT_REGISTRATION,
            ActivityAction.REVIEW_REGISTRATION,
            ActivityAction.UPLOAD_MATERIAL,
            ActivityAction.SCORE,
            ActivityAction.MANAGE_VOTE,
        ):
            self.assertNotIn(action, allowed_actions(activity))

    def test_ensure_activity_action_allowed_raises_when_disallowed(self):
        activity = self._activity(Activity.Phase.ARCHIVED)
        with self.assertRaises(PermissionDenied):
            ensure_activity_action_allowed(activity, ActivityAction.UPLOAD_MATERIAL)

    def test_ensure_activity_action_allowed_passes_when_allowed(self):
        activity = self._activity(Activity.Phase.LIVE)
        ensure_activity_action_allowed(activity, ActivityAction.SCORE)


class ActivityPhaseTransitionTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="phase-admin", password="pass")
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.DRAFT,
        )

    def test_forward_transition_succeeds_and_audits(self):
        result = transition_activity_phase(
            self.activity, Activity.Phase.REGISTRATION_OPEN, actor=self.user
        )
        self.assertEqual(result.phase, Activity.Phase.REGISTRATION_OPEN)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.PHASE_TRANSITION,
                operator=self.user,
                old_value=Activity.Phase.DRAFT,
                new_value=Activity.Phase.REGISTRATION_OPEN,
            ).exists()
        )

    def test_backward_transition_is_rejected(self):
        live = Activity.objects.create(
            title="Live",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.LIVE,
        )
        with self.assertRaises(PermissionDenied):
            transition_activity_phase(live, Activity.Phase.DRAFT, actor=self.user)
        live.refresh_from_db()
        self.assertEqual(live.phase, Activity.Phase.LIVE)

    def test_archived_cannot_return_to_live(self):
        archived = Activity.objects.create(
            title="Archived",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.ARCHIVED,
        )
        with self.assertRaises(PermissionDenied):
            transition_activity_phase(archived, Activity.Phase.LIVE, actor=self.user)

    def test_same_phase_is_noop_and_does_not_audit(self):
        transition_activity_phase(self.activity, Activity.Phase.DRAFT, actor=self.user)
        self.assertFalse(
            AuditLog.objects.filter(action_type=AuditLog.ActionType.PHASE_TRANSITION).exists()
        )

    def test_unknown_phase_is_rejected(self):
        with self.assertRaises(ValidationError):
            transition_activity_phase(self.activity, "not_a_phase", actor=self.user)

    def test_generic_transition_rejects_archived(self):
        with self.assertRaises(PermissionDenied):
            transition_activity_phase(self.activity, Activity.Phase.ARCHIVED, actor=self.user)
        self.activity.refresh_from_db()
        self.assertEqual(self.activity.phase, Activity.Phase.DRAFT)
        self.assertFalse(
            AuditLog.objects.filter(action_type=AuditLog.ActionType.PHASE_TRANSITION).exists()
        )

    def test_archived_phase_only_entered_via_archive_authority(self):
        result = enter_archived_phase(self.activity, actor=self.user)
        self.assertEqual(result.phase, Activity.Phase.ARCHIVED)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.PHASE_TRANSITION,
                operator=self.user,
                old_value=Activity.Phase.DRAFT,
                new_value=Activity.Phase.ARCHIVED,
            ).exists()
        )
        # No generic successor set may reach ARCHIVED; only the archive service does.
        expecting_archived = Activity.objects.create(
            title="Second",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.RESULTS_PUBLISHED,
        )
        with self.assertRaises(PermissionDenied):
            transition_activity_phase(expecting_archived, Activity.Phase.ARCHIVED, actor=self.user)
