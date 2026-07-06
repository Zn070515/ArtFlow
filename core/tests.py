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
