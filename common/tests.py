import os
import subprocess
from datetime import datetime, timedelta
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from unittest import skipUnless
from unittest.mock import patch

from accounts.models import User
from core.models import Activity
from django.conf import settings
from django.contrib.contenttypes.models import ContentType
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import (
    DatabaseError,
    IntegrityError,
    close_old_connections,
    connection,
    transaction,
)
from django.db import models as django_models
from django.db.models.signals import pre_save
from django.http import Http404
from django.test import TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from exports.models import ArticleTemplate, GeneratedDocument
from farewell_show.models import Program
from files.models import MaterialCheck, StaffNote, SubmissionFile
from incidents.models import IncidentRecord
from public_portal.models import PublicPost
from singer_contest.models import (
    Award,
    ContestRound,
    Judge,
    RoundEntry,
    RoundJudge,
    ScoreRecord,
    ScoreSummary,
    SingerRegistration,
)
from voting.models import VoteOption, VoteRecord, VoteSession

from . import models as common_models
from .business_rules import ensure_same_activity
from .management.commands.seed_demo_data import Command as SeedDemoDataCommand
from .models import AuditLog, SeedRecord
from .test_data import clear_activity_test_data
from .views import _media_file_response

DOCTOR_SECRET_KEY_SENTINEL = "doctor-secret-key-sentinel"
DOCTOR_ADMIN_LOGIN_KEY_SENTINEL = "doctor-admin-login-key-sentinel"
DOCTOR_DATABASE_PASSWORD_SENTINEL = "doctor-database-password-sentinel"


class ActivityLifecycleTests(TestCase):
    def test_formal_activity_cannot_reenter_test_mode(self):
        activity = Activity.objects.create(
            title="Formal",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
        )

        activity.is_test_mode = True

        with self.assertRaises(ValidationError):
            activity.save()

    def test_new_formal_activity_has_consistent_marker(self):
        activity = Activity.objects.create(
            title="Formal",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
        )

        self.assertEqual(activity.data_lifecycle, Activity.DataLifecycle.FORMAL)
        self.assertFalse(activity.is_test_mode)

    def test_test_activity_becomes_formal_when_test_mode_is_disabled(self):
        activity = Activity.objects.create(
            title="Test",
            activity_type=Activity.Type.SINGER_CONTEST,
        )

        activity.is_test_mode = False
        activity.save(update_fields=["is_test_mode", "updated_at"])
        activity.refresh_from_db()

        self.assertEqual(activity.data_lifecycle, Activity.DataLifecycle.FORMAL)
        self.assertFalse(activity.is_test_mode)

    def test_formal_activity_cannot_downgrade_lifecycle_marker(self):
        activity = Activity.objects.create(
            title="Formal",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
        )

        activity.data_lifecycle = Activity.DataLifecycle.TEST

        with self.assertRaises(ValidationError):
            activity.save()


class GeneratedDocumentTestDataCleanupTests(TestCase):
    def setUp(self):
        self.media_directory = TemporaryDirectory()
        self.media_override = override_settings(MEDIA_ROOT=self.media_directory.name)
        self.media_override.enable()
        self.operator = User.objects.create_user(username="cleanup-operator", password="pass")
        self.activity = Activity.objects.create(
            title="Test activity", activity_type=Activity.Type.SINGER_CONTEST
        )

    def tearDown(self):
        self.media_override.disable()
        self.media_directory.cleanup()

    def test_generated_test_document_is_removed_with_file(self):
        document = GeneratedDocument.objects.create(
            activity=self.activity,
            title="Test document",
            file=SimpleUploadedFile("test-document.docx", b"test document"),
            created_by=self.operator,
            is_test_data=True,
        )
        stored_name = document.file.name
        storage = document.file.storage

        counts = clear_activity_test_data(self.activity, operator=self.operator)

        self.assertEqual(counts["generated_documents"], 1)
        self.assertFalse(GeneratedDocument.objects.filter(pk=document.pk).exists())
        self.assertFalse(storage.exists(stored_name))


