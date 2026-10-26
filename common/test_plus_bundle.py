import json
import tempfile
from pathlib import Path

from common.authority import ACTIVITY_STATE, authority_write
from core.models import Activity
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase
from singer_contest.models import SingerRegistration


class ExportPlusBundleTests(TestCase):
    def _activity(self) -> Activity:
        with authority_write(ACTIVITY_STATE):
            return Activity.objects.create(
                title="2025 院十佳",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_CLOSED,
                public_code="LEG2025",
                is_test_mode=False,
            )

    def _registration(self, activity: Activity, name: str, *, test_data: bool = False):
        user = get_user_model().objects.create_user(
            username=f"legacy-{name}", password="participant-password"
        )
        return SingerRegistration.objects.create(
            activity=activity,
            user=user,
            name=name,
            student_id=f"2025{name}",
            college="信息学院",
            class_name="1 班",
            phone="13800000000",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=test_data,
        )

    def test_export_skips_test_rows_and_never_copies_secrets(self) -> None:
        activity = self._activity()
        self._registration(activity, "Alice")
        self._registration(activity, "TestOnly", test_data=True)
        output = Path(tempfile.mkdtemp()) / "bundle.json"

        call_command("export_plus_bundle", activity="LEG2025", output=str(output))

        bundle = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(bundle["format"], "artflow-plus-legacy-bundle")
        self.assertEqual(bundle["version"], 1)
        self.assertEqual(bundle["counts"]["registrations"], 1)
        self.assertEqual(bundle["counts"]["approvedRegistrations"], 1)
        self.assertEqual(bundle["excluded"]["testRegistrations"], 1)
        self.assertEqual(len(bundle["registrations"]), 1)
        self.assertEqual(bundle["registrations"][0]["answers"]["name"], "Alice")
        serialized = output.read_text(encoding="utf-8")
        for forbidden in ("password", "token", "session_key", "ip_address"):
            self.assertNotIn(forbidden, serialized)
