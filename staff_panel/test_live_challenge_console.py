from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from core.models import Activity
from django.test import TestCase
from django.urls import reverse


class LiveChallengeConsoleTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="console-staff", password="pass", role=User.Role.STAFF
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="现场挑战活动",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        self.client.force_login(self.staff)

    def test_staff_can_open_business_language_console_without_session(self):
        response = self.client.get(reverse("staff:live_challenge_console", args=[self.activity.pk]))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "现场挑战")
        self.assertContains(response, "当前还没有建立挑战流程")

    def test_staff_can_open_material_progress_page(self):
        response = self.client.get(reverse("staff:live_material_progress", args=[self.activity.pk]))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "第一轮小组材料")
        self.assertContains(response, "第二轮个人材料")
