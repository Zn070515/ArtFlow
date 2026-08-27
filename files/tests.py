import shutil
import tempfile

from accounts.models import User
from core.models import Activity
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from singer_contest.models import SingerRegistration

from .models import SubmissionFile
from .services import delete_submission_file, store_submission_file, validate_upload


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
            is_test_data=True,
        )
        second = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile("second.mp3", b"second", content_type="audio/mpeg"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
            is_test_data=True,
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
            is_test_data=True,
        )
        stored_name = submission.file.name
        self.assertTrue(submission.file.storage.exists(stored_name))

        delete_submission_file(submission)

        self.assertFalse(SubmissionFile.objects.filter(pk=submission.pk).exists())
        self.assertFalse(submission.file.storage.exists(stored_name))

    def test_deleting_current_file_promotes_latest_historical_version(self):
        first = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile("first.mp3", b"first", content_type="audio/mpeg"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
            is_test_data=True,
        )
        second = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile("second.mp3", b"second", content_type="audio/mpeg"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
            is_test_data=True,
        )

        delete_submission_file(second)

        first.refresh_from_db()
        self.assertTrue(first.is_current)
