"""Inspect only the bounded state created by the result-release rehearsal."""

from __future__ import annotations

import json
from argparse import ArgumentParser
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError
from public_portal.models import ResultRelease
from singer_contest.models import StageResult

from common.models import AuditLog


class Command(BaseCommand):
    help = "Inspect a development-only M2-D2 result release rehearsal fixture."

    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument("--fixture", required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        fixture_path = Path(options["fixture"]).expanduser()
        try:
            fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
            stage = StageResult.objects.get(pk=fixture["stage_id"])
            post_id = int(fixture["post_id"])
        except (OSError, KeyError, TypeError, ValueError, StageResult.DoesNotExist) as error:
            raise CommandError("Invalid result release rehearsal fixture.") from error

        release_audits = AuditLog.objects.filter(
            action_type=AuditLog.ActionType.RELEASE_RESULT,
            target=f"PublicPost:{post_id}",
        ).count()
        revoke_audits = AuditLog.objects.filter(
            action_type=AuditLog.ActionType.REVOKE_RESULT,
            target=f"PublicPost:{post_id}",
        ).count()
        releases = ResultRelease.objects.filter(post_id=post_id).order_by("pk")
        release_targets = [
            f"ResultRelease:{release_id}" for release_id in releases.values_list("pk", flat=True)
        ]
        supersede_audits = AuditLog.objects.filter(
            action_type=AuditLog.ActionType.SUPERSEDE_RESULT_RELEASE,
            target__in=release_targets,
        ).count()
        self.stdout.write(
            json.dumps(
                {
                    "stage_status": stage.status,
                    "release_audit_count": release_audits,
                    "revoke_audit_count": revoke_audits,
                    "supersede_audit_count": supersede_audits,
                    "release_history_count": releases.count(),
                    "active_release_count": releases.filter(
                        status=ResultRelease.Status.ACTIVE
                    ).count(),
                    "release_statuses": list(releases.values_list("status", flat=True)),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )
