from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from core.models import Activity
from django.test import TestCase
from django.urls import reverse
from singer_contest.group_chorus import (
    confirm_group_stage,
    create_group_stage,
    record_group_stage,
)
from singer_contest.models import GroupStage, SingerRegistration


class GroupStageMaterialWindowViewTests(TestCase):
    """The staff control that opens and closes a group's material window."""

    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="group-staff", password="pass", role=User.Role.STAFF
            )
            self.participant = User.objects.create_user(
                username="group-participant", password="pass", role=User.Role.PARTICIPANT
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="院十佳",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REHEARSAL,
                is_test_mode=True,
            )
        singers = [
            SingerRegistration.objects.create(
                activity=self.activity,
                user=User.objects.create_user(username=f"window-singer-{index}", password="pass"),
                name=f"选手{index}",
                student_id=f"2027{index:04d}",
                college="艺术学院",
                class_name="一班",
                phone=f"1390000000{index}",
                song_name="曲目",
                pre_status=SingerRegistration.PreStatus.APPROVED,
            )
            for index in range(1, 3)
        ]
        stage = create_group_stage(
            self.activity, stage_key="chorus", name="分组合唱", operator=self.staff
        )
        record_group_stage(
            stage,
            [{"name": "A组", "singer_ids": [singer.pk for singer in singers]}],
            self.staff,
        )
        confirm_group_stage(stage, self.staff)
        self.stage = stage

    def _url(self) -> str:
        return reverse("staff:group_stage_material_status", args=[self.stage.pk])

    def test_staff_can_open_the_material_window(self):
        self.client.force_login(self.staff)
        response = self.client.post(self._url(), {"material_status": "open", "note": "赛前开放"})
        self.assertRedirects(response, reverse("staff:group_stage_detail", args=[self.stage.pk]))
        self.stage.refresh_from_db()
        self.assertEqual(self.stage.material_status, GroupStage.MaterialStatus.OPEN)

    def test_participant_cannot_change_the_material_window(self):
        self.client.force_login(self.participant)
        self.client.post(self._url(), {"material_status": "open"})
        self.stage.refresh_from_db()
        self.assertEqual(self.stage.material_status, GroupStage.MaterialStatus.CLOSED)

    def test_material_window_endpoint_rejects_get(self):
        self.client.force_login(self.staff)
        self.assertEqual(self.client.get(self._url()).status_code, 405)
