"""Remove only an exact non-production media-download rehearsal fixture.

Mirrors ``cleanup_result_release_rehearsal``: every identifier in the fixture is
re-checked against the row it claims to be before anything is deleted, and the activity
and user rows — which the normal ORM refuses to delete — go through narrowly scoped SQL
inside the same transaction.
"""

from __future__ import annotations

import json
from argparse import ArgumentParser
from pathlib import Path
from typing import Any, cast

from accounts.models import User
from core.models import Activity
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from files.models import SubmissionFile
from singer_contest.models import SingerRegistration

from common.authority import TEST_DATA_CLEANUP, authority_write

REHEARSAL_TARGET_PREFIX = "Media download rehearsal "


class Command(BaseCommand):
    help = "Remove an exact development-only media download rehearsal fixture."

    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument("--fixture", required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        if settings.APP_ENV == "production":
            raise CommandError("Media download rehearsal cleanup is disabled in production.")
        fixture_path = Path(options["fixture"]).expanduser()
        try:
            fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
            activity_id = int(fixture["activity_id"])
            activity_title = str(fixture["activity_title"])
            owner_id = int(fixture["owner_id"])
            owner_username = str(fixture["owner_username"])
            registration_id = int(fixture["registration_id"])
            submission_file_id = int(fixture["submission_file_id"])
            media_path = Path(str(fixture["media_path"]))
            session_key = str(fixture["session_key"])
            cleanup_activity_ids = [int(value) for value in fixture["cleanup_activity_ids"]]
        except (OSError, KeyError, TypeError, ValueError) as error:
            raise CommandError("Invalid media download rehearsal fixture.") from error

        if cleanup_activity_ids != [activity_id]:
            raise CommandError("Fixture activity scope is inconsistent.")
        if not activity_title.startswith(REHEARSAL_TARGET_PREFIX):
            raise CommandError("Refusing to clean an activity outside the rehearsal scope.")
        if any(
            value <= 0 for value in (activity_id, owner_id, registration_id, submission_file_id)
        ):
            raise CommandError("Fixture identifiers must be positive.")

        activity = Activity._base_manager.filter(pk=activity_id).first()
        if activity is not None and activity.title != activity_title:
            raise CommandError("Refusing to clean an activity outside the rehearsal scope.")
        owner = User._base_manager.filter(pk=owner_id).first()
        if owner is not None and owner.username != owner_username:
            raise CommandError("Refusing to clean a non-rehearsal user.")
        registration = SingerRegistration._base_manager.filter(pk=registration_id).first()
        if registration is not None and registration.activity_id != activity_id:
            raise CommandError("Refusing to clean a registration outside the rehearsal scope.")
        submission_file = SubmissionFile._base_manager.filter(pk=submission_file_id).first()
        if (
            submission_file is not None
            and submission_file.singer_registration_id != registration_id
        ):
            raise CommandError("Refusing to clean a submission file outside the rehearsal scope.")

        media_root = Path(settings.MEDIA_ROOT).resolve()
        media_file = (media_root / media_path).resolve()
        if media_root not in media_file.parents:
            raise CommandError("Refusing to remove media outside MEDIA_ROOT.")

        with transaction.atomic(), authority_write(TEST_DATA_CLEANUP):
            SubmissionFile._base_manager.filter(pk=submission_file_id).delete()
            SingerRegistration._base_manager.filter(pk=registration_id).delete()
            self._delete_exact_activity_row(activity_id)
            self._delete_exact_user_row(owner_id)
            if session_key:
                self._delete_exact_session_row(session_key)

        try:
            media_file.unlink()
        except FileNotFoundError:
            pass
        self.stdout.write(self.style.SUCCESS("Media download rehearsal fixture cleaned."))

    @staticmethod
    def _delete_exact_activity_row(activity_id: int) -> None:
        """Delete only the prevalidated rehearsal activity in non-production.

        Formal activities are intentionally not deletable through the normal ORM; this
        narrowly scoped SQL is the cleanup boundary for an isolated rehearsal fixture.
        """
        table = connection.ops.quote_name(cast(str, Activity._meta.db_table))
        column = connection.ops.quote_name(cast(str, Activity._meta.pk.column))
        with connection.cursor() as cursor:
            cursor.execute(f"DELETE FROM {table} WHERE {column} = %s", [activity_id])

    @staticmethod
    def _delete_exact_user_row(owner_id: int) -> None:
        """Delete the already validated, dedicated rehearsal user row."""
        table = connection.ops.quote_name(cast(str, User._meta.db_table))
        column = connection.ops.quote_name(cast(str, User._meta.pk.column))
        with connection.cursor() as cursor:
            cursor.execute(f"DELETE FROM {table} WHERE {column} = %s", [owner_id])

    @staticmethod
    def _delete_exact_session_row(session_key: str) -> None:
        """Delete the session this fixture minted, so no live cookie outlives it."""
        table = connection.ops.quote_name(cast(str, "django_session"))
        with connection.cursor() as cursor:
            cursor.execute(f"DELETE FROM {table} WHERE session_key = %s", [session_key])
