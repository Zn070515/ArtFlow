"""Batch A (M1-CORE-CLOSE) A5 migration regression tests.

The reviewer's acceptance (§四十) requires that the three production migrations be safe
against historical dirty data instead of failing loudly. Each test drives the real migration
machinery via MigrationExecutor: migrate to the state *before* the dirty data is possible,
insert the offending rows, then migrate forward and assert the migration succeeded and
normalized the data.
"""

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class MigrationTestMixin:
    def _migrate_to(self, targets):
        executor = MigrationExecutor(connection)
        executor.migrate(targets)
        return executor

    def _apps_at(self, target):
        executor = MigrationExecutor(connection)
        state = executor.loader.project_state([target])
        return state.apps

    def _restore_latest(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())


class RulesetMigrationTest(TransactionTestCase, MigrationTestMixin):
    def test_duplicate_ruleset_version_renumber_succeeds(self):
        before = "0010_alter_rulesetversion_is_current_and_more"
        target = ("ruleset", before)
        try:
            self._migrate_to([target])
            apps = self._apps_at(target)
            Activity = apps.get_model("core", "Activity")
            ContestRuleset = apps.get_model("ruleset", "ContestRuleset")
            RulesetVersion = apps.get_model("ruleset", "RulesetVersion")

            activity = Activity.objects.create(title="Mig", activity_type="singer_contest")
            rs_a = ContestRuleset.objects.create(activity=activity, name="A")
            rs_b = ContestRuleset.objects.create(activity=activity, name="B")
            RulesetVersion.objects.create(
                ruleset=rs_a, version=1, definition="{}", status="frozen", is_current=True
            )
            RulesetVersion.objects.create(
                ruleset=rs_b, version=1, definition="{}", status="draft", is_current=False
            )

            executor = self._migrate_to(
                [("ruleset", "0011_contestruleset_contest_ruleset_unique_activity")]
            )
            after_apps = executor.loader.project_state(
                [("ruleset", "0011_contestruleset_contest_ruleset_unique_activity")]
            ).apps
            C = after_apps.get_model("ruleset", "ContestRuleset")
            V = after_apps.get_model("ruleset", "RulesetVersion")
            self.assertEqual(C.objects.count(), 1)
            self.assertEqual(V.objects.count(), 2)
            kept = C.objects.get()
            self.assertIsNotNone(kept)
            versions = set(V.objects.filter(ruleset_id=kept.pk).values_list("version", flat=True))
            self.assertEqual(versions, {1, 2})
        finally:
            self._restore_latest()


class StageResultVersionMigrationTest(TransactionTestCase, MigrationTestMixin):
    def test_duplicate_result_version_renumber_succeeds(self):
        before = "0017_remove_stageresult_stage_result_unique_identity_and_more"
        target = ("singer_contest", before)
        try:
            # singer_contest 0017 depends on ruleset 0008; align the real ruleset schema to
            # that leaf so the historical ContestRuleset model matches the DB table.
            self._migrate_to([target, ("ruleset", "0008_rulesetversion_authority_hash")])
            apps = self._apps_at(target)
            Activity = apps.get_model("core", "Activity")
            ContestRuleset = apps.get_model("ruleset", "ContestRuleset")
            RulesetVersion = apps.get_model("ruleset", "RulesetVersion")
            StageResult = apps.get_model("singer_contest", "StageResult")

            activity = Activity.objects.create(title="Mig", activity_type="singer_contest")
            rs = ContestRuleset.objects.create(activity=activity, name="A")
            rv1 = RulesetVersion.objects.create(
                ruleset=rs, version=1, definition="{}", status="draft", is_current=False
            )
            rv2 = RulesetVersion.objects.create(
                ruleset=rs, version=2, definition="{}", status="draft", is_current=False
            )
            # Two rows with the SAME (activity, stage_key, result_version=1) but different
            # ruleset_version, so the identity unique holds while the version unique (added
            # next) would collide without the renumber.
            StageResult.objects.create(
                activity=activity,
                ruleset_version=rv1,
                stage_key="stage1",
                result_version=1,
                status="hold",
            )
            StageResult.objects.create(
                activity=activity,
                ruleset_version=rv2,
                stage_key="stage1",
                result_version=1,
                status="hold",
            )

            executor = self._migrate_to(
                [("singer_contest", "0018_stageresult_stage_result_unique_version")]
            )
            after_apps = executor.loader.project_state(
                [("singer_contest", "0018_stageresult_stage_result_unique_version")]
            ).apps
            S = after_apps.get_model("singer_contest", "StageResult")
            versions = set(S.objects.values_list("result_version", flat=True))
            self.assertEqual(versions, {1, 2})
        finally:
            self._restore_latest()


class ConfirmedTrailMigrationTest(TransactionTestCase, MigrationTestMixin):
    def test_legacy_confirmed_with_null_actor_demoted(self):
        before = "0018_stageresult_stage_result_unique_version"
        target = ("singer_contest", before)
        try:
            # singer_contest 0018 depends on ruleset 0009; align the real ruleset schema.
            self._migrate_to(
                [target, ("ruleset", "0009_contestruleset_announcement_blocks_by_checkpoint")]
            )
            apps = self._apps_at(target)
            Activity = apps.get_model("core", "Activity")
            ContestRuleset = apps.get_model("ruleset", "ContestRuleset")
            RulesetVersion = apps.get_model("ruleset", "RulesetVersion")
            StageResult = apps.get_model("singer_contest", "StageResult")

            activity = Activity.objects.create(title="Mig", activity_type="singer_contest")
            rs = ContestRuleset.objects.create(activity=activity, name="A")
            rv = RulesetVersion.objects.create(
                ruleset=rs, version=1, definition="{}", status="draft", is_current=False
            )
            # A CONFIRMED row with no confirmed_by/confirmed_at is an invalid authority; the
            # migration must demote it so the confirmed_trail CheckConstraint applies cleanly.
            StageResult.objects.create(
                activity=activity,
                ruleset_version=rv,
                stage_key="stage1",
                result_version=1,
                status="confirmed",
                confirmed_at=None,
                confirmed_by=None,
            )

            after = "0019_remove_stageresult_stage_result_unique_identity_and_more"
            executor = self._migrate_to([("singer_contest", after)])
            after_apps = executor.loader.project_state([("singer_contest", after)]).apps
            S = after_apps.get_model("singer_contest", "StageResult")
            row = S.objects.get()
            self.assertEqual(row.status, "hold")
            self.assertIsNone(row.confirmed_at)
            self.assertIsNone(row.confirmed_by)
        finally:
            self._restore_latest()
