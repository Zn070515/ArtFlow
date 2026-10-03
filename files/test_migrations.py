"""§4.3 — the MaterialCheck.file_purpose snapshot must upgrade an existing database.

Drives the real migration machinery: migrate to the state *before* the snapshot column
exists, insert material checks exactly as a production database holds them, then migrate
forward and assert every check got the correct purpose, no check was duplicated, and an
item name no requirement (and no fallback) explains stays empty rather than guessed.
"""

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from tests.migration_helpers import MigrationTransactionTestCase

BEFORE = "0010_materialslot"
AFTER = "0011_materialcheck_file_purpose"
CORE_BEFORE = ("core", "0004_alter_activity_options")


class MaterialCheckFilePurposeBackfillTests(MigrationTransactionTestCase):
    def _migrate_to(self, targets):
        executor = MigrationExecutor(connection)
        normalized = list(targets)
        if CORE_BEFORE not in normalized:
            normalized.append(CORE_BEFORE)
        executor.migrate(normalized)
        return executor

    def _apps_at(self, target):
        executor = MigrationExecutor(connection)
        return executor.loader.project_state([target]).apps

    def _restore_latest(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())

    def test_existing_checks_gain_a_purpose_without_duplicates(self):
        target = ("files", BEFORE)
        try:
            self._migrate_to([target])
            apps = self._apps_at(target)
            User = apps.get_model("accounts", "User")
            Activity = apps.get_model("core", "Activity")
            Singer = apps.get_model("singer_contest", "SingerRegistration")
            Program = apps.get_model("farewell_show", "Program")
            Requirement = apps.get_model("files", "MaterialRequirement")
            Check = apps.get_model("files", "MaterialCheck")

            user = User.objects.create(username="backfill")
            configured_activity = Activity.objects.create(
                title="Configured", activity_type="singer_contest"
            )
            Requirement.objects.create(
                activity=configured_activity,
                applies_to="singer",
                item_name="伴奏文件",
                file_purpose="accompaniment",
            )
            Requirement.objects.create(
                activity=configured_activity,
                applies_to="singer",
                item_name="歌词",
                file_purpose="lyrics_script",
            )
            Requirement.objects.create(
                activity=configured_activity,
                applies_to="singer",
                item_name="基本信息",
                file_purpose="",
            )
            configured_singer = Singer.objects.create(
                activity=configured_activity,
                user=user,
                name="Configured Singer",
                student_id="20260001",
                college="College",
                class_name="Class",
                phone="13800000000",
                song_name="Song",
            )
            for item_name, status in (
                ("伴奏文件", "missing"),
                ("歌词", "approved"),
                ("基本信息", "uploaded"),
                ("临时附加项", "missing"),
            ):
                Check.objects.create(
                    singer_registration=configured_singer,
                    item_name=item_name,
                    status=status,
                )

            fallback_activity = Activity.objects.create(
                title="Fallback", activity_type="singer_contest"
            )
            fallback_singer = Singer.objects.create(
                activity=fallback_activity,
                user=user,
                name="Fallback Singer",
                student_id="20260002",
                college="College",
                class_name="Class",
                phone="13800000001",
                song_name="Song",
            )
            for item_name in ("基本信息", "联系方式", "伴奏文件"):
                Check.objects.create(
                    singer_registration=fallback_singer,
                    item_name=item_name,
                    status="missing",
                )

            show_activity = Activity.objects.create(title="Farewell", activity_type="farewell_show")
            program = Program.objects.create(
                activity=show_activity,
                user=user,
                name="Program",
                program_type="song",
                contact_name="Contact",
                contact_phone="13800000002",
                class_name="Class",
            )
            Check.objects.create(program=program, item_name="负责人联系方式", status="uploaded")

            before_count = Check.objects.count()

            executor = self._migrate_to([("files", AFTER)])
            after_apps = executor.loader.project_state([("files", AFTER)]).apps
            after_checks = after_apps.get_model("files", "MaterialCheck")

            self.assertEqual(after_checks.objects.count(), before_count)

            def purpose_of(**lookup):
                return after_checks.objects.get(**lookup).file_purpose

            configured_id = configured_singer.pk
            fallback_id = fallback_singer.pk
            program_id = program.pk
            self.assertEqual(
                purpose_of(singer_registration_id=configured_id, item_name="伴奏文件"),
                "accompaniment",
            )
            self.assertEqual(
                purpose_of(singer_registration_id=configured_id, item_name="歌词"),
                "lyrics_script",
            )
            self.assertEqual(
                purpose_of(singer_registration_id=configured_id, item_name="基本信息"),
                "",
            )
            # The activity has configured requirements, so its fallback list does not
            # apply; an item nothing explains must stay empty instead of being guessed.
            self.assertEqual(
                purpose_of(singer_registration_id=configured_id, item_name="临时附加项"),
                "",
            )
            self.assertEqual(
                purpose_of(singer_registration_id=fallback_id, item_name="伴奏文件"),
                "accompaniment",
            )
            self.assertEqual(
                purpose_of(singer_registration_id=fallback_id, item_name="基本信息"),
                "",
            )
            self.assertEqual(
                purpose_of(singer_registration_id=fallback_id, item_name="联系方式"),
                "",
            )
            self.assertEqual(
                purpose_of(program_id=program_id, item_name="负责人联系方式"),
                "",
            )
            # A staff approval of a file-backed item keeps its review state; only the
            # purpose snapshot is added.
            self.assertEqual(
                after_checks.objects.get(
                    singer_registration_id=configured_id, item_name="歌词"
                ).status,
                "approved",
            )
        finally:
            self._restore_latest()
