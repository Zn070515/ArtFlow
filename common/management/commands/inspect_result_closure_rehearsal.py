"""Inspect only the isolated state created by the result-closure rehearsal fixture."""

from __future__ import annotations

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from singer_contest.models import Award, StageResult
from singer_contest.services import official_stage_award_queryset

from common.models import AuditLog


class Command(BaseCommand):
    help = "Inspect a development-only M2-D1 result closure rehearsal fixture."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--fixture", required=True)

    def handle(self, *args, **options) -> None:
        fixture_path = Path(options["fixture"]).expanduser()
        try:
            fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
            current_stage = StageResult.objects.get(pk=fixture["stage_id"])
            stale_stage = StageResult.objects.get(pk=fixture["stale_stage_id"])
        except (OSError, KeyError, TypeError, ValueError, StageResult.DoesNotExist) as error:
            raise CommandError("Invalid result closure rehearsal fixture.") from error

        confirm_count = AuditLog.objects.filter(
            action_type=AuditLog.ActionType.CONFIRM_STAGE_RESULT,
            target=f"StageResult:{current_stage.pk}",
        ).count()
        stale_confirm_count = AuditLog.objects.filter(
            action_type=AuditLog.ActionType.CONFIRM_STAGE_RESULT,
            target=f"StageResult:{stale_stage.pk}",
        ).count()
        source_award_count = Award.objects.filter(source_stage_result=current_stage).count()
        official_award_count = (
            official_stage_award_queryset(current_stage.activity)
            .filter(source_stage_result=current_stage)
            .count()
        )
        self.stdout.write(
            json.dumps(
                {
                    "current_stage_status": current_stage.status,
                    "stale_stage_status": stale_stage.status,
                    "confirm_audit_count": confirm_count,
                    "duplicate_confirm_count": max(0, confirm_count - 1),
                    "stale_confirm_audit_count": stale_confirm_count,
                    "stale_rejection_count": int(
                        stale_stage.status != StageResult.Status.CONFIRMED
                        and stale_confirm_count == 0
                    ),
                    "source_award_count": source_award_count,
                    "official_current_award_count": official_award_count,
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )
