import shutil
import tempfile

from accounts.models import User
from common.models import AuditLog
from core.models import Activity
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import transaction
from django.test import TestCase, override_settings
from singer_contest.models import SingerRegistration

from .models import MaterialCheck, SubmissionFile
from .services import (
    delete_submission_file,
    review_material_check,
    store_submission_file,
    sync_singer_material_checks,
    validate_upload,
)


class SubmissionFileLifecycleTests(TestCase):
    def setUp(self):
        self.media_root = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()
        self.user = User.objects.create_user(username="participant", password="pass")
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
        )
        self.registration = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.user,
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
        )

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.media_root, ignore_errors=True)

    def test_upload_policy_rejects_oversize_file(self):
        upload = SimpleUploadedFile(
            "song.mp3", b"x" * (101 * 1024 * 1024), content_type="audio/mpeg"
        )

        with self.assertRaises(ValidationError):
            validate_upload(upload, SubmissionFile.Purpose.ACCOMPANIMENT)

    def test_upload_policy_rejects_disallowed_extension(self):
        upload = SimpleUploadedFile("song.exe", b"x", content_type="application/octet-stream")

        with self.assertRaises(ValidationError):
            validate_upload(upload, SubmissionFile.Purpose.ACCOMPANIMENT)

    def test_upload_policy_rejects_mismatched_content_type(self):
        upload = SimpleUploadedFile("song.mp3", b"audio", content_type="text/html")

        with self.assertRaises(ValidationError):
            validate_upload(upload, SubmissionFile.Purpose.ACCOMPANIMENT)

    def test_replacing_upload_demotes_previous_file(self):
        first = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile("first.mp3", b"first", content_type="audio/mpeg"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )
        second = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile("second.mp3", b"second", content_type="audio/mpeg"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )

        first.refresh_from_db()
        self.assertFalse(first.is_current)
        self.assertTrue(second.is_current)
        self.assertEqual(second.version, 2)

    def test_deleting_submission_file_removes_database_row_and_storage_object(self):
        submission = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile("song.mp3", b"audio", content_type="audio/mpeg"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )
        stored_name = submission.file.name
        self.assertTrue(submission.file.storage.exists(stored_name))

        with self.captureOnCommitCallbacks(execute=True):
            delete_submission_file(submission)

        self.assertFalse(SubmissionFile.objects.filter(pk=submission.pk).exists())
        self.assertFalse(submission.file.storage.exists(stored_name))

    def test_deleting_current_file_promotes_latest_historical_version(self):
        first = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile("first.mp3", b"first", content_type="audio/mpeg"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )
        second = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile("second.mp3", b"second", content_type="audio/mpeg"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )

        delete_submission_file(second)

        first.refresh_from_db()
        self.assertTrue(first.is_current)

    def test_deleting_submission_file_defers_storage_removal_until_commit(self):
        submission = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile("song.mp3", b"audio", content_type="audio/mpeg"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )
        stored_name = submission.file.name
        self.assertTrue(submission.file.storage.exists(stored_name))

        with self.captureOnCommitCallbacks(execute=True):
            with transaction.atomic():
                delete_submission_file(submission)
                # The physical file must survive until the transaction commits,
                # so a later rollback cannot leave a row pointing at a removed file.
                self.assertTrue(submission.file.storage.exists(stored_name))
                self.assertFalse(SubmissionFile.objects.filter(pk=submission.pk).exists())

        # After the commit callback runs the physical object is finally removed.
        self.assertFalse(submission.file.storage.exists(stored_name))


class MaterialCheckReviewTests(TestCase):
    def setUp(self):
        self.media_root = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()
        self.user = User.objects.create_user(username="participant", password="pass")
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        self.registration = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.user,
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
        )

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.media_root, ignore_errors=True)

    def test_review_material_check_sets_status_and_audits(self):
        check = MaterialCheck.objects.create(
            singer_registration=self.registration,
            item_name="伴奏文件",
            status=MaterialCheck.Status.UPLOADED,
        )
        review_material_check(
            check, status=MaterialCheck.Status.APPROVED, note="清晰", actor=self.user
        )
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.APPROVED)
        self.assertEqual(check.review_note, "清晰")
        self.assertEqual(check.reviewed_by, self.user)
        self.assertIsNotNone(check.reviewed_at)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.REVIEW_MATERIAL,
                target=f"MaterialCheck:{check.pk}",
            ).exists()
        )

    def test_review_rejects_non_review_status(self):
        check = MaterialCheck.objects.create(
            singer_registration=self.registration, item_name="伴奏文件"
        )
        with self.assertRaises(ValidationError):
            review_material_check(
                check, status=MaterialCheck.Status.MISSING, note="", actor=self.user
            )

    def test_sync_preserves_staff_review_state(self):
        store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile("song.mp3", b"audio", content_type="audio/mpeg"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )
        sync_singer_material_checks(self.registration)
        check = MaterialCheck.objects.get(
            singer_registration=self.registration, item_name="伴奏文件"
        )
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)
        review_material_check(
            check, status=MaterialCheck.Status.APPROVED, note="ok", actor=self.user
        )
        sync_singer_material_checks(self.registration)
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.APPROVED)
        self.assertEqual(check.review_note, "ok")

    def test_sync_marks_no_file_as_missing(self):
        sync_singer_material_checks(self.registration)
        check = MaterialCheck.objects.get(
            singer_registration=self.registration, item_name="伴奏文件"
        )
        self.assertEqual(check.status, MaterialCheck.Status.MISSING)

    def test_non_file_check_defaults_to_uploaded(self):
        sync_singer_material_checks(self.registration)
        check = MaterialCheck.objects.get(
            singer_registration=self.registration, item_name="基本信息"
        )
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)

    def test_upload_resets_reviewed_check_to_uploaded(self):
        sync_singer_material_checks(self.registration)
        check = MaterialCheck.objects.get(
            singer_registration=self.registration, item_name="伴奏文件"
        )
        review_material_check(
            check, status=MaterialCheck.Status.APPROVED, note="ok", actor=self.user
        )
        store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile("song.mp3", b"audio", content_type="audio/mpeg"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)
        self.assertEqual(check.review_note, "")
