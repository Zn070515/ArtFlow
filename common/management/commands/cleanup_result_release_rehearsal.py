"""Remove only an exact non-production result-release rehearsal fixture."""

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
from django.db.models import Q
from public_portal.models import PublicMedia, PublicPost, ResultRelease
from ruleset.models import ContestRuleset, RulesetVersion
from singer_contest.models import StageResult

from common.authority import RULESET_FREEZE, STAGE_RESULT_CONFIRM, authority_write
from common.models import AuditLog


class Command(BaseCommand):
    help = "Remove an exact development-only M2-D2 result release rehearsal fixture."

    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument("--fixture", required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        if settings.APP_ENV == "production":
            raise CommandError("Result release rehearsal cleanup is disabled in production.")
        fixture_path = Path(options["fixture"]).expanduser()
        try:
            fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
            activity_ids = [int(value) for value in fixture["cleanup_activity_ids"]]
            activity_id = int(fixture["activity_id"])
            foreign_activity_id = int(fixture["foreign_activity_id"])
            activity_title = str(fixture["activity_title"])
            foreign_activity_title = str(fixture["foreign_activity_title"])
            ruleset_ids = [int(fixture["ruleset_id"]), int(fixture["foreign_ruleset_id"])]
            ruleset_names = [str(fixture["ruleset_name"]), str(fixture["foreign_ruleset_name"])]
            version_ids = [
                int(fixture["ruleset_version_id"]),
                int(fixture["foreign_ruleset_version_id"]),
            ]
            post_id = int(fixture["post_id"])
            stage_ids = [int(fixture["stage_id"]), int(fixture["foreign_stage_id"])]
            operator_id = int(fixture["operator_id"])
            operator_username = str(fixture["operator_username"])
            media_path = Path(str(fixture["media_path"]))
        except (OSError, KeyError, TypeError, ValueError) as error:
            raise CommandError("Invalid result release rehearsal fixture.") from error

        if sorted(activity_ids) != sorted({activity_id, foreign_activity_id}):
            raise CommandError("Fixture activity scope is inconsistent.")
        if any(
            len(values) != len(set(values)) or any(value <= 0 for value in values)
            for values in (
                activity_ids,
                ruleset_ids,
                version_ids,
                stage_ids,
                [post_id],
                [operator_id],
            )
        ):
            raise CommandError("Fixture identifiers must be positive and distinct per table.")

        operator = User._base_manager.filter(pk=operator_id).first()
        if operator is not None and operator.username != operator_username:
            raise CommandError("Refusing to clean a non-rehearsal operator.")
        activities = {
            activity.pk: activity for activity in Activity._base_manager.filter(pk__in=activity_ids)
        }
        for expected_id in activity_ids:
            activity = activities.get(expected_id)
            expected_title = (
                activity_title if expected_id == activity_id else foreign_activity_title
            )
            if activity is not None and activity.title != expected_title:
                raise CommandError("Refusing to clean an activity outside the rehearsal scope.")

        rulesets = {
            ruleset.pk: ruleset
            for ruleset in ContestRuleset._base_manager.filter(pk__in=ruleset_ids)
        }
        expected_ruleset_activities = {
            ruleset_ids[0]: activity_id,
            ruleset_ids[1]: foreign_activity_id,
        }
        if any(
            ruleset.activity_id != expected_ruleset_activities[ruleset_id]
            or ruleset.name != ruleset_names[ruleset_ids.index(ruleset_id)]
            for ruleset_id, ruleset in rulesets.items()
        ):
            raise CommandError("Refusing to clean a ruleset outside the rehearsal scope.")
        versions = {
            version.pk: version
            for version in RulesetVersion._base_manager.filter(pk__in=version_ids)
        }
        expected_version_rulesets = {version_ids[0]: ruleset_ids[0], version_ids[1]: ruleset_ids[1]}
        if any(
            version.ruleset_id != expected_version_rulesets[version_id]
            for version_id, version in versions.items()
        ):
            raise CommandError("Refusing to clean a ruleset version outside the rehearsal scope.")

        post = PublicPost._base_manager.filter(pk=post_id).first()
        if post is not None and post.related_activity_id != activity_id:
            raise CommandError("Refusing to clean a post outside the rehearsal scope.")
        stages = {stage.pk: stage for stage in StageResult._base_manager.filter(pk__in=stage_ids)}
        expected_stage_activities = {stage_ids[0]: activity_id, stage_ids[1]: foreign_activity_id}
        if any(
            stage.activity_id != expected_stage_activities[stage_id]
            for stage_id, stage in stages.items()
        ):
            raise CommandError("Refusing to clean a stage result outside the rehearsal scope.")

        media_root = Path(settings.MEDIA_ROOT).resolve()
        media_file = (media_root / media_path).resolve()
        if media_root not in media_file.parents:
            raise CommandError("Refusing to remove media outside MEDIA_ROOT.")

        with transaction.atomic():
            release_ids = list(
                ResultRelease.objects.filter(post_id=post_id).values_list("pk", flat=True)
            )
            audit_targets = {
                f"PublicPost:{post_id}",
                *(f"StageResult:{stage_id}" for stage_id in stage_ids),
                *(f"ResultRelease:{release_id}" for release_id in release_ids),
            }
            audit_scope = Q(target__in=audit_targets)
            if operator is not None:
                audit_scope |= Q(operator_id=operator_id)
            AuditLog.objects.filter(audit_scope).delete()
            ResultRelease.objects.filter(post_id=post_id).delete()
            PublicMedia.objects.filter(post_id=post_id).delete()
            PublicPost.objects.filter(pk=post_id).delete()
            with authority_write(STAGE_RESULT_CONFIRM):
                StageResult.objects.filter(pk__in=stage_ids).delete()  # type: ignore[no-untyped-call]
            with authority_write(RULESET_FREEZE):
                RulesetVersion.objects.filter(pk__in=version_ids).delete()  # type: ignore[no-untyped-call]
            ContestRuleset.objects.filter(pk__in=ruleset_ids).delete()
            self._delete_exact_activity_rows(activity_ids)
            if operator is not None:
                self._delete_exact_user_row(operator_id)

        try:
            media_file.unlink()
        except FileNotFoundError:
            pass
        self.stdout.write(self.style.SUCCESS("Result release rehearsal fixture cleaned."))

    @staticmethod
    def _delete_exact_activity_rows(activity_ids: list[int]) -> None:
        """Delete only prevalidated formal rehearsal activities in non-production.

        Formal activities are intentionally not deletable through the normal ORM. This
        narrowly scoped SQL is the cleanup boundary for isolated rehearsal fixtures; all
        child rows and exact ownership checks are completed in the surrounding transaction.
        """
        table = connection.ops.quote_name(cast(str, Activity._meta.db_table))
        column = connection.ops.quote_name(cast(str, Activity._meta.pk.column))
        placeholders = ", ".join(["%s"] * len(activity_ids))
        with connection.cursor() as cursor:
            cursor.execute(
                f"DELETE FROM {table} WHERE {column} IN ({placeholders})",
                activity_ids,
            )

    @staticmethod
    def _delete_exact_user_row(operator_id: int) -> None:
        """Delete the already validated, dedicated rehearsal operator row."""
        table = connection.ops.quote_name(cast(str, User._meta.db_table))
        column = connection.ops.quote_name(cast(str, User._meta.pk.column))
        with connection.cursor() as cursor:
            cursor.execute(f"DELETE FROM {table} WHERE {column} = %s", [operator_id])
