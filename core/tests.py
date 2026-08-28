from django.core.exceptions import ValidationError
from django.test import TestCase

from .models import Activity, ActivityPhase, QRCodeLink


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
