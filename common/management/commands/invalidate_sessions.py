from typing import Any

from django.contrib.sessions.models import Session
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Invalidate every active application session."

    def handle(self, *args: Any, **options: Any) -> None:
        deleted_count, _ = Session.objects.all().delete()
        self.stdout.write(
            self.style.SUCCESS(
                "All active application sessions invalidated "
                f"({deleted_count} session rows removed)."
            )
        )
