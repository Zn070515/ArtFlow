from typing import Any

from django.core.management.base import BaseCommand
from tickets.services import purge_expired_ticket_sessions


class Command(BaseCommand):
    help = "Purge expired Ticket access sessions without touching Tickets or ballots."

    def handle(self, *args: Any, **options: Any) -> None:
        deleted = purge_expired_ticket_sessions()
        self.stdout.write(f"Expired ticket sessions purged: {deleted}")
