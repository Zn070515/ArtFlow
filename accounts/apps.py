from typing import Any

from common.authority import ACCOUNT_AUTHORITY, authority_write
from django.apps import AppConfig, apps
from django.db.models import Q
from django.db.models.signals import post_migrate
from django.utils import timezone


def ensure_installation_state(sender: AppConfig, using: str, **kwargs: Any) -> None:
    """Restore the singleton after Django flushes a test or maintenance database.

    The initial row is created by migration ``0004``.  Django's ``flush`` removes
    that row but does not rerun data migrations, so later bootstrap checks would
    see an impossible missing installation marker.  Recreate it only when absent;
    an existing marker remains authoritative and is never overwritten here.
    """

    del sender, kwargs
    installation_state = apps.get_model("accounts", "InstallationState")
    user = apps.get_model("accounts", "User")
    has_effective_admin = (
        user.objects.using(using)
        .filter(is_active=True)
        .filter(Q(role="admin") | Q(is_superuser=True))
        .exists()
    )
    with authority_write(ACCOUNT_AUTHORITY):
        installation_state.objects.using(using).get_or_create(
            pk=1,
            defaults={
                "initialized_at": timezone.now() if has_effective_admin else None,
            },
        )


class AccountsConfig(AppConfig):
    name = "accounts"

    def ready(self) -> None:
        post_migrate.connect(
            ensure_installation_state,
            sender=self,
            dispatch_uid="accounts.ensure_installation_state",
        )
