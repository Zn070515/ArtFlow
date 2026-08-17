from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError
from django.test import TestCase, override_settings

DOCTOR_SECRET_KEY_SENTINEL = "doctor-secret-key-sentinel"
DOCTOR_ADMIN_LOGIN_KEY_SENTINEL = "doctor-admin-login-key-sentinel"
DOCTOR_DATABASE_PASSWORD_SENTINEL = "doctor-database-password-sentinel"


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

    def test_doctor_reports_database_failure_with_explicit_exit_code_and_safe_output(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = StringIO()
            (root / "staticfiles").mkdir()
            (root / "media").mkdir()

            with (
                override_settings(STATIC_ROOT=root / "staticfiles", MEDIA_ROOT=root / "media"),
                patch(
                    "common.management.commands.doctor.connection.ensure_connection",
                    side_effect=DatabaseError("database-password"),
                ),
                patch(
                    "common.management.commands.doctor.Command._migrations_are_current",
                    return_value=True,
                ),
                self.assertRaises(CommandError) as error,
            ):
                call_command("doctor", stdout=output)

        self.assertEqual(error.exception.returncode, 3)
        self.assertIn("Database connection: failed", output.getvalue())
        self.assertNotIn("database-password", output.getvalue())

    def test_doctor_reports_unapplied_migrations_with_explicit_exit_code(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = StringIO()
            (root / "staticfiles").mkdir()
            (root / "media").mkdir()

            with (
                override_settings(
                    STATIC_ROOT=root / "staticfiles",
                    MEDIA_ROOT=root / "media",
                    SECRET_KEY=DOCTOR_SECRET_KEY_SENTINEL,
                    ADMIN_LOGIN_KEY=DOCTOR_ADMIN_LOGIN_KEY_SENTINEL,
                ),
                patch.dict(
                    "common.management.commands.doctor.connection.settings_dict",
                    {"PASSWORD": DOCTOR_DATABASE_PASSWORD_SENTINEL},
                ),
                patch(
                    "common.management.commands.doctor.MigrationExecutor.migration_plan",
                    return_value=[object()],
                ),
                self.assertRaises(CommandError) as error,
            ):
                call_command("doctor", stdout=output)

        self.assertEqual(error.exception.returncode, 4)
        diagnostics = output.getvalue()
        self.assertIn("Migration state: failed or unapplied", diagnostics)
        self.assertNotIn(DOCTOR_SECRET_KEY_SENTINEL, diagnostics)
        self.assertNotIn(DOCTOR_ADMIN_LOGIN_KEY_SENTINEL, diagnostics)
        self.assertNotIn(DOCTOR_DATABASE_PASSWORD_SENTINEL, diagnostics)

    def test_doctor_reports_missing_runtime_directories_with_explicit_exit_code(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = StringIO()

            with (
                override_settings(
                    STATIC_ROOT=root / "staticfiles",
                    MEDIA_ROOT=root / "media",
                    SECRET_KEY=DOCTOR_SECRET_KEY_SENTINEL,
                    ADMIN_LOGIN_KEY=DOCTOR_ADMIN_LOGIN_KEY_SENTINEL,
                ),
                patch.dict(
                    "common.management.commands.doctor.connection.settings_dict",
                    {"PASSWORD": DOCTOR_DATABASE_PASSWORD_SENTINEL},
                ),
                self.assertRaises(CommandError) as error,
            ):
                call_command("doctor", stdout=output)

        self.assertEqual(error.exception.returncode, 5)
        diagnostics = output.getvalue()
        self.assertIn("STATIC_ROOT: missing", diagnostics)
        self.assertIn("MEDIA_ROOT: missing", diagnostics)
        self.assertNotIn(DOCTOR_SECRET_KEY_SENTINEL, diagnostics)
        self.assertNotIn(DOCTOR_ADMIN_LOGIN_KEY_SENTINEL, diagnostics)
        self.assertNotIn(DOCTOR_DATABASE_PASSWORD_SENTINEL, diagnostics)
