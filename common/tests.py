from datetime import datetime, timedelta
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from accounts.models import User
from core.models import Activity
from django.conf import settings
from django.contrib.contenttypes.models import ContentType
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, IntegrityError, transaction
from django.db import models as django_models
from django.test import TestCase, override_settings
from django.utils import timezone
from exports.models import ArticleTemplate
from farewell_show.models import Program
from files.models import MaterialCheck, StaffNote, SubmissionFile
from incidents.models import IncidentRecord
from public_portal.models import PublicPost
from singer_contest.models import (
    Award,
    ContestRound,
    Judge,
    ScoreRecord,
    ScoreSummary,
    SingerRegistration,
)
from voting.models import VoteOption, VoteRecord, VoteSession

from . import models as common_models
from .models import AuditLog

DOCTOR_SECRET_KEY_SENTINEL = "doctor-secret-key-sentinel"
DOCTOR_ADMIN_LOGIN_KEY_SENTINEL = "doctor-admin-login-key-sentinel"
DOCTOR_DATABASE_PASSWORD_SENTINEL = "doctor-database-password-sentinel"


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
        self.assertIsNotNone(seed_record_model)
        self.assertIsInstance(
            seed_record_model._meta.get_field("object_id"),
            django_models.PositiveBigIntegerField,
        )

        user = User.objects.create_user(username="seed-record-owner", password="safe-password")
        content_type = ContentType.objects.get_for_model(User)
        first_record = seed_record_model.objects.create(
            key="demo.user.owner",
            content_type=content_type,
            object_id=user.pk,
        )

        self.assertIsNotNone(first_record.created_at)
        with self.assertRaises(IntegrityError), transaction.atomic():
            seed_record_model.objects.create(
                key="demo.user.other",
                content_type=content_type,
                object_id=user.pk,
            )
        with self.assertRaises(IntegrityError), transaction.atomic():
            seed_record_model.objects.create(
                key="demo.user.owner",
                content_type=content_type,
                object_id=user.pk + 1,
            )


class DemoSeedCommandTests(TestCase):
    seed_time = timezone.make_aware(datetime(2026, 9, 1, 9, 0))

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
        self.assertTrue(SingerRegistration.objects.filter(pk=unrelated_test_registration.pk).exists())
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
