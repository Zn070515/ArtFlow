from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class InstallationStateMigrationTests(TransactionTestCase):
    serialized_rollback = True

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
