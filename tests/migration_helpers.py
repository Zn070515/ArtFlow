"""Shared isolation helpers for tests that execute historical migrations."""

from accounts.models import InstallationState
from common.authority import ACCOUNT_AUTHORITY, authority_write
from django.test import TransactionTestCase


class MigrationTransactionTestCase(TransactionTestCase):
    """Restore data-migration singleton rows after historical-schema tests."""

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        with authority_write(ACCOUNT_AUTHORITY):
            InstallationState.objects.update_or_create(
                pk=InstallationState.SINGLETON_PK,
                defaults={"initialized_at": None},
            )
