import shutil
import tempfile
import threading
import time
from unittest import skipUnless

from accounts.models import User
from common.authority import ACTIVITY_STATE, authority_write
from common.models import AuditLog
from core.models import Activity
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import close_old_connections, connection, transaction
from django.test import RequestFactory, TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from files.models import MaterialCheck, SubmissionFile

from .models import Program
from .views import my_program_detail


class FarewellUploadViewTests(TestCase):
    def test_invalid_upload_does_not_create_program(self):
        user = User.objects.create_user(username="applicant", password="pass")
        with authority_write(ACTIVITY_STATE):
            activity = Activity.objects.create(
                title="Farewell",
                activity_type=Activity.Type.FAREWELL_SHOW,
                phase=Activity.Phase.REGISTRATION_OPEN,
                is_test_mode=False,
            )
        self.client.force_login(user)

        response = self.client.post(
            reverse("farewell_show:apply"),
            {
                "activity_id": activity.pk,
                "name": "Dance",
                "program_type": Program.ProgramType.DANCE,
                "contact_name": "Li Hua",
                "contact_phone": "13800000000",
                "class_name": "CS1",
                "accompaniment": SimpleUploadedFile("dance.exe", b"bad"),
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(Program.objects.exists())

    def test_apply_page_shows_privacy_notice_before_collection(self):
        user = User.objects.create_user(username="program-applicant", password="pass")
        with authority_write(ACTIVITY_STATE):
            Activity.objects.create(
                title="Farewell",
                activity_type=Activity.Type.FAREWELL_SHOW,
                phase=Activity.Phase.REGISTRATION_OPEN,
                is_test_mode=False,
            )
        self.client.force_login(user)

        response = self.client.get(reverse("farewell_show:apply"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "隐私与数据保留说明")
        self.assertContains(response, reverse("public_portal:privacy"))


class ProgramMaterialPurityTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="program-owner", password="pass")
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Farewell",
                activity_type=Activity.Type.FAREWELL_SHOW,
                phase=Activity.Phase.REGISTRATION_OPEN,
                is_test_mode=False,
            )
        self.prog = Program.objects.create(
            activity=self.activity,
            user=self.user,
            name="Dance",
            program_type=Program.ProgramType.DANCE,
            contact_name="Li Hua",
            contact_phone="13800000000",
            class_name="CS1",
            status=Program.Status.SUBMITTED,
        )

    def test_my_program_detail_get_does_not_mutate_material_checks(self):
        MaterialCheck.objects.create(
            program=self.prog,
            item_name="基本信息",
            status=MaterialCheck.Status.UPLOADED,
            sort_order=0,
        )
        self.client.force_login(self.user)
        before = list(
            self.prog.material_checks.order_by("pk").values_list(
                "item_name", "status", "sort_order", "review_note"
            )
        )
        response = self.client.get(reverse("farewell_show:my_program_detail", args=[self.prog.pk]))
        self.assertEqual(response.status_code, 200)
        after = list(
            self.prog.material_checks.order_by("pk").values_list(
                "item_name", "status", "sort_order", "review_note"
            )
        )
        self.assertEqual(before, after)

    def test_archived_activity_program_get_produces_no_material_check_mutation(self):
        self.activity.phase = Activity.Phase.ARCHIVED
        with authority_write(ACTIVITY_STATE):
            self.activity.save(update_fields=["phase"])
        self.client.force_login(self.user)
        before = self.prog.material_checks.count()
        response = self.client.get(reverse("farewell_show:my_program_detail", args=[self.prog.pk]))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.prog.material_checks.count(), before)

    def test_program_contact_update_audit_redacts_old_and_new_values(self):
        self.client.force_login(self.user)

        response = self.client.post(
            reverse("farewell_show:my_program_detail", args=[self.prog.pk]),
            {"contact_phone": "13900000000"},
        )

        self.assertEqual(response.status_code, 302)
        audit = AuditLog.objects.get(
            action_type=AuditLog.ActionType.UPDATE_REGISTRATION,
            target=f"Program:{self.prog.pk}",
        )
        self.assertNotIn("13800000000", audit.old_value)
        self.assertNotIn("13900000000", audit.new_value)
        self.assertIn("contact_phone", audit.old_value)


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class ProgramLockOrderConcurrencyTests(TransactionTestCase):
    """O6: a Program edit must never land after the activity lock commits."""

    def setUp(self):
        self.user = User.objects.create_user(username="program-participant", password="pass")
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Farewell Boundary",
                activity_type=Activity.Type.FAREWELL_SHOW,
                phase=Activity.Phase.REGISTRATION_OPEN,
                is_test_mode=False,
            )
        self.prog = Program.objects.create(
            activity=self.activity,
            user=self.user,
            name="Dance",
            program_type=Program.ProgramType.DANCE,
            contact_name="Li Hua",
            contact_phone="13800000000",
            class_name="CS1",
            status=Program.Status.SUBMITTED,
        )

    def test_program_edit_never_lands_after_activity_lock(self):
        lock_held = threading.Event()
        release_lock = threading.Event()
        holder_error: dict[str, object] = {}

        def hold_activity_lock():
            try:
                with transaction.atomic():
                    activity = Activity.objects.select_for_update().get(pk=self.activity.pk)
                    activity.is_locked = True
                    with authority_write(ACTIVITY_STATE):
                        activity.save(update_fields=["is_locked"])
                    lock_held.set()
                    release_lock.wait(timeout=10)
            except Exception as error:  # pragma: no cover - diagnostic only
                holder_error["error"] = error
            finally:
                close_old_connections()

        holder = threading.Thread(target=hold_activity_lock)
        holder.start()
        self.assertTrue(lock_held.wait(timeout=10))

        edit_result: dict[str, object] = {}

        def try_program_edit():
            close_old_connections()
            try:
                request = RequestFactory().post("/x", {"contact_phone": "13800000002"})
                request.user = self.user
                my_program_detail(request, self.prog.pk)
                edit_result["done"] = True
            except Exception as error:  # pragma: no cover - diagnostic only
                edit_result["error"] = repr(error)
            finally:
                close_old_connections()

        editor = threading.Thread(target=try_program_edit)
        editor.start()
        time.sleep(1)  # let the editor block on the Activity row lock
        release_lock.set()
        holder.join(timeout=10)
        editor.join(timeout=10)

        self.assertFalse(holder_error, holder_error)
        self.activity.refresh_from_db()
        self.prog.refresh_from_db()
        self.assertTrue(self.activity.is_locked)
        self.assertEqual(self.prog.contact_phone, "13800000000")
        self.assertEqual(edit_result.get("done"), True, edit_result)


