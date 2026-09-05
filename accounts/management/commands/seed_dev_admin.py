import getpass
import os
from typing import Any

from django.core.management.base import BaseCommand, CommandError

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, authority_write


class Command(BaseCommand):
    help = "Create or reset a local development administrator account."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--username", default=os.environ.get("DEV_ADMIN_USERNAME", "admin"))

    def handle(self, *args: Any, **options: Any) -> None:
        password = os.environ.get("DEV_ADMIN_PASSWORD")
        if not password:
            try:
                password = getpass.getpass("Development admin password: ")
            except (EOFError, KeyboardInterrupt) as error:
                raise CommandError("A development admin password is required.") from error
        if not password:
            raise CommandError("A development admin password is required.")

        username = options["username"]
        user, created = User.objects.get_or_create(username=username)
        user.role = User.Role.ADMIN
        user.is_staff = True
        user.is_superuser = True
        user.set_password(password)
        with authority_write(ACCOUNT_AUTHORITY):
            user.save()  # type: ignore[no-untyped-call]

        action = "Created" if created else "Updated"
        self.stdout.write(self.style.SUCCESS(f"{action} development admin: {username}"))
