"""§2.3 / §4 — participant material authority after registration closes.

Characterization of the target contract for the 院十佳决赛 participant surface:

- a participant freely edits their own registration and uploads to their own
  file-backed material checks **only** while the activity is ``REGISTRATION_OPEN``;
- from ``REGISTRATION_CLOSED`` / ``REVIEWING`` onward the only participant upload
  path is a staff-designated ``NEEDS_SUPPLEMENT`` check, addressed by ``check_id``;
- the browser never chooses ``file_purpose``: the purpose is the server-maintained
  snapshot on :class:`~files.models.MaterialCheck`;
- a ``check_id`` belonging to another user, another activity, another owner, or to
  a non-file check is refused, and a refused upload stores nothing.

These tests describe the *authority*, not the UI: every one of them drives the real
participant HTTP endpoint (or the owning service) so a hidden button can never be the
reason a rule appears to hold.
"""

import shutil
import tempfile

from accounts.models import User
from common.authority import ACTIVITY_STATE, authority_write
from common.models import AuditLog
from core.models import Activity
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.urls import reverse
from files.models import MaterialCheck, SubmissionFile

from .models import SingerRegistration

MP3_BYTES = b"ID3\x04\x00\x00\x00\x00\x00\x00"
TXT_BYTES = b"lyrics"


def _create_activity(**kwargs):
    with authority_write(ACTIVITY_STATE):
        return Activity.objects.create(**kwargs)


def _set_phase(activity, phase):
    activity.phase = phase
    with authority_write(ACTIVITY_STATE):
        activity.save(update_fields=["phase"])


def _mp3(name="song.mp3"):
    return SimpleUploadedFile(name, MP3_BYTES, content_type="audio/mpeg")


def _txt(name="lyrics.txt"):
    return SimpleUploadedFile(name, TXT_BYTES, content_type="text/plain")


