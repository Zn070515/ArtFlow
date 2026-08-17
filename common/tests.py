from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory

from django.conf import settings
from django.core.management import call_command
from django.test import TestCase, override_settings


class DoctorCommandTests(TestCase):
    def test_doctor_reports_safe_current_environment_diagnostics(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = StringIO()

            with override_settings(STATIC_ROOT=root / "staticfiles", MEDIA_ROOT=root / "media"):
                (root / "staticfiles").mkdir()
                (root / "media").mkdir()

                call_command("doctor", stdout=output)

        diagnostics = output.getvalue()
        self.assertIn(f"Environment: {settings.APP_ENV}", diagnostics)
        self.assertIn("Database engine:", diagnostics)
        self.assertIn("Migration state:", diagnostics)
        self.assertIn("STATIC_ROOT:", diagnostics)
        self.assertIn("MEDIA_ROOT:", diagnostics)
        self.assertNotIn(settings.SECRET_KEY, diagnostics)
        self.assertNotIn(str(settings.DATABASES["default"].get("NAME", "")), diagnostics)
