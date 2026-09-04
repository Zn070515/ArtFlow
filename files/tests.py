import shutil
import tempfile
import threading
from unittest import skipUnless

from accounts.models import User
from common.authority import ACTIVITY_STATE, authority_write
from common.models import AuditLog
from core.models import Activity
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, close_old_connections, connection, transaction
from django.db.models import Count
from django.test import TestCase, TransactionTestCase, override_settings
from singer_contest.models import SingerRegistration

from .models import MaterialCheck, MaterialRequirement, SubmissionFile
from .services import (
    delete_submission_file,
    large_video_upload_allowed,
    reconcile_activity_material_checks,
    reconcile_singer_material_checks,
    review_material_check,
    store_submission_file,
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

    def test_store_submission_file_rejects_locked_activity(self):
        self.activity.is_locked = True
        with authority_write(ACTIVITY_STATE):
            self.activity.save(update_fields=["is_locked"])

        with self.assertRaisesMessage(PermissionDenied, "Activity results are locked."):
            store_submission_file(
                owner=self.registration,
                uploaded_file=SimpleUploadedFile("song.mp3", b"audio", content_type="audio/mpeg"),
                purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                uploaded_by=self.user,
            )

        self.assertFalse(SubmissionFile.objects.exists())

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
        reconcile_singer_material_checks(self.registration)
        check = MaterialCheck.objects.get(
            singer_registration=self.registration, item_name="伴奏文件"
        )
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)
        review_material_check(
            check, status=MaterialCheck.Status.APPROVED, note="ok", actor=self.user
        )
        reconcile_singer_material_checks(self.registration)
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.APPROVED)
        self.assertEqual(check.review_note, "ok")

    def test_sync_marks_no_file_as_missing(self):
        reconcile_singer_material_checks(self.registration)
        check = MaterialCheck.objects.get(
            singer_registration=self.registration, item_name="伴奏文件"
        )
        self.assertEqual(check.status, MaterialCheck.Status.MISSING)

    def test_non_file_check_defaults_to_uploaded(self):
        reconcile_singer_material_checks(self.registration)
        check = MaterialCheck.objects.get(
            singer_registration=self.registration, item_name="基本信息"
        )
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)

    def test_upload_resets_reviewed_check_to_uploaded(self):
        reconcile_singer_material_checks(self.registration)
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


