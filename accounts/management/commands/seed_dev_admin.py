import getpass
import os
from typing import Any

from common.authority import ACCOUNT_AUTHORITY, authority_write
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from accounts.models import User


class Command(BaseCommand):
    help = "Create or reset a local development administrator account."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--username", default=os.environ.get("DEV_ADMIN_USERNAME", "admin"))

    def handle(self, *args: Any, **options: Any) -> None:
        # This command creates a Django superuser with a password supplied on the command
        # line or in the environment. That is a development convenience only: production
        # provisioning goes through provision_first_admin, which deliberately does not
        # create a superuser. The image ships this module, so the guard has to live here
        # rather than in a deployment note.
        if settings.APP_ENV == "production":
            raise CommandError("seed_dev_admin is not available with APP_ENV=production.")

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
            user.save()

        action = "Created" if created else "Updated"
        self.stdout.write(self.style.SUCCESS(f"{action} development admin: {username}"))
