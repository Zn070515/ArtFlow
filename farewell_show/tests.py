import threading
import time
from unittest import skipUnless

from accounts.models import User
from core.models import Activity
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import close_old_connections, connection, transaction
from django.test import RequestFactory, TestCase, TransactionTestCase
from django.urls import reverse
from files.models import MaterialCheck

from .models import Program
from .views import my_program_detail


class FarewellUploadViewTests(TestCase):
    def test_invalid_upload_does_not_create_program(self):
        user = User.objects.create_user(username="applicant", password="pass")
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


class ProgramMaterialPurityTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="program-owner", password="pass")
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
        response = self.client.get(
            reverse("farewell_show:my_program_detail", args=[self.prog.pk])
        )
        self.assertEqual(response.status_code, 200)
        after = list(
            self.prog.material_checks.order_by("pk").values_list(
                "item_name", "status", "sort_order", "review_note"
            )
        )
        self.assertEqual(before, after)

    def test_archived_activity_program_get_produces_no_material_check_mutation(self):
        self.activity.phase = Activity.Phase.ARCHIVED
        self.activity.save(update_fields=["phase"])
        self.client.force_login(self.user)
        before = self.prog.material_checks.count()
        response = self.client.get(
            reverse("farewell_show:my_program_detail", args=[self.prog.pk])
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.prog.material_checks.count(), before)


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class ProgramLockOrderConcurrencyTests(TransactionTestCase):
    """O6: a Program edit must never land after the activity lock commits."""

    def setUp(self):
        self.user = User.objects.create_user(username="program-participant", password="pass")
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