class VideoDirectUploadGateTests(TestCase):
    """§15.6 — a FORMAL activity must not accept oversized video direct-uploads."""

    def setUp(self):
        self.media_root = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()
        self.user = User.objects.create_user(username="participant", password="pass")

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.media_root, ignore_errors=True)

    def _video(self, size):
        return SimpleUploadedFile("clip.mp4", b"x" * size, content_type="video/mp4")

    def test_formal_activity_rejects_oversize_video(self):
        activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        self.assertEqual(activity.data_lifecycle, Activity.DataLifecycle.FORMAL)
        upload = self._video(200 * 1024 * 1024)

        with self.assertRaisesMessage(ValidationError, "正式活动不支持大视频直传。"):
            validate_upload(upload, SubmissionFile.Purpose.PERFORMANCE_VIDEO, activity=activity)

    def test_formal_activity_accepts_small_video_under_cap(self):
        activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        upload = self._video(1024 * 1024)

        validate_upload(upload, SubmissionFile.Purpose.PERFORMANCE_VIDEO, activity=activity)

    def test_test_mode_activity_keeps_full_video_cap(self):
        activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
        )
        self.assertEqual(activity.data_lifecycle, Activity.DataLifecycle.TEST)
        upload = self._video(50 * 1024 * 1024)

        validate_upload(upload, SubmissionFile.Purpose.PERFORMANCE_VIDEO, activity=activity)

    def test_zero_cap_bans_any_video_for_formal_activity(self):
        activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        with override_settings(ARTFLOW_VIDEO_UPLOAD_MAX_MB=0):
            upload = self._video(1024)

            with self.assertRaisesMessage(ValidationError, "正式活动不支持大视频直传。"):
                validate_upload(upload, SubmissionFile.Purpose.PERFORMANCE_VIDEO, activity=activity)

    def test_large_video_upload_allowed_flips_with_lifecycle(self):
        formal = Activity.objects.create(
            title="Formal",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        test = Activity.objects.create(
            title="Test",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
        )

        self.assertFalse(large_video_upload_allowed(formal))
        self.assertTrue(large_video_upload_allowed(test))

    def test_store_submission_file_blocks_formal_video_upload(self):
        activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        reg = SingerRegistration.objects.create(
            activity=activity,
            user=self.user,
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
        )

        with self.assertRaisesMessage(ValidationError, "正式活动不支持大视频直传。"):
            store_submission_file(
                owner=reg,
                uploaded_file=self._video(200 * 1024 * 1024),
                purpose=SubmissionFile.Purpose.PERFORMANCE_VIDEO,
                uploaded_by=self.user,
            )
        self.assertFalse(SubmissionFile.objects.exists())


class MaterialCheckReconcileTests(TestCase):
    def setUp(self):
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

    def test_reconcile_activity_adds_check_after_requirement_add(self):
        reconcile_activity_material_checks(self.activity, MaterialRequirement.AppliesTo.SINGER)
        self.assertEqual(
            set(self.registration.material_checks.values_list("item_name", flat=True)),
            {"基本信息", "联系方式", "伴奏文件"},
        )
        MaterialRequirement.objects.create(
            activity=self.activity,
            applies_to=MaterialRequirement.AppliesTo.SINGER,
            item_name="往届照片",
            file_purpose=SubmissionFile.Purpose.SHOWCASE_IMAGE,
        )
        reconcile_activity_material_checks(self.activity, MaterialRequirement.AppliesTo.SINGER)
        self.assertIn(
            "往届照片",
            set(self.registration.material_checks.values_list("item_name", flat=True)),
        )

    def test_reconcile_activity_prunes_removed_requirement(self):
        MaterialRequirement.objects.create(
            activity=self.activity,
            applies_to=MaterialRequirement.AppliesTo.SINGER,
            item_name="伴奏",
            file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        MaterialRequirement.objects.create(
            activity=self.activity,
            applies_to=MaterialRequirement.AppliesTo.SINGER,
            item_name="歌词",
            file_purpose=SubmissionFile.Purpose.LYRICS_SCRIPT,
        )
        reconcile_activity_material_checks(self.activity, MaterialRequirement.AppliesTo.SINGER)
        self.assertEqual(
            set(self.registration.material_checks.values_list("item_name", flat=True)),
            {"伴奏", "歌词"},
        )
        MaterialRequirement.objects.filter(
            activity=self.activity,
            applies_to=MaterialRequirement.AppliesTo.SINGER,
            item_name="歌词",
        ).delete()
        reconcile_activity_material_checks(self.activity, MaterialRequirement.AppliesTo.SINGER)
        self.assertEqual(
            set(self.registration.material_checks.values_list("item_name", flat=True)),
            {"伴奏"},
        )

    def test_unique_constraint_rejects_duplicate_owner_item(self):
        MaterialCheck.objects.create(singer_registration=self.registration, item_name="唯一项")
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                MaterialCheck.objects.create(
                    singer_registration=self.registration, item_name="唯一项"
                )

    def test_reconcile_rejects_archived_activity(self):
        self.activity.phase = Activity.Phase.ARCHIVED
        with authority_write(ACTIVITY_STATE):
            self.activity.save(update_fields=["phase"])
        with self.assertRaises(PermissionDenied):
            reconcile_singer_material_checks(self.registration)

    def test_reconcile_never_duplicates_on_repeat(self):
        reconcile_singer_material_checks(self.registration)
        reconcile_singer_material_checks(self.registration)
        counts = (
            self.registration.material_checks.values("item_name")
            .annotate(total=Count("pk"))
            .values_list("total", flat=True)
        )
        self.assertTrue(all(total == 1 for total in counts))


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class MaterialCheckReconcileConcurrencyTests(TransactionTestCase):
    """M0-V: concurrent reconcile of one owner never yields duplicate rows."""

    def setUp(self):
        self.user = User.objects.create_user(username="concurrent-participant", password="pass")
        self.activity = Activity.objects.create(
            title="Concurrent Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        self.registration = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.user,
            name="Concurrent Singer",
            student_id="20260099",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
        )

    def test_concurrent_reconcile_keeps_single_row_per_item(self):
        errors: dict[str, object] = {}

        def run_reconcile():
            close_old_connections()
            try:
                reconcile_singer_material_checks(self.registration)
            except Exception as error:  # pragma: no cover - diagnostic only
                errors["error"] = repr(error)
            finally:
                close_old_connections()

        threads = [threading.Thread(target=run_reconcile) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        self.assertFalse(errors, errors)
        counts = (
            self.registration.material_checks.values("item_name")
            .annotate(total=Count("pk"))
            .values_list("total", flat=True)
        )
        self.assertTrue(all(total == 1 for total in counts))