class ProgramMaterialAuthorityTests(TestCase):
    """§2.3 / §4 — the program surface follows the same participant material authority."""

    phase = Activity.Phase.REGISTRATION_OPEN

    def setUp(self):
        self.media_root = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.addCleanup(shutil.rmtree, self.media_root, True)
        self.user = User.objects.create_user(username="program-material", password="pass")
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Farewell Material",
                activity_type=Activity.Type.FAREWELL_SHOW,
                phase=self.phase,
                is_test_mode=False,
            )
        self.prog = Program.objects.create(
            activity=self.activity,
            user=self.user,
            name="Dance",
            program_type=Program.ProgramType.DANCE,
            contact_name="Li Hua",
            contact_phone="13800000000",
            class_name="CS1",
            status=Program.Status.SUBMITTED,
        )
        self.client.force_login(self.user)

    def _check(self, *, status, purpose=SubmissionFile.Purpose.ACCOMPANIMENT):
        return MaterialCheck.objects.create(
            program=self.prog,
            item_name="伴奏文件",
            status=status,
            file_purpose=purpose,
            sort_order=0,
        )

    def _url(self):
        return reverse("farewell_show:my_program_detail", args=[self.prog.pk])

    def _upload(self, name="song.mp3"):
        return SimpleUploadedFile(
            name, b"ID3\x04\x00\x00\x00\x00\x00\x00", content_type="audio/mpeg"
        )

    def test_participant_uploads_to_own_open_check(self):
        check = self._check(status=MaterialCheck.Status.MISSING)
        response = self.client.post(self._url(), {"check_id": check.pk, "file": self._upload()})
        self.assertEqual(response.status_code, 302)
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)
        stored = SubmissionFile.objects.get(program=self.prog)
        self.assertEqual(stored.file_purpose, SubmissionFile.Purpose.ACCOMPANIMENT)

    def test_crafted_file_purpose_is_ignored(self):
        check = self._check(status=MaterialCheck.Status.MISSING)
        self.client.post(
            self._url(),
            {
                "check_id": check.pk,
                "file": self._upload(),
                "file_purpose": SubmissionFile.Purpose.LYRICS_SCRIPT,
            },
        )
        stored = SubmissionFile.objects.get(program=self.prog)
        self.assertEqual(stored.file_purpose, SubmissionFile.Purpose.ACCOMPANIMENT)

    def test_metadata_edit_is_refused_after_registration_closes(self):
        self.activity.phase = Activity.Phase.REGISTRATION_CLOSED
        with authority_write(ACTIVITY_STATE):
            self.activity.save(update_fields=["phase"])
        response = self.client.post(self._url(), {"contact_phone": "13900000000"})
        self.assertEqual(response.status_code, 200)
        self.prog.refresh_from_db()
        self.assertEqual(self.prog.contact_phone, "13800000000")

    def test_free_upload_is_refused_after_registration_closes(self):
        self.activity.phase = Activity.Phase.REGISTRATION_CLOSED
        with authority_write(ACTIVITY_STATE):
            self.activity.save(update_fields=["phase"])
        check = self._check(status=MaterialCheck.Status.MISSING)
        response = self.client.post(self._url(), {"check_id": check.pk, "file": self._upload()})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(SubmissionFile.objects.filter(program=self.prog).exists())
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.MISSING)

    def test_designated_supplement_is_accepted_after_registration_closes(self):
        self.activity.phase = Activity.Phase.REVIEWING
        with authority_write(ACTIVITY_STATE):
            self.activity.save(update_fields=["phase"])
        check = self._check(status=MaterialCheck.Status.NEEDS_SUPPLEMENT)
        response = self.client.post(self._url(), {"check_id": check.pk, "file": self._upload()})
        self.assertEqual(response.status_code, 302)
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)