class ActivityLifecycleBulkWriteTests(TestCase):
    def test_queryset_update_rejects_lifecycle_changes(self):
        activity = Activity.objects.create(
            title="Formal",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
        )

        with self.assertRaises(ValidationError):
            Activity.objects.filter(pk=activity.pk).update(is_test_mode=True)

    def test_base_manager_update_rejects_lifecycle_changes(self):
        activity = Activity.objects.create(
            title="Formal",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
        )

        with self.assertRaises(ValidationError):
            Activity._base_manager.filter(pk=activity.pk).update(
                data_lifecycle=Activity.DataLifecycle.TEST
            )

    def test_bulk_update_rejects_lifecycle_changes(self):
        activity = Activity.objects.create(
            title="Formal",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
        )
        activity.is_test_mode = True

        with self.assertRaises(ValidationError):
            Activity.objects.bulk_update([activity], ["is_test_mode"])

    def test_bulk_create_aligns_lifecycle_marker(self):
        activity = Activity(
            title="Formal",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
        )

        Activity.objects.bulk_create([activity])
        activity.refresh_from_db()

        self.assertEqual(activity.data_lifecycle, Activity.DataLifecycle.FORMAL)
        self.assertFalse(activity.is_test_mode)

    def test_bulk_create_conflict_update_rejects_lifecycle_changes(self):
        activity = Activity.objects.create(
            title="Formal",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
        )
        stale_activity = Activity(
            pk=activity.pk,
            title=activity.title,
            activity_type=activity.activity_type,
            is_test_mode=True,
        )

        with self.assertRaises(ValidationError):
            Activity.objects.bulk_create(
                [stale_activity],
                update_conflicts=True,
                update_fields=["is_test_mode", "data_lifecycle"],
                unique_fields=["pk"],
            )


@skipUnless(
    connection.features.has_select_for_update,
    "Activity lifecycle race protection requires database row locking.",
)
class ActivityLifecycleConcurrencyTests(TransactionTestCase):
    def test_stale_test_save_waits_for_formal_promotion_lock(self):
        activity = Activity.objects.create(
            title="Test",
            activity_type=Activity.Type.SINGER_CONTEST,
        )
        stale_activity = Activity.objects.get(pk=activity.pk)
        formal_save_started = Event()
        release_formal_save = Event()
        stale_save_started = Event()
        stale_save_finished = Event()
        formal_errors = []
        stale_errors = []

        def hold_formal_save(sender, instance, **kwargs):
            if instance.pk == activity.pk and not instance.is_test_mode:
                formal_save_started.set()
                release_formal_save.wait(timeout=5)

        def promote_activity():
            close_old_connections()
            try:
                formal_activity = Activity.objects.get(pk=activity.pk)
                formal_activity.is_test_mode = False
                formal_activity.save()
            except Exception as error:
                formal_errors.append(error)
            finally:
                close_old_connections()

        def save_stale_activity():
            close_old_connections()
            stale_save_started.set()
            try:
                stale_activity.save()
            except Exception as error:
                stale_errors.append(error)
            finally:
                stale_save_finished.set()
                close_old_connections()

        pre_save.connect(hold_formal_save, sender=Activity, weak=False)
        formal_thread = Thread(target=promote_activity)
        stale_thread = Thread(target=save_stale_activity)
        try:
            formal_thread.start()
            self.assertTrue(formal_save_started.wait(timeout=5))
            stale_thread.start()
            self.assertTrue(stale_save_started.wait(timeout=5))
            self.assertFalse(stale_save_finished.wait(timeout=0.2))
        finally:
            release_formal_save.set()
            formal_thread.join(timeout=5)
            stale_thread.join(timeout=5)
            pre_save.disconnect(hold_formal_save, sender=Activity)

        self.assertFalse(formal_thread.is_alive())
        self.assertFalse(stale_thread.is_alive())
        self.assertEqual(formal_errors, [])
        self.assertEqual(len(stale_errors), 1)
        self.assertIsInstance(stale_errors[0], ValidationError)
        activity.refresh_from_db()
        self.assertEqual(activity.data_lifecycle, Activity.DataLifecycle.FORMAL)
        self.assertFalse(activity.is_test_mode)


class ActivityOwnershipTests(TestCase):
    def test_same_activity_guard_rejects_related_object_from_another_activity(self):
        first = Activity.objects.create(
            title="First",
            activity_type=Activity.Type.SINGER_CONTEST,
        )
        second = Activity.objects.create(
            title="Second",
            activity_type=Activity.Type.SINGER_CONTEST,
        )

        with self.assertRaises(PermissionDenied):
            ensure_same_activity(first, second, label="related activity")

    def test_cross_activity_award_and_vote_option_are_rejected_by_model_save(self):
        user = User.objects.create_user(username="owner", password="pass")
        first = Activity.objects.create(
            title="First",
            activity_type=Activity.Type.SINGER_CONTEST,
        )
        second = Activity.objects.create(
            title="Second",
            activity_type=Activity.Type.SINGER_CONTEST,
        )
        singer = SingerRegistration.objects.create(
            activity=second,
            user=user,
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
        )
        with self.assertRaises(ValidationError):
            Award(activity=first, singer=singer, name="Invalid").save()

        vote_session = VoteSession.objects.create(
            activity=first,
            name="Votes",
            passcode="1234",
            start_time=timezone.now(),
            end_time=timezone.now() + timedelta(minutes=5),
        )
        with self.assertRaises(ValidationError):
            VoteOption(vote_session=vote_session, singer=singer).save()


