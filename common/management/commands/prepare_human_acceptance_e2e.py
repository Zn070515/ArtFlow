"""Prepare the non-production account state used by the browser human-acceptance flow."""

from __future__ import annotations

from argparse import ArgumentParser
from typing import Any

from accounts.models import InstallationState, User
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from common.authority import ACCOUNT_AUTHORITY, authority_write


class Command(BaseCommand):
    help = "Prepare a non-production installation-state boundary for human acceptance E2E."

    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument(
            "--fresh-bootstrap",
            action="store_true",
            help=(
                "Reset only the account boundary in the non-production fixture so the "
                "browser creates the first administrator from an uninitialized state."
            ),
        )

    def handle(self, *args: Any, **options: Any) -> None:
        if settings.APP_ENV == "production":
            raise CommandError("Human acceptance fixtures are disabled in production.")

        state = InstallationState.objects.get(pk=InstallationState.SINGLETON_PK)
        if options["fresh_bootstrap"]:
            with authority_write(ACCOUNT_AUTHORITY):
                User.objects.filter(is_active=True, role=User.Role.ADMIN).update(is_active=False)
                User.objects.filter(is_active=True, is_superuser=True).update(is_active=False)
                state.initialized_at = None
                state.save(update_fields=["initialized_at"])
            self.stdout.write(
                self.style.SUCCESS("Fresh human acceptance bootstrap boundary prepared.")
            )
            return
        if (
            not User.objects.filter(is_active=True).filter(role=User.Role.ADMIN).exists()
            and not User.objects.filter(is_active=True, is_superuser=True).exists()
        ):
            raise CommandError("Human acceptance requires an existing effective administrator.")
        if state.initialized_at is None:
            with authority_write(ACCOUNT_AUTHORITY):
                state.initialized_at = timezone.now()
                state.save(update_fields=["initialized_at"])
        self.stdout.write(self.style.SUCCESS("Human acceptance account boundary prepared."))
