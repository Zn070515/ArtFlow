"""Drop what GOAL §19.2 says not to keep by default.

§19.1 keeps *business facts* durable; §19.2 says that durability must not be extended to
the PII and the short-lived transport rows around them — ticket credentials, judge
sessions, access grants, temporary staff notes, and IP addresses with no long-term value.
Nothing pruned any of it, so a database that had run one rehearsal and one live evening
kept every login IP, every expired judge session and every redeemed grant forever.

The audit trail itself is evidence (§16 makes the incident record a first-class object and
§18.1 requires group corrections to stay auditable), so its rows are *not* deleted here:
what expires is the IP column. ``--purge-audit-logs`` opts in to deleting the old rows as
well, which is a business decision rather than a correctness one.

Deletions follow the dependency order the models declare (a grant PROTECTs its seat grant,
a seat grant PROTECTs nothing, an ephemeral session is PROTECTed by its judge session), and
skip anything a live consumer still points at.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from accounts.models import User
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from files.models import StaffNote

from common.authority import JUDGE_SESSION_STATE, RETENTION_CLEANUP, authority_write
from common.models import AuditLog


class Command(BaseCommand):
    help = "Prune expired credentials, sessions, staff notes and old audit IPs (GOAL §19.2)."
    requires_system_checks = []
    requires_migrations_checks = False

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--older-than-days",
            type=int,
            default=settings.ARTFLOW_PII_RETENTION_DAYS,
            help="Only prune rows whose validity ended more than this many days ago.",
        )
        parser.add_argument("--actor-username", required=True)
        parser.add_argument("--confirm", action="store_true")
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument(
            "--purge-audit-logs",
            action="store_true",
            help="Also delete (not just de-PII) audit rows older than the cutoff.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        days = int(options["older_than_days"])
        if days < 1:
            raise CommandError("--older-than-days must be positive.")
        actor = User.objects.filter(username=options["actor_username"], is_active=True).first()
        if actor is None or not actor.is_admin:
            raise CommandError("Retention pruning requires an active administrator actor.")
        dry_run = bool(options["dry_run"])
        if not dry_run and not options["confirm"]:
            raise CommandError("Destructive retention pruning requires --confirm (or --dry-run).")
        purge_audit_logs = bool(options["purge_audit_logs"])

        from entry_access.models import AccessGrant, EphemeralSession
        from singer_contest.models import JudgeSeatGrant, JudgeSession

        cutoff = timezone.now() - timedelta(days=days)
        ended = Q(expires_at__lt=cutoff) | Q(revoked_at__lt=cutoff)
        # A seat grant PROTECTs its access grant and the grant PROTECTs nothing, so the
        # binding has to go first. Only bindings whose grant already ended are touched.
        seat_grants = JudgeSeatGrant.objects.filter(
            Q(access_grant__expires_at__lt=cutoff) | Q(access_grant__revoked_at__lt=cutoff)
        )
        judge_sessions = JudgeSession.objects.filter(ended)
        # An ephemeral session is PROTECTed by its judge session, and a grant by its seat
        # grant; anything still referenced by a row we are not deleting stays.
        ephemeral_sessions = EphemeralSession.objects.filter(ended).filter(
            judge_session__isnull=True
        )
        access_grants = AccessGrant.objects.filter(ended).filter(judge_seat_grant__isnull=True)
        staff_notes = StaffNote.objects.filter(created_at__lt=cutoff)
        audit_ips = AuditLog.objects.filter(created_at__lt=cutoff).exclude(ip_address=None)
        audit_logs = AuditLog.objects.filter(created_at__lt=cutoff) if purge_audit_logs else None

        counts = {
            "audit_ip_addresses": audit_ips.count(),
            "audit_logs": audit_logs.count() if audit_logs is not None else 0,
            "staff_notes": staff_notes.count(),
            "judge_sessions": judge_sessions.count(),
            "judge_seat_grants": seat_grants.count(),
            "ephemeral_sessions": ephemeral_sessions.count(),
            "access_grants": access_grants.count(),
        }
        if dry_run:
            self.stdout.write(f"Retention prune (dry run) older than {days} days: {counts}")
            return

        with transaction.atomic():
            audit_ips.update(ip_address=None)
            if audit_logs is not None:
                audit_logs.delete()
            staff_notes.delete()
            with authority_write(JUDGE_SESSION_STATE):
                seat_grants.delete()  # type: ignore[no-untyped-call]
                judge_sessions.delete()  # type: ignore[no-untyped-call]
            with authority_write(RETENTION_CLEANUP):
                ephemeral_sessions.delete()  # type: ignore[no-untyped-call]
                access_grants.delete()  # type: ignore[no-untyped-call]
            AuditLog.objects.create(
                operator=actor,
                action_type=AuditLog.ActionType.OTHER,
                target="retention",
                new_value=f"older_than_days={days}",
                note=f"prune_retained_state {counts}",
            )
        self.stdout.write(f"Retention prune older than {days} days: {counts}")
