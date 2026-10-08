from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

from accounts.models import User
from core.models import Activity
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from farewell_show.models import Program
from singer_contest.models import SingerRegistration

from common.models import AuditLog


class Command(BaseCommand):
    help = "Anonymize direct contact PII for old archived formal activities."
    requires_system_checks = []
    requires_migrations_checks = False

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--older-than-days",
            type=int,
            default=settings.ARTFLOW_PII_RETENTION_DAYS,
            help="Only process archived formal activities older than this many days.",
        )
        parser.add_argument("--actor-username", required=True)
        parser.add_argument("--confirm", action="store_true")
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args: Any, **options: Any) -> None:
        days = options["older_than_days"]
        if days < 1:
            raise CommandError("--older-than-days must be positive.")
        actor = User.objects.filter(username=options["actor_username"], is_active=True).first()
        if actor is None or not actor.is_admin:
            raise CommandError("Retention cleanup requires an active administrator actor.")
        if not options["dry_run"] and not options["confirm"]:
            raise CommandError(
                "Destructive retention cleanup requires --confirm (or use --dry-run)."
            )

        cutoff = timezone.now() - timedelta(days=days)
        # `locked_at`, not `updated_at`. The help text says "archived ... older than this
        # many days", and `updated_at` is an ordinary auto_now: `archive_activity` saves
        # with an explicit field list that does not include it, so an activity last edited
        # long before it was archived would already look older than the retention window
        # on the day it was archived and be anonymised immediately.
        #
        # For an ARCHIVED activity, `locked_at` is the archive instant: the archive flow
        # is the only writer of that phase and it stamps the field, while `unarchive`
        # clears it. A null value is therefore not "long ago" — it is a row this command
        # cannot date, so it is left alone rather than anonymised on a guess.
        activities = Activity.objects.filter(
            phase=Activity.Phase.ARCHIVED,
            data_lifecycle=Activity.DataLifecycle.FORMAL,
            locked_at__isnull=False,
            locked_at__lt=cutoff,
        ).order_by("pk")
        # An ARCHIVED row with no lock timestamp is not "old": it is undatable, so it is
        # reported rather than quietly dropped from the sweep.
        undated = Activity.objects.filter(
            phase=Activity.Phase.ARCHIVED,
            data_lifecycle=Activity.DataLifecycle.FORMAL,
            locked_at__isnull=True,
        ).count()
        if undated:
            self.stdout.write(
                f"Skipped {undated} archived formal activities with no archive timestamp."
            )
        totals = {"activities": 0, "singers": 0, "programs": 0}

        with transaction.atomic():
            for activity in activities.select_for_update():
                singers = list(
                    SingerRegistration.objects.select_for_update().filter(activity=activity)
                )
                programs = list(Program.objects.select_for_update().filter(activity=activity))
                totals["activities"] += 1
                totals["singers"] += len(singers)
                totals["programs"] += len(programs)
                if options["dry_run"]:
                    continue
                for registration in singers:
                    registration.name = f"已匿名化-{registration.pk}"
                    registration.student_id = f"REDACTED-{registration.pk}"
                    registration.college = ""
                    registration.class_name = ""
                    registration.phone = ""
                    registration.wechat = ""
                    registration.description = ""
                    registration.remark = ""
                    registration.save(
                        update_fields=[
                            "name",
                            "student_id",
                            "college",
                            "class_name",
                            "phone",
                            "wechat",
                            "description",
                            "remark",
                            "updated_at",
                        ]
                    )
                for program in programs:
                    program.contact_name = f"已匿名化-{program.pk}"
                    program.contact_phone = ""
                    program.class_name = ""
                    program.performers = ""
                    program.description = ""
                    program.special_notes = ""
                    program.save(
                        update_fields=[
                            "contact_name",
                            "contact_phone",
                            "class_name",
                            "performers",
                            "description",
                            "special_notes",
                            "updated_at",
                        ]
                    )
                AuditLog.objects.create(
                    operator=actor,
                    action_type=AuditLog.ActionType.OTHER,
                    target=f"RetentionCleanup:Activity:{activity.pk}",
                    note=json.dumps(
                        {"days": days, "singers": len(singers), "programs": len(programs)},
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                )

        mode = "would anonymize" if options["dry_run"] else "anonymized"
        self.stdout.write(
            f"Retention cleanup {mode}: {totals['activities']} activities, "
            f"{totals['singers']} singer registrations, {totals['programs']} programs."
        )
