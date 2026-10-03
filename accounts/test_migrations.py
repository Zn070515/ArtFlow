from common.authority import ACCOUNT_AUTHORITY, authority_write
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase

from .models import InstallationState


class InstallationStateMigrationTests(TransactionTestCase):
    def _fixture_teardown(self):
        super()._fixture_teardown()
        # The migration test moves the database through historical schemas and
        # explicitly restores the latest schema.  Recreate the singleton that
        # a data migration normally seeds so the next xdist group starts from
        # the same initial installation state.
        with authority_write(ACCOUNT_AUTHORITY):
            InstallationState.objects.update_or_create(
                pk=InstallationState.SINGLETON_PK,
                defaults={"initialized_at": None},
            )

    def test_existing_effective_admin_is_backfilled_as_initialized(self):
        executor = MigrationExecutor(connection)
        try:
            before = ("accounts", "0003_alter_user_options_alter_user_managers")
            executor.migrate([before])
            apps = executor.loader.project_state([before]).apps
            User = apps.get_model("accounts", "User")
            User.objects.create(
                username="legacy-admin",
                password="not-a-real-password-hash",
                role="admin",
                is_active=True,
                is_staff=True,
            )

            target = ("accounts", "0004_installation_state")
            executor = MigrationExecutor(connection)
            executor.migrate([target])
            after_apps = executor.loader.project_state([target]).apps
            InstallationState = after_apps.get_model("accounts", "InstallationState")
            state = InstallationState.objects.get(pk=1)

            self.assertIsNotNone(state.initialized_at)
        finally:
            executor = MigrationExecutor(connection)
            executor.migrate(executor.loader.graph.leaf_nodes())