class StaticAssetContractTests(TestCase):
    def test_base_template_uses_local_compiled_css(self):
        base_template = (settings.BASE_DIR / "templates" / "base.html").read_text(encoding="utf-8")

        self.assertIn("{% load static %}", base_template)
        self.assertIn("static 'css/app.css'", base_template)
        self.assertNotIn("cdn.tailwindcss.com", base_template)
        self.assertNotIn("text/tailwind", base_template)


class ControlledMediaPathTests(TestCase):
    def test_media_file_response_rejects_a_path_outside_media_root(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            media_root = root / "media"
            media_root.mkdir()
            (root / "private.txt").write_text("private", encoding="utf-8")

            with override_settings(MEDIA_ROOT=media_root):
                with self.assertRaises(Http404):
                    _media_file_response("../private.txt")

    def test_controlled_media_rejects_posix_symlink_to_external_file(self):
        if os.name != "posix":
            self.skipTest("POSIX symlinks are only available on POSIX platforms.")

        with TemporaryDirectory() as directory:
            root = Path(directory)
            media_root = root / "media"
            media_root.mkdir()
            external_file = root / "private.txt"
            external_contents = "private media content"
            external_file.write_text(external_contents, encoding="utf-8")
            link_path = media_root / "public" / "linked-private.txt"
            link_path.parent.mkdir()

            try:
                os.symlink(external_file, link_path)
            except OSError as error:
                self.skipTest(f"POSIX symlink creation is unavailable: {error}")

            try:
                relative_path = "public/linked-private.txt"
                PublicPost.objects.create(
                    title="Linked private media",
                    cover_image=relative_path,
                    status=PublicPost.Status.PUBLISHED,
                )

                with override_settings(MEDIA_ROOT=media_root):
                    response = self.client.get(
                        reverse("controlled_media", kwargs={"path": relative_path})
                    )

                self.assertEqual(response.status_code, 404)
                self.assertNotContains(response, external_contents, status_code=404)
            finally:
                if link_path.is_symlink():
                    link_path.unlink()

            self.assertTrue(external_file.is_file())
            self.assertEqual(external_file.read_text(encoding="utf-8"), external_contents)

    def test_controlled_media_rejects_windows_junction_to_external_directory(self):
        if os.name != "nt":
            self.skipTest("Windows junctions are only available on Windows.")

        with TemporaryDirectory() as directory:
            root = Path(directory)
            media_root = root / "media"
            media_root.mkdir()
            external_directory = root / "private"
            external_directory.mkdir()
            external_file = external_directory / "private.txt"
            external_contents = "private media content"
            external_file.write_text(external_contents, encoding="utf-8")
            link_path = media_root / "public" / "linked-private"
            link_path.parent.mkdir()

            junction = subprocess.run(
                ["cmd", "/d", "/c", "mklink", "/J", str(link_path), str(external_directory)],
                check=False,
                capture_output=True,
                text=True,
            )
            if junction.returncode != 0:
                self.skipTest(f"Windows junction creation is unavailable: {junction.stderr}")

            try:
                relative_path = "public/linked-private/private.txt"
                PublicPost.objects.create(
                    title="Linked private media",
                    cover_image=relative_path,
                    status=PublicPost.Status.PUBLISHED,
                )

                with override_settings(MEDIA_ROOT=media_root):
                    response = self.client.get(
                        reverse("controlled_media", kwargs={"path": relative_path})
                    )

                self.assertEqual(response.status_code, 404)
                self.assertNotContains(response, external_contents, status_code=404)
            finally:
                if link_path.is_junction():
                    removal = subprocess.run(
                        ["cmd", "/d", "/c", "rmdir", str(link_path)],
                        check=False,
                        capture_output=True,
                        text=True,
                    )
                    if removal.returncode != 0:
                        self.fail(f"Unable to remove Windows junction: {removal.stderr}")

            self.assertTrue(external_file.is_file())
            self.assertEqual(external_file.read_text(encoding="utf-8"), external_contents)


class DoctorCommandTests(TestCase):
    def test_doctor_reports_safe_current_environment_diagnostics(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = StringIO()

            with override_settings(STATIC_ROOT=root / "staticfiles", MEDIA_ROOT=root / "media"):
                (root / "staticfiles").mkdir()
                (root / "media").mkdir()

                call_command("doctor", stdout=output)

        diagnostics = output.getvalue()
        self.assertIn(f"Environment: {settings.APP_ENV}", diagnostics)
        self.assertIn("Database engine:", diagnostics)
        self.assertIn("Migration state:", diagnostics)
        self.assertIn("STATIC_ROOT:", diagnostics)
        self.assertIn("MEDIA_ROOT:", diagnostics)
        self.assertNotIn(settings.SECRET_KEY, diagnostics)
        self.assertNotIn(str(settings.DATABASES["default"].get("NAME", "")), diagnostics)

    def test_doctor_reports_database_failure_with_explicit_exit_code_and_safe_output(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = StringIO()
            (root / "staticfiles").mkdir()
            (root / "media").mkdir()

            with (
                override_settings(STATIC_ROOT=root / "staticfiles", MEDIA_ROOT=root / "media"),
                patch(
                    "common.management.commands.doctor.connection.ensure_connection",
                    side_effect=DatabaseError("database-password"),
                ),
                patch(
                    "common.management.commands.doctor.Command._migrations_are_current",
                    return_value=True,
                ),
                self.assertRaises(CommandError) as error,
            ):
                call_command("doctor", stdout=output)

        self.assertEqual(error.exception.returncode, 3)
        self.assertIn("Database connection: failed", output.getvalue())
        self.assertNotIn("database-password", output.getvalue())

    def test_doctor_reports_unapplied_migrations_with_explicit_exit_code(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = StringIO()
            (root / "staticfiles").mkdir()
            (root / "media").mkdir()

            with (
                override_settings(
                    STATIC_ROOT=root / "staticfiles",
                    MEDIA_ROOT=root / "media",
                    SECRET_KEY=DOCTOR_SECRET_KEY_SENTINEL,
                    ADMIN_LOGIN_KEY=DOCTOR_ADMIN_LOGIN_KEY_SENTINEL,
                ),
                patch.dict(
                    "common.management.commands.doctor.connection.settings_dict",
                    {"PASSWORD": DOCTOR_DATABASE_PASSWORD_SENTINEL},
                ),
                patch(
                    "common.management.commands.doctor.MigrationExecutor.migration_plan",
                    return_value=[object()],
                ),
                self.assertRaises(CommandError) as error,
            ):
                call_command("doctor", stdout=output)

        self.assertEqual(error.exception.returncode, 4)
        diagnostics = output.getvalue()
        self.assertIn("Migration state: failed or unapplied", diagnostics)
        self.assertNotIn(DOCTOR_SECRET_KEY_SENTINEL, diagnostics)
        self.assertNotIn(DOCTOR_ADMIN_LOGIN_KEY_SENTINEL, diagnostics)
        self.assertNotIn(DOCTOR_DATABASE_PASSWORD_SENTINEL, diagnostics)

    def test_doctor_reports_missing_runtime_directories_with_explicit_exit_code(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = StringIO()

            with (
                override_settings(
                    STATIC_ROOT=root / "staticfiles",
                    MEDIA_ROOT=root / "media",
                    SECRET_KEY=DOCTOR_SECRET_KEY_SENTINEL,
                    ADMIN_LOGIN_KEY=DOCTOR_ADMIN_LOGIN_KEY_SENTINEL,
                ),
                patch.dict(
                    "common.management.commands.doctor.connection.settings_dict",
                    {"PASSWORD": DOCTOR_DATABASE_PASSWORD_SENTINEL},
                ),
                self.assertRaises(CommandError) as error,
            ):
                call_command("doctor", stdout=output)

        self.assertEqual(error.exception.returncode, 5)
        diagnostics = output.getvalue()
        self.assertIn("STATIC_ROOT: missing", diagnostics)
        self.assertIn("MEDIA_ROOT: missing", diagnostics)
        self.assertNotIn(DOCTOR_SECRET_KEY_SENTINEL, diagnostics)
        self.assertNotIn(DOCTOR_ADMIN_LOGIN_KEY_SENTINEL, diagnostics)
        self.assertNotIn(DOCTOR_DATABASE_PASSWORD_SENTINEL, diagnostics)


class SeedRecordTests(TestCase):
    def test_seed_record_keeps_one_key_and_one_owned_object(self):
        seed_record_model = getattr(common_models, "SeedRecord", None)
        self.assertIs(seed_record_model, SeedRecord)
        self.assertIsInstance(
            SeedRecord._meta.get_field("object_id"),
            django_models.PositiveBigIntegerField,
        )

        user = User.objects.create_user(username="seed-record-owner", password="safe-password")
        content_type = ContentType.objects.get_for_model(User)
        first_record = SeedRecord.objects.create(
            key="demo.user.owner",
            content_type=content_type,
            object_id=user.pk,
        )

        self.assertIsNotNone(first_record.created_at)
        with self.assertRaises(IntegrityError), transaction.atomic():
            SeedRecord.objects.create(
                key="demo.user.other",
                content_type=content_type,
                object_id=user.pk,
            )
        with self.assertRaises(IntegrityError), transaction.atomic():
            SeedRecord.objects.create(
                key="demo.user.owner",
                content_type=content_type,
                object_id=user.pk + 1,
            )


class DemoSeedCommandTests(TestCase):
    seed_time = timezone.make_aware(datetime(2026, 9, 1, 9, 0))

    def test_reset_lock_preflight_materializes_every_selected_dependent_row(self):
        class LockedRows:
            def __init__(self):
                self.locked_ids = set()
                self.was_materialized = False

            def filter(self, *, pk__in):
                self.locked_ids = set(pk__in)
                return self

            def __iter__(self):
                self.was_materialized = True
                return iter(())

        locked_rows = LockedRows()

        class LockedManager:
            def select_for_update(self):
                return locked_rows

        class LockedModel:
            objects = LockedManager()

        class DependentRow:
            def __init__(self, pk):
                self.pk = pk

        SeedDemoDataCommand()._lock_objects(
            LockedModel,
            [DependentRow(101), DependentRow(202)],
        )

        self.assertEqual(locked_rows.locked_ids, {101, 202})
        self.assertTrue(locked_rows.was_materialized)

    def _seed_record_model(self):
        seed_record_model = getattr(common_models, "SeedRecord", None)
        self.assertIsNotNone(seed_record_model)
        return seed_record_model

    def _seeded_activity_ids(self):
        seed_record_model = self._seed_record_model()
        activity_type = ContentType.objects.get_for_model(Activity)
        return list(
            seed_record_model.objects.filter(
                key__in=["demo.activity.singer_contest", "demo.activity.farewell_show"],
                content_type=activity_type,
            ).values_list("object_id", flat=True)
        )

    def test_seed_demo_data_is_idempotent_with_stable_counts_and_ownership_ids(self):
        output = StringIO()
        call_command("seed_demo_data", stdout=output)

        seed_record_model = self._seed_record_model()
        first_counts = {
            "activities": Activity.objects.count(),
            "users": User.objects.count(),
            "posts": PublicPost.objects.count(),
            "templates": ArticleTemplate.objects.count(),
            "singers": SingerRegistration.objects.count(),
            "programs": Program.objects.count(),
            "judges": Judge.objects.count(),
            "rounds": ContestRound.objects.count(),
            "scores": ScoreRecord.objects.count(),
            "summaries": ScoreSummary.objects.count(),
            "awards": Award.objects.count(),
            "vote_sessions": VoteSession.objects.count(),
            "vote_options": VoteOption.objects.count(),
            "vote_records": VoteRecord.objects.count(),
            "incidents": IncidentRecord.objects.count(),
            "seed_records": seed_record_model.objects.count(),
        }
        first_ownership = dict(seed_record_model.objects.values_list("key", "object_id"))

        self.assertEqual(
            first_counts,
            {
                "activities": 2,
                "users": 2,
                "posts": 2,
                "templates": 2,
                "singers": 2,
                "programs": 2,
                "judges": 2,
                "rounds": 1,
                "scores": 4,
                "summaries": 2,
                "awards": 1,
                "vote_sessions": 1,
                "vote_options": 2,
                "vote_records": 2,
                "incidents": 1,
                "seed_records": 28,
            },
        )
        self.assertEqual(
            set(first_ownership),
            {
                "demo.user.admin",
                "demo.user.participant",
                "demo.activity.singer_contest",
                "demo.activity.farewell_show",
                "demo.post.singer_contest",
                "demo.post.farewell_show",
                "demo.template.singer_registration",
                "demo.template.program_collection",
                "demo.singer.one",
                "demo.singer.two",
                "demo.program.opening",
                "demo.program.closing",
                "demo.judge.one",
                "demo.judge.two",
                "demo.round.preliminary",
                "demo.score.one.judge_one",
                "demo.score.one.judge_two",
                "demo.score.two.judge_one",
                "demo.score.two.judge_two",
                "demo.summary.one",
                "demo.summary.two",
                "demo.award.one",
                "demo.vote_session.audience_choice",
                "demo.vote_option.one",
                "demo.vote_option.two",
                "demo.vote_record.one",
                "demo.vote_record.two",
                "demo.incident.one",
            },
        )
        self.assertFalse(User.objects.get(username="demo-admin").has_usable_password())
        self.assertTrue(
            all(getattr(option, "is_test_data", False) for option in VoteOption.objects.all())
        )
        self.assertTrue(
            all(getattr(record, "is_test_data", False) for record in VoteRecord.objects.all())
        )
        seeded_round = ContestRound.objects.get(name="Demo Preliminary Round")
        self.assertEqual(seeded_round.status, ContestRound.Status.PREPARED)
        self.assertFalse(seeded_round.is_locked)
        self.assertEqual(RoundEntry.objects.filter(round=seeded_round).count(), 2)
        self.assertEqual(RoundJudge.objects.filter(round=seeded_round).count(), 2)
        self.assertEqual(
            set(
                ScoreRecord.objects.filter(round=seeded_round).values_list(
                    "singer_id", "judge_id"
                )
            ),
            set(
                (entry.singer_id, round_judge.judge_id)
                for entry in RoundEntry.objects.filter(round=seeded_round)
                for round_judge in RoundJudge.objects.filter(round=seeded_round)
            ),
        )
        self.assertSetEqual(
            set(ScoreSummary.objects.filter(round=seeded_round).values_list("singer_id", flat=True)),
            set(RoundEntry.objects.filter(round=seeded_round).values_list("singer_id", flat=True)),
        )
        self.assertEqual(output.getvalue(), "Demo data seeded.\n")

        second_output = StringIO()
        call_command("seed_demo_data", stdout=second_output)

        self.assertEqual(
            {
                "activities": Activity.objects.count(),
                "users": User.objects.count(),
                "posts": PublicPost.objects.count(),
                "templates": ArticleTemplate.objects.count(),
                "singers": SingerRegistration.objects.count(),
                "programs": Program.objects.count(),
                "judges": Judge.objects.count(),
                "rounds": ContestRound.objects.count(),
                "scores": ScoreRecord.objects.count(),
                "summaries": ScoreSummary.objects.count(),
                "awards": Award.objects.count(),
                "vote_sessions": VoteSession.objects.count(),
                "vote_options": VoteOption.objects.count(),
                "vote_records": VoteRecord.objects.count(),
                "incidents": IncidentRecord.objects.count(),
                "seed_records": seed_record_model.objects.count(),
            },
            first_counts,
        )
        self.assertEqual(
            dict(seed_record_model.objects.values_list("key", "object_id")),
            first_ownership,
        )
        self.assertEqual(second_output.getvalue(), "Demo data seeded.\n")

    def test_seed_refuses_to_prepare_demo_round_with_unowned_eligible_candidates(self):
        call_command("seed_demo_data")
        call_command("seed_demo_data", "--reset")
        singer_activity = Activity.objects.get(title="Demo Singer Contest")
        participant = User.objects.get(username="demo-participant")
        unowned_singer = SingerRegistration.objects.create(
            activity=singer_activity,
            user=participant,
            name="Unowned Eligible Singer",
            student_id="UNOWNED2026001",
            college="Arts College",
            class_name="Demo Class C",
            phone="13800000003",
            song_name="Unowned Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=False,
        )
        unowned_judge = Judge.objects.create(
            activity=singer_activity,
            name="Unowned Active Judge",
        )

        with self.assertRaisesMessage(
            CommandError,
            "Cannot prepare demo round with unowned eligible singers or active judges.",
        ):
            call_command("seed_demo_data")

        contest_round = ContestRound.objects.get(name="Demo Preliminary Round")
        self.assertEqual(contest_round.status, ContestRound.Status.DRAFT)
        self.assertFalse(RoundEntry.objects.filter(round=contest_round).exists())
        self.assertFalse(RoundJudge.objects.filter(round=contest_round).exists())
        self.assertFalse(RoundEntry.objects.filter(singer=unowned_singer).exists())
        self.assertFalse(RoundJudge.objects.filter(judge=unowned_judge).exists())

    def test_reset_removes_only_registered_demo_runtime_data(self):
        formal_user = User.objects.create_user(
            username="formal-participant",
            password="safe-password",
        )
        formal_activity = Activity.objects.create(
            title="Formal singer contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        formal_registration = SingerRegistration.objects.create(
            activity=formal_activity,
            user=formal_user,
            name="Formal Singer",
            student_id="20260001",
            college="Music",
            class_name="Class A",
            phone="13800000001",
            song_name="Formal Song",
            pre_status=SingerRegistration.PreStatus.SUBMITTED,
            is_test_data=False,
        )
        formal_vote = VoteSession.objects.create(
            activity=formal_activity,
            name="Formal vote",
            passcode="formal-code",
            start_time=self.seed_time,
            end_time=self.seed_time + timedelta(hours=1),
            is_test_data=False,
        )
        formal_template = ArticleTemplate.objects.create(
            name="Formal rehearsal notice",
            template_type=ArticleTemplate.TemplateType.REHEARSAL_NOTICE,
            body="Formal configuration stays intact.",
        )
        audit_log = AuditLog.objects.create(
            operator=formal_user,
            action_type=AuditLog.ActionType.OTHER,
            target="Formal audit trail",
        )
        unrelated_test_activity = Activity.objects.create(
            title="Unrelated test activity",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.TESTING,
            is_test_mode=True,
        )
        unrelated_test_registration = SingerRegistration.objects.create(
            activity=unrelated_test_activity,
            user=formal_user,
            name="Unrelated Test Singer",
            student_id="20260002",
            college="Music",
            class_name="Class B",
            phone="13800000002",
            song_name="Unrelated Test Song",
            is_test_data=True,
        )
        unrelated_test_vote = VoteSession.objects.create(
            activity=unrelated_test_activity,
            name="Unrelated test vote",
            passcode="test-code",
            start_time=self.seed_time,
            end_time=self.seed_time + timedelta(hours=1),
            is_test_data=True,
        )

        call_command("seed_demo_data")
        seed_record_model = self._seed_record_model()
        seed_record_snapshot = dict(seed_record_model.objects.values_list("key", "object_id"))
        demo_activity_ids = self._seeded_activity_ids()

        output = StringIO()
        call_command("seed_demo_data", "--reset", stdout=output)

        self.assertFalse(
            SingerRegistration.objects.filter(
                activity_id__in=demo_activity_ids,
                is_test_data=True,
            ).exists()
        )
        self.assertFalse(
            Program.objects.filter(activity_id__in=demo_activity_ids, is_test_data=True).exists()
        )
        self.assertFalse(
            ScoreRecord.objects.filter(
                round__activity_id__in=demo_activity_ids,
                is_test_data=True,
            ).exists()
        )
        self.assertFalse(
            ScoreSummary.objects.filter(
                round__activity_id__in=demo_activity_ids,
                is_test_data=True,
            ).exists()
        )
        self.assertFalse(
            Award.objects.filter(activity_id__in=demo_activity_ids, is_test_data=True).exists()
        )
        self.assertFalse(
            VoteSession.objects.filter(
                activity_id__in=demo_activity_ids,
                is_test_data=True,
            ).exists()
        )
        self.assertFalse(
            IncidentRecord.objects.filter(
                activity_id__in=demo_activity_ids,
                is_test=True,
            ).exists()
        )
        seeded_round = ContestRound.objects.get(name="Demo Preliminary Round")
        self.assertEqual(seeded_round.status, ContestRound.Status.DRAFT)
        self.assertFalse(seeded_round.is_locked)
        self.assertFalse(RoundEntry.objects.filter(round=seeded_round).exists())
        self.assertFalse(RoundJudge.objects.filter(round=seeded_round).exists())
        self.assertTrue(
            AuditLog.objects.filter(
                operator=User.objects.get(username="demo-admin"),
                action_type=AuditLog.ActionType.OTHER,
                target=f"ContestRound:{seeded_round.pk}",
                note="Demo test round reset",
            ).exists()
        )
        self.assertEqual(
            PublicPost.objects.filter(related_activity_id__in=demo_activity_ids).count(),
            2,
        )
        self.assertEqual(
            ArticleTemplate.objects.filter(
                template_type__in=[
                    ArticleTemplate.TemplateType.SINGER_REGISTRATION,
                    ArticleTemplate.TemplateType.PROGRAM_COLLECTION,
                ]
            ).count(),
            2,
        )
        self.assertEqual(
            dict(seed_record_model.objects.values_list("key", "object_id")),
            seed_record_snapshot,
        )
        self.assertTrue(Activity.objects.filter(pk=formal_activity.pk).exists())
        self.assertTrue(SingerRegistration.objects.filter(pk=formal_registration.pk).exists())
        self.assertTrue(VoteSession.objects.filter(pk=formal_vote.pk).exists())
        self.assertTrue(ArticleTemplate.objects.filter(pk=formal_template.pk).exists())
        self.assertTrue(AuditLog.objects.filter(pk=audit_log.pk).exists())
        self.assertTrue(Activity.objects.filter(pk=unrelated_test_activity.pk).exists())
        self.assertTrue(
            SingerRegistration.objects.filter(pk=unrelated_test_registration.pk).exists()
        )
        self.assertTrue(VoteSession.objects.filter(pk=unrelated_test_vote.pk).exists())
        self.assertEqual(output.getvalue(), "Demo test runtime data reset.\n")

    def test_reset_retains_vote_session_with_an_unowned_vote_record(self):
        call_command("seed_demo_data")
        vote_session = VoteSession.objects.get(name="Demo Audience Choice")
        vote_option = VoteOption.objects.get(vote_session=vote_session, sort_order=1)
        seeded_award = Award.objects.get(name="Demo First Place")
        unowned_record = VoteRecord.objects.create(
            vote_session=vote_session,
            vote_option=vote_option,
            browser_session_key="unowned-browser-session",
            ip_address="127.0.0.9",
        )

        output = StringIO()
        call_command("seed_demo_data", "--reset", stdout=output)

        self.assertTrue(VoteSession.objects.filter(pk=vote_session.pk).exists())
        self.assertTrue(VoteRecord.objects.filter(pk=unowned_record.pk).exists())
        self.assertTrue(Award.objects.filter(pk=seeded_award.pk).exists())
        self.assertEqual(output.getvalue(), "Demo reset retained unsafe runtime data.\n")

    def test_reset_retains_singer_with_an_unowned_award(self):
        call_command("seed_demo_data")
        singer = SingerRegistration.objects.get(name="Demo Singer One")
        seeded_round = ContestRound.objects.get(name="Demo Preliminary Round")
        snapshot_counts = (seeded_round.entries.count(), seeded_round.round_judges.count())
        unowned_award = Award.objects.create(
            activity=singer.activity,
            singer=singer,
            name="Unowned award",
            is_test_data=True,
        )

        output = StringIO()
        call_command("seed_demo_data", "--reset", stdout=output)

        self.assertTrue(SingerRegistration.objects.filter(pk=singer.pk).exists())
        self.assertTrue(Award.objects.filter(pk=unowned_award.pk).exists())
        seeded_round.refresh_from_db()
        self.assertEqual(seeded_round.status, ContestRound.Status.PREPARED)
        self.assertEqual(
            (seeded_round.entries.count(), seeded_round.round_judges.count()), snapshot_counts
        )
        self.assertEqual(output.getvalue(), "Demo reset retained unsafe runtime data.\n")

    def test_reset_retains_round_with_an_unowned_non_test_snapshot_parent(self):
        call_command("seed_demo_data")
        contest_round = ContestRound.objects.get(name="Demo Preliminary Round")
        participant = User.objects.get(username="demo-participant")
        contest_round.status = ContestRound.Status.DRAFT
        contest_round.save(update_fields=["status"])
        unowned_singer = SingerRegistration.objects.create(
            activity=contest_round.activity,
            user=participant,
            name="Unowned Snapshot Singer",
            student_id="UNOWNED2026002",
            college="Arts College",
            class_name="Demo Class C",
            phone="13800000004",
            song_name="Unowned Snapshot Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=False,
        )
        snapshot = RoundEntry.objects.create(round=contest_round, singer=unowned_singer)
        contest_round.status = ContestRound.Status.PREPARED
        contest_round.save(update_fields=["status"])
        runtime_counts = {
            "scores": ScoreRecord.objects.count(),
            "summaries": ScoreSummary.objects.count(),
            "awards": Award.objects.count(),
            "vote_sessions": VoteSession.objects.count(),
        }

        output = StringIO()
        call_command("seed_demo_data", "--reset", stdout=output)

        contest_round.refresh_from_db()
        self.assertEqual(contest_round.status, ContestRound.Status.PREPARED)
        self.assertTrue(RoundEntry.objects.filter(pk=snapshot.pk, singer=unowned_singer).exists())
        self.assertEqual(
            {
                "scores": ScoreRecord.objects.count(),
                "summaries": ScoreSummary.objects.count(),
                "awards": Award.objects.count(),
                "vote_sessions": VoteSession.objects.count(),
            },
            runtime_counts,
        )
        self.assertEqual(output.getvalue(), "Demo reset retained unsafe runtime data.\n")

    def test_reset_retains_singer_with_an_unowned_staff_note(self):
        call_command("seed_demo_data")
        singer = SingerRegistration.objects.get(name="Demo Singer One")
        unowned_note = StaffNote.objects.create(
            singer_registration=singer,
            content="Unowned staff note",
            created_by=User.objects.get(username="demo-participant"),
        )

        output = StringIO()
        call_command("seed_demo_data", "--reset", stdout=output)

        self.assertTrue(SingerRegistration.objects.filter(pk=singer.pk).exists())
        self.assertTrue(StaffNote.objects.filter(pk=unowned_note.pk).exists())
        self.assertEqual(output.getvalue(), "Demo reset retained unsafe runtime data.\n")

    def test_reset_retains_program_with_an_unowned_submission_file(self):
        call_command("seed_demo_data")
        program = Program.objects.get(name="Demo Opening Song")
        unowned_file = SubmissionFile.objects.create(
            program=program,
            file="submissions/unowned-program-material.txt",
            original_name="unowned-program-material.txt",
            file_size=1,
            uploaded_by=User.objects.get(username="demo-participant"),
        )

        output = StringIO()
        call_command("seed_demo_data", "--reset", stdout=output)

        self.assertTrue(Program.objects.filter(pk=program.pk).exists())
        self.assertTrue(SubmissionFile.objects.filter(pk=unowned_file.pk).exists())
        self.assertEqual(output.getvalue(), "Demo reset retained unsafe runtime data.\n")

    def test_reset_retains_program_with_an_unowned_material_check(self):
        call_command("seed_demo_data")
        program = Program.objects.get(name="Demo Opening Song")
        unowned_check = MaterialCheck.objects.create(
            program=program,
            item_name="Unowned material check",
        )

        output = StringIO()
        call_command("seed_demo_data", "--reset", stdout=output)

        self.assertTrue(Program.objects.filter(pk=program.pk).exists())
        self.assertTrue(MaterialCheck.objects.filter(pk=unowned_check.pk).exists())
        self.assertEqual(output.getvalue(), "Demo reset retained unsafe runtime data.\n")
