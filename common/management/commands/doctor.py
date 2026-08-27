from enum import IntEnum
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.checks import ERROR, run_checks
from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.db.migrations.executor import MigrationExecutor


class DoctorExitCode(IntEnum):
    SUCCESS = 0
    CONFIGURATION_FAILURE = 2
    DATABASE_FAILURE = 3
    MIGRATION_FAILURE = 4
    DIRECTORY_FAILURE = 5


class Command(BaseCommand):
    help = "Report read-only runtime diagnostics."
    requires_system_checks = []
    requires_migrations_checks = False

    def handle(self, *args: Any, **options: Any) -> None:
        failures: list[DoctorExitCode] = []

        self.stdout.write(f"Environment: {settings.APP_ENV}")
        self.stdout.write(f"Database engine: {connection.settings_dict['ENGINE']}")

        if self._configuration_is_healthy():
            self.stdout.write("Configuration: ok")
        else:
            self.stdout.write("Configuration: failed")
            failures.append(DoctorExitCode.CONFIGURATION_FAILURE)

        if self._database_is_healthy():
            self.stdout.write("Database connection: ok")
        else:
            self.stdout.write("Database connection: failed")
            failures.append(DoctorExitCode.DATABASE_FAILURE)

        if self._migrations_are_current():
            self.stdout.write("Migration state: up to date")
        else:
            self.stdout.write("Migration state: failed or unapplied")
            failures.append(DoctorExitCode.MIGRATION_FAILURE)

        for setting_name in ("STATIC_ROOT", "MEDIA_ROOT"):
            if Path(getattr(settings, setting_name)).is_dir():
                self.stdout.write(f"{setting_name}: ready")
            else:
                self.stdout.write(f"{setting_name}: missing")
                failures.append(DoctorExitCode.DIRECTORY_FAILURE)

        if failures:
            raise CommandError("Doctor checks failed.", returncode=min(failures))

    @staticmethod
    def _configuration_is_healthy() -> bool:
        try:
            return not any(check.level >= ERROR for check in run_checks())
        except Exception:
            return False

    @staticmethod
    def _database_is_healthy() -> bool:
        try:
            connection.ensure_connection()
        except Exception:
            return False
        return True

    @staticmethod
    def _migrations_are_current() -> bool:
        try:
            executor = MigrationExecutor(connection)
            return not executor.migration_plan(executor.loader.graph.leaf_nodes())
        except Exception:
            return False
