from accounts.models import User
from core.models import Activity
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.urls import reverse

from .models import Program


class FarewellUploadViewTests(TestCase):
    def test_invalid_upload_does_not_create_program(self):
        user = User.objects.create_user(username="applicant", password="pass")
        activity = Activity.objects.create(
            title="Farewell",
            activity_type=Activity.Type.FAREWELL_SHOW,
            phase=Activity.Phase.REGISTRATION_OPEN,
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
