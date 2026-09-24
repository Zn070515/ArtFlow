import getpass
import os
import sys
from typing import Any

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from accounts.services import provision_first_admin


class Command(BaseCommand):
    help = "Provision the first ArtFlow administrator exactly once."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--username",
            default=os.environ.get("ARTFLOW_INITIAL_ADMIN_USERNAME", ""),
            help="The first administrator username; never defaults to a shared account.",
        )
        parser.add_argument(
            "--password-stdin",
            action="store_true",
            help="Read the password once from stdin without echoing it.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        username = options["username"].strip()
        if not username:
            raise CommandError("A first administrator username is required.")

        password = self._read_password(from_stdin=options["password_stdin"])
        try:
            provision_first_admin(username=username, password=password)
        except ValidationError as error:
            raise CommandError(" ".join(error.messages)) from error

        self.stdout.write(
            self.style.SUCCESS(f"Provisioned first ArtFlow administrator: {username}")
        )

    @staticmethod
    def _read_password(*, from_stdin: bool) -> str:
        if from_stdin:
            return sys.stdin.readline().rstrip("\r\n")
        try:
            return getpass.getpass("First ArtFlow administrator password: ")
        except (EOFError, KeyboardInterrupt) as error:
            raise CommandError("A first administrator password is required.") from error