class ParticipantMaterialAuthorityTestCase(TestCase):
    """Shared fixture: one activity, its phase, and one registration with checks."""

    phase = Activity.Phase.REGISTRATION_OPEN

    def setUp(self):
        self.media_root = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.addCleanup(shutil.rmtree, self.media_root, True)
        self.user = User.objects.create_user(username="participant", password="pass")
        self.other = User.objects.create_user(username="other", password="pass")
        self.activity = _create_activity(
            title="院十佳",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=self.phase,
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
        self.client.force_login(self.user)

    def check(self, *, registration=None, item_name="伴奏文件", status, purpose=""):
        return MaterialCheck.objects.create(
            singer_registration=registration or self.registration,
            item_name=item_name,
            status=status,
            file_purpose=purpose,
            sort_order=0,
        )

    def url(self, registration=None):
        return reverse(
            "singer_contest:my_registration_detail",
            args=[(registration or self.registration).pk],
        )

    def post_check(self, check, upload=None, **extra):
        data = {"check_id": str(check.pk), **(extra or {})}
        if upload is not None:
            data["file"] = upload
        return self.client.post(self.url(), data)

    def assert_no_new_file(self, before_count):
        self.assertEqual(
            SubmissionFile.objects.filter(singer_registration=self.registration).count(),
            before_count,
        )


class RegistrationOpenWindowTests(ParticipantMaterialAuthorityTestCase):
    """REGISTRATION_OPEN: the participant still owns their own submission."""

    phase = Activity.Phase.REGISTRATION_OPEN

    def test_participant_edits_own_metadata(self):
        response = self.client.post(self.url(), {"phone": "13900000000"})
        self.assertEqual(response.status_code, 302)
        self.registration.refresh_from_db()
        self.assertEqual(self.registration.phone, "13900000000")

    def test_participant_uploads_to_own_file_backed_check(self):
        check = self.check(
            status=MaterialCheck.Status.MISSING,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        response = self.post_check(check, _mp3())
        self.assertEqual(response.status_code, 302)
        stored = SubmissionFile.objects.get(
            singer_registration=self.registration,
            file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        self.assertTrue(stored.is_current)
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)

    def test_participant_upload_is_audited(self):
        check = self.check(
            status=MaterialCheck.Status.MISSING,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        self.post_check(check, _mp3())
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.UPLOAD_FILE,
                operator=self.user,
            ).exists()
        )

    def test_crafted_file_purpose_is_ignored(self):
        """The browser cannot choose the purpose; the check snapshot decides it."""
        check = self.check(
            status=MaterialCheck.Status.MISSING,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        self.post_check(check, _mp3(), file_purpose=SubmissionFile.Purpose.PERFORMANCE_VIDEO)
        stored = SubmissionFile.objects.get(singer_registration=self.registration)
        self.assertEqual(stored.file_purpose, SubmissionFile.Purpose.ACCOMPANIMENT)

    def test_upload_without_check_id_is_refused(self):
        before = SubmissionFile.objects.count()
        response = self.client.post(
            self.url(),
            {
                "file": _mp3(),
                "file_purpose": SubmissionFile.Purpose.ACCOMPANIMENT,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(SubmissionFile.objects.count(), before)

    def test_non_file_check_cannot_receive_a_file(self):
        check = self.check(
            item_name="基本信息",
            status=MaterialCheck.Status.UPLOADED,
            purpose="",
        )
        response = self.post_check(check, _mp3())
        self.assertEqual(response.status_code, 200)
        self.assert_no_new_file(0)


class RegistrationClosedWindowTests(ParticipantMaterialAuthorityTestCase):
    """REGISTRATION_CLOSED: metadata is frozen; only a designated check accepts a file."""

    phase = Activity.Phase.REGISTRATION_CLOSED

    def test_participant_metadata_edit_is_refused(self):
        response = self.client.post(self.url(), {"phone": "13900000000"})
        self.assertEqual(response.status_code, 200)
        self.registration.refresh_from_db()
        self.assertEqual(self.registration.phone, "13800000000")

    def test_free_upload_to_missing_check_is_refused(self):
        check = self.check(
            status=MaterialCheck.Status.MISSING,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        response = self.post_check(check, _mp3())
        self.assertEqual(response.status_code, 200)
        self.assert_no_new_file(0)
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.MISSING)

    def test_free_upload_to_uploaded_check_is_refused(self):
        check = self.check(
            status=MaterialCheck.Status.UPLOADED,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        response = self.post_check(check, _mp3())
        self.assertEqual(response.status_code, 200)
        self.assert_no_new_file(0)
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)

    def test_free_upload_to_approved_check_is_refused(self):
        check = self.check(
            status=MaterialCheck.Status.APPROVED,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        response = self.post_check(check, _mp3())
        self.assertEqual(response.status_code, 200)
        self.assert_no_new_file(0)
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.APPROVED)

    def test_designated_supplement_check_accepts_a_file(self):
        check = self.check(
            status=MaterialCheck.Status.NEEDS_SUPPLEMENT,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        response = self.post_check(check, _mp3())
        self.assertEqual(response.status_code, 302)
        stored = SubmissionFile.objects.get(singer_registration=self.registration)
        self.assertEqual(stored.file_purpose, SubmissionFile.Purpose.ACCOMPANIMENT)
        self.assertTrue(stored.is_current)
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)

    def test_designated_supplement_upload_is_audited(self):
        check = self.check(
            status=MaterialCheck.Status.NEEDS_SUPPLEMENT,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        self.post_check(check, _mp3())
        audit = AuditLog.objects.filter(
            action_type=AuditLog.ActionType.UPLOAD_FILE, operator=self.user
        )
        self.assertTrue(audit.exists())
        self.assertIn("song.mp3", audit.first().new_value)  # type: ignore[union-attr]

    def test_supplement_clears_stale_review_metadata(self):
        staff = User.objects.create_user(username="staff", password="pass", role=User.Role.STAFF)
        check = self.check(
            status=MaterialCheck.Status.NEEDS_SUPPLEMENT,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        MaterialCheck.objects.filter(pk=check.pk).update(
            review_note="请上传无主唱版 MP3",
            reviewed_by=staff,
        )
        self.post_check(check, _mp3())
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)
        self.assertEqual(check.review_note, "")
        self.assertIsNone(check.reviewed_by)
        self.assertIsNone(check.reviewed_at)

    def test_supplement_supersedes_the_previous_current_version(self):
        first = self.check(
            status=MaterialCheck.Status.NEEDS_SUPPLEMENT,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        self.post_check(first, _mp3("v1.mp3"))
        old = SubmissionFile.objects.get(singer_registration=self.registration)
        MaterialCheck.objects.filter(pk=first.pk).update(
            status=MaterialCheck.Status.NEEDS_SUPPLEMENT
        )
        self.post_check(first, _mp3("v2.mp3"))
        old.refresh_from_db()
        self.assertFalse(old.is_current)
        current = SubmissionFile.objects.get(singer_registration=self.registration, is_current=True)
        self.assertEqual(current.original_name, "v2.mp3")
        self.assertEqual(current.version, old.version + 1)

    def test_supplement_is_single_use_until_staff_reopens_it(self):
        check = self.check(
            status=MaterialCheck.Status.NEEDS_SUPPLEMENT,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        self.post_check(check, _mp3("v1.mp3"))
        before = SubmissionFile.objects.count()
        response = self.post_check(check, _mp3("v2.mp3"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(SubmissionFile.objects.count(), before)

    def test_supplement_still_validates_file_content(self):
        check = self.check(
            status=MaterialCheck.Status.NEEDS_SUPPLEMENT,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        response = self.post_check(
            check, SimpleUploadedFile("song.mp3", b"not audio", content_type="audio/mpeg")
        )
        self.assertEqual(response.status_code, 200)
        self.assert_no_new_file(0)

    def test_other_users_check_is_refused(self):
        other_registration = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.other,
            name="Other",
            student_id="20260002",
            college="College",
            class_name="Class",
            phone="13800000002",
            song_name="Song",
        )
        check = self.check(
            registration=other_registration,
            status=MaterialCheck.Status.NEEDS_SUPPLEMENT,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        response = self.post_check(check, _mp3())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            SubmissionFile.objects.filter(singer_registration=other_registration).count(), 0
        )

    def test_check_from_another_activity_is_refused(self):
        other_activity = _create_activity(
            title="Other",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_CLOSED,
            is_test_mode=False,
        )
        other_registration = SingerRegistration.objects.create(
            activity=other_activity,
            user=self.user,
            name="Singer",
            student_id="20260003",
            college="College",
            class_name="Class",
            phone="13800000003",
            song_name="Song",
        )
        check = self.check(
            registration=other_registration,
            status=MaterialCheck.Status.NEEDS_SUPPLEMENT,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        response = self.post_check(check, _mp3())
        self.assertEqual(response.status_code, 200)
        self.assert_no_new_file(0)

    def test_forged_and_missing_check_ids_are_refused(self):
        before = SubmissionFile.objects.count()
        for bogus in ("", "999999", "not-an-id"):
            response = self.client.post(self.url(), {"check_id": bogus, "file": _mp3()})
            self.assertEqual(response.status_code, 200)
        self.assertEqual(SubmissionFile.objects.count(), before)

    def test_locked_activity_refuses_supplement(self):
        check = self.check(
            status=MaterialCheck.Status.NEEDS_SUPPLEMENT,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        self.activity.is_locked = True
        with authority_write(ACTIVITY_STATE):
            self.activity.save(update_fields=["is_locked"])
        response = self.post_check(check, _mp3())
        self.assertEqual(response.status_code, 200)
        self.assert_no_new_file(0)

    def test_archived_activity_refuses_supplement(self):
        check = self.check(
            status=MaterialCheck.Status.NEEDS_SUPPLEMENT,
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
        )
        _set_phase(self.activity, Activity.Phase.ARCHIVED)
        response = self.post_check(check, _mp3())
        self.assertEqual(response.status_code, 200)
        self.assert_no_new_file(0)


class ReviewingWindowTests(RegistrationClosedWindowTests):
    """REVIEWING behaves exactly like REGISTRATION_CLOSED for the participant."""

    phase = Activity.Phase.REVIEWING
