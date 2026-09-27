import shutil
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest import skipUnless
from unittest.mock import patch

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from common.models import AuditLog
from core.models import Activity
from django.core.cache import cache
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


def _create_activity(**kwargs):
    with authority_write(ACTIVITY_STATE):
        return Activity.objects.create(**kwargs)


class SubmissionFileLifecycleTests(TestCase):
    def setUp(self):
        self.media_root = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()
        self.user = User.objects.create_user(username="participant", password="pass")
        self.activity = _create_activity(
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

    def test_upload_policy_rejects_random_bytes_with_allowed_audio_name(self):
        upload = SimpleUploadedFile(
            "song.mp3", b"not an audio container", content_type="audio/mpeg"
        )

        with self.assertRaises(ValidationError):
            validate_upload(upload, SubmissionFile.Purpose.ACCOMPANIMENT)

    def test_upload_policy_rejects_malformed_image_bytes(self):
        upload = SimpleUploadedFile("poster.png", b"not a png", content_type="image/png")

        with self.assertRaises(ValidationError):
            validate_upload(upload, SubmissionFile.Purpose.PROGRAM_IMAGE)

    @override_settings(ARTFLOW_UPLOAD_RATE_LIMIT=1, ARTFLOW_UPLOAD_RATE_WINDOW_SECONDS=60)
    def test_upload_rate_limit_is_scoped_to_owner_and_purpose(self):
        cache.clear()
        valid_audio = b"ID3\x04\x00\x00\x00\x00\x00\x00"
        store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile("first.mp3", valid_audio, content_type="audio/mpeg"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )

        with self.assertRaisesMessage(ValidationError, "上传操作过于频繁"):
            store_submission_file(
                owner=self.registration,
                uploaded_file=SimpleUploadedFile(
                    "second.mp3", valid_audio, content_type="audio/mpeg"
                ),
                purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                uploaded_by=self.user,
            )

    @override_settings(ARTFLOW_UPLOAD_MAX_VERSIONS=2)
    def test_upload_retains_only_the_configured_recent_versions(self):
        cache.clear()
        audio = b"ID3\x04\x00\x00\x00\x00\x00\x00"
        for name in ("first.mp3", "second.mp3", "third.mp3"):
            store_submission_file(
                owner=self.registration,
                uploaded_file=SimpleUploadedFile(name, audio, content_type="audio/mpeg"),
                purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                uploaded_by=self.user,
            )

        self.assertEqual(
            SubmissionFile.objects.filter(
                singer_registration=self.registration,
                file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            ).count(),
            2,
        )

    @override_settings(ARTFLOW_UPLOAD_QUOTA_MB=1)
    def test_upload_quota_is_scoped_to_owner_and_purpose(self):
        cache.clear()
        audio = b"ID3" + b"x" * (700 * 1024)
        store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile("large.mp3", audio, content_type="audio/mpeg"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )

        with self.assertRaisesMessage(ValidationError, "存储配额"):
            store_submission_file(
                owner=self.registration,
                uploaded_file=SimpleUploadedFile("large-2.mp3", audio, content_type="audio/mpeg"),
                purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                uploaded_by=self.user,
            )

    @patch("files.services.shutil.disk_usage", return_value=SimpleNamespace(free=0))
    def test_upload_rejects_when_media_disk_is_below_low_water_mark(self, _disk_usage):
        upload = SimpleUploadedFile(
            "song.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00", content_type="audio/mpeg"
        )

        with self.assertRaisesMessage(ValidationError, "存储空间不足"):
            store_submission_file(
                owner=self.registration,
                uploaded_file=upload,
                purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                uploaded_by=self.user,
            )

    def test_upload_recreates_missing_media_root_before_disk_check(self):
        shutil.rmtree(self.media_root)
        upload = SimpleUploadedFile(
            "song.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00", content_type="audio/mpeg"
        )

        def assert_media_root_exists(path):
            self.assertTrue(Path(path).is_dir())
            return SimpleNamespace(free=1024**3)

        with patch("files.services.shutil.disk_usage", side_effect=assert_media_root_exists):
            created = store_submission_file(
                owner=self.registration,
                uploaded_file=upload,
                purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                uploaded_by=self.user,
            )

        self.assertTrue(Path(self.media_root).is_dir())
        self.assertTrue(created.file.name)

    def test_replacing_upload_demotes_previous_file(self):
        first = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile(
                "first.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00", content_type="audio/mpeg"
            ),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )
        second = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile(
                "second.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00", content_type="audio/mpeg"
            ),
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
                uploaded_file=SimpleUploadedFile(
                    "song.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00", content_type="audio/mpeg"
                ),
                purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                uploaded_by=self.user,
            )

        self.assertFalse(SubmissionFile.objects.exists())

    def test_deleting_submission_file_removes_database_row_and_storage_object(self):
        submission = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile(
                "song.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00", content_type="audio/mpeg"
            ),
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
            uploaded_file=SimpleUploadedFile(
                "first.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00", content_type="audio/mpeg"
            ),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )
        second = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile(
                "second.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00", content_type="audio/mpeg"
            ),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )

        delete_submission_file(second)

        first.refresh_from_db()
        self.assertTrue(first.is_current)

    def test_deleting_submission_file_defers_storage_removal_until_commit(self):
        submission = store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile(
                "song.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00", content_type="audio/mpeg"
            ),
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
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="material-reviewer", password="pass", role=User.Role.STAFF
            )
        self.activity = _create_activity(
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
            check, status=MaterialCheck.Status.APPROVED, note="清晰", actor=self.staff
        )
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.APPROVED)
        self.assertEqual(check.review_note, "清晰")
        self.assertEqual(check.reviewed_by, self.staff)
        self.assertIsNotNone(check.reviewed_at)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.REVIEW_MATERIAL,
                target=f"MaterialCheck:{check.pk}",
            ).exists()
        )

    def test_review_material_check_rejects_participant_actor(self):
        check = MaterialCheck.objects.create(
            singer_registration=self.registration,
            item_name="伴奏文件",
            status=MaterialCheck.Status.UPLOADED,
        )

        with self.assertRaises(PermissionDenied):
            review_material_check(
                check,
                status=MaterialCheck.Status.APPROVED,
                note="不应越权审核",
                actor=self.user,
            )

        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)
        self.assertIsNone(check.reviewed_by)
        self.assertFalse(
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
                check, status=MaterialCheck.Status.MISSING, note="", actor=self.staff
            )

    def test_sync_preserves_staff_review_state(self):
        store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile(
                "song.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00", content_type="audio/mpeg"
            ),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )
        reconcile_singer_material_checks(self.registration)
        check = MaterialCheck.objects.get(
            singer_registration=self.registration, item_name="伴奏文件"
        )
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)
        review_material_check(
            check, status=MaterialCheck.Status.APPROVED, note="ok", actor=self.staff
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
            check, status=MaterialCheck.Status.APPROVED, note="ok", actor=self.staff
        )
        store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile(
                "song.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00", content_type="audio/mpeg"
            ),
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
        header = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00"
        return SimpleUploadedFile(
            "clip.mp4", header + b"x" * max(0, size - len(header)), content_type="video/mp4"
        )

    def test_formal_activity_rejects_oversize_video(self):
        activity = _create_activity(
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
        activity = _create_activity(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        upload = self._video(1024 * 1024)

        validate_upload(upload, SubmissionFile.Purpose.PERFORMANCE_VIDEO, activity=activity)

    def test_test_mode_activity_keeps_full_video_cap(self):
        activity = _create_activity(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
        )
        self.assertEqual(activity.data_lifecycle, Activity.DataLifecycle.TEST)
        upload = self._video(50 * 1024 * 1024)

        validate_upload(upload, SubmissionFile.Purpose.PERFORMANCE_VIDEO, activity=activity)

    def test_zero_cap_bans_any_video_for_formal_activity(self):
        activity = _create_activity(
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
        formal = _create_activity(
            title="Formal",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        test = _create_activity(
            title="Test",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
        )

        self.assertFalse(large_video_upload_allowed(formal))
        self.assertTrue(large_video_upload_allowed(test))

    def test_store_submission_file_blocks_formal_video_upload(self):
        activity = _create_activity(
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
        self.activity = _create_activity(
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

    def test_reconcile_records_the_requested_file_purpose(self):
        reconcile_singer_material_checks(self.registration)
        self.assertEqual(
            MaterialCheck.objects.get(
                singer_registration=self.registration, item_name="伴奏文件"
            ).file_purpose,
            SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        self.assertEqual(
            MaterialCheck.objects.get(
                singer_registration=self.registration, item_name="基本信息"
            ).file_purpose,
            "",
        )

    def test_reconcile_resets_review_when_the_material_type_changes(self):
        requirement = MaterialRequirement.objects.create(
            activity=self.activity,
            applies_to=MaterialRequirement.AppliesTo.SINGER,
            item_name="歌词",
            file_purpose=SubmissionFile.Purpose.LYRICS_SCRIPT,
        )
        reconcile_singer_material_checks(self.registration)
        check = MaterialCheck.objects.get(singer_registration=self.registration, item_name="歌词")
        check.status = MaterialCheck.Status.APPROVED
        check.review_note = "已核对"
        check.reviewed_by = self.user
        check.save(update_fields=["status", "review_note", "reviewed_by"])

        requirement.file_purpose = SubmissionFile.Purpose.ACCOMPANIMENT
        requirement.save(update_fields=["file_purpose"])
        reconcile_singer_material_checks(self.registration)

        check.refresh_from_db()
        self.assertEqual(check.file_purpose, SubmissionFile.Purpose.ACCOMPANIMENT)
        # The staff approval belonged to a different material type: it must not be
        # inherited, and no file of the new type exists yet.
        self.assertEqual(check.status, MaterialCheck.Status.MISSING)
        self.assertEqual(check.review_note, "")
        self.assertIsNone(check.reviewed_by)
        self.assertIsNone(check.reviewed_at)

    def test_reconcile_keeps_review_when_the_material_type_is_unchanged(self):
        reconcile_singer_material_checks(self.registration)
        check = MaterialCheck.objects.get(
            singer_registration=self.registration, item_name="基本信息"
        )
        check.status = MaterialCheck.Status.APPROVED
        check.review_note = "已核对"
        check.save(update_fields=["status", "review_note"])
        reconcile_singer_material_checks(self.registration)
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.APPROVED)
        self.assertEqual(check.review_note, "已核对")

    def test_upload_only_resets_checks_of_that_purpose(self):
        # A configured requirement list replaces the fallback list wholesale, so both
        # scopes have to be declared explicitly here.
        MaterialRequirement.objects.create(
            activity=self.activity,
            applies_to=MaterialRequirement.AppliesTo.SINGER,
            item_name="伴奏文件",
            file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        MaterialRequirement.objects.create(
            activity=self.activity,
            applies_to=MaterialRequirement.AppliesTo.SINGER,
            item_name="歌词",
            file_purpose=SubmissionFile.Purpose.LYRICS_SCRIPT,
        )
        reconcile_singer_material_checks(self.registration)
        accompaniment = MaterialCheck.objects.get(
            singer_registration=self.registration, item_name="伴奏文件"
        )
        lyrics = MaterialCheck.objects.get(singer_registration=self.registration, item_name="歌词")
        for check in (accompaniment, lyrics):
            check.status = MaterialCheck.Status.APPROVED
            check.review_note = "已核对"
            check.save(update_fields=["status", "review_note"])

        store_submission_file(
            owner=self.registration,
            uploaded_file=SimpleUploadedFile(
                "song.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00", content_type="audio/mpeg"
            ),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.user,
        )

        accompaniment.refresh_from_db()
        lyrics.refresh_from_db()
        self.assertEqual(accompaniment.status, MaterialCheck.Status.UPLOADED)
        self.assertEqual(accompaniment.review_note, "")
        self.assertEqual(lyrics.status, MaterialCheck.Status.APPROVED)
        self.assertEqual(lyrics.review_note, "已核对")


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class MaterialCheckReconcileConcurrencyTests(TransactionTestCase):
    """M0-V: concurrent reconcile of one owner never yields duplicate rows."""

    def setUp(self):
        self.user = User.objects.create_user(username="concurrent-participant", password="pass")
        self.activity = _create_activity(
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
