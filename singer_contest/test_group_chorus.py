from unittest.mock import patch

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from common.models import AuditLog
from core.models import Activity
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from files.models import MaterialCheck, SubmissionFile
from files.services import (
    reconcile_group_material_checks,
    review_material_check,
    submit_participant_material_for_check,
)

from .group_chorus import (
    GroupReadiness,
    confirm_group_stage,
    correct_group_stage,
    create_group_stage,
    freeze_group_stage,
    group_material_readiness,
    group_stage_readiness,
    record_group_stage,
    set_group_material_status,
)
from .models import Group, GroupMembership, GroupStage, SingerRegistration


class GroupChorusStageServiceTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.operator = User.objects.create_user(
                username="group-operator", password="pass", role=User.Role.ADMIN
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="院十佳",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_OPEN,
                is_test_mode=True,
            )
        self.singers = [
            SingerRegistration.objects.create(
                activity=self.activity,
                user=self._user(f"singer-{index}"),
                name=f"选手{index}",
                student_id=f"2026{index:04d}",
                college="艺术学院",
                class_name="一班",
                phone=f"1380000000{index}",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            )
            for index in range(1, 5)
        ]

    def _user(self, username):
        with authority_write(ACCOUNT_AUTHORITY):
            return User.objects.create_user(username=username, password="pass")

    def _groups(self):
        return [
            {"name": "A组", "singer_ids": [self.singers[0].pk, self.singers[1].pk]},
            {"name": "B组", "singer_ids": [self.singers[2].pk, self.singers[3].pk]},
        ]

    def test_external_groups_can_be_confirmed_and_frozen(self):
        stage = create_group_stage(
            self.activity,
            stage_key="chorus",
            name="分组合唱",
            operator=self.operator,
        )
        record_group_stage(stage, self._groups(), self.operator)

        confirmed = confirm_group_stage(stage, self.operator)
        self.assertEqual(confirmed.status, GroupStage.Status.CONFIRMED)
        self.assertEqual(Group.objects.filter(stage=stage).count(), 2)
        self.assertEqual(
            GroupMembership.objects.filter(group__stage=stage, is_current=True).count(), 4
        )

        frozen = freeze_group_stage(stage, self.operator)
        self.assertEqual(frozen.status, GroupStage.Status.FROZEN)
        self.assertTrue(
            AuditLog.objects.filter(
                target=f"GroupStage:{stage.pk}",
                action_type=AuditLog.ActionType.CONFIRM_GROUP_STAGE,
            ).exists()
        )

    def test_confirmation_requires_a_complete_approved_roster_partition(self):
        stage = create_group_stage(
            self.activity,
            stage_key="chorus",
            name="分组合唱",
            operator=self.operator,
        )
        record_group_stage(
            stage,
            [{"name": "A组", "singer_ids": [self.singers[0].pk, self.singers[1].pk]}],
            self.operator,
        )

        with self.assertRaisesMessage(ValidationError, "必须覆盖当前全部审核通过的选手"):
            confirm_group_stage(stage, self.operator)

    def test_group_order_supplies_default_display_names(self):
        stage = create_group_stage(
            self.activity,
            stage_key="chorus",
            name="分组合唱",
            operator=self.operator,
        )
        record_group_stage(
            stage,
            [
                {"singer_ids": [self.singers[0].pk, self.singers[1].pk]},
                {"singer_ids": [self.singers[2].pk, self.singers[3].pk]},
            ],
            self.operator,
        )
        confirm_group_stage(stage, self.operator)
        self.assertEqual(
            list(Group.objects.filter(stage=stage).values_list("name", flat=True)),
            ["第 1 组", "第 2 组"],
        )

    def test_correction_preserves_membership_history_and_requires_reason(self):
        stage = create_group_stage(
            self.activity,
            stage_key="chorus",
            name="分组合唱",
            operator=self.operator,
        )
        record_group_stage(stage, self._groups(), self.operator)
        confirm_group_stage(stage, self.operator)
        freeze_group_stage(stage, self.operator)

        corrected = [
            {"name": "A组", "singer_ids": [self.singers[0].pk, self.singers[2].pk]},
            {"name": "B组", "singer_ids": [self.singers[1].pk, self.singers[3].pk]},
        ]
        with self.assertRaisesMessage(ValidationError, "必须说明成员修正原因"):
            correct_group_stage(stage, corrected, self.operator, reason="")

        corrected_stage = correct_group_stage(
            stage, corrected, self.operator, reason="外部分组表更正"
        )
        self.assertEqual(corrected_stage.status, GroupStage.Status.FROZEN)
        self.assertEqual(
            GroupMembership.objects.filter(group__stage=stage, is_current=True).count(), 4
        )
        self.assertEqual(
            GroupMembership.objects.filter(group__stage=stage, is_current=False).count(), 4
        )
        self.assertTrue(
            AuditLog.objects.filter(
                target=f"GroupStage:{stage.pk}",
                action_type=AuditLog.ActionType.CORRECT_GROUP_STAGE,
                note="外部分组表更正",
            ).exists()
        )

    def test_group_chorus_rows_cannot_be_written_through_raw_orm(self):
        with self.assertRaisesMessage(ValidationError, "必须通过正式服务修改"):
            GroupStage.objects.create(
                activity=self.activity,
                stage_key="raw",
                name="越权分组",
            )

    def test_group_material_is_shared_but_upload_requires_current_membership(self):
        stage = create_group_stage(
            self.activity,
            stage_key="chorus",
            name="分组合唱",
            operator=self.operator,
        )
        record_group_stage(stage, self._groups(), self.operator)
        confirm_group_stage(stage, self.operator)
        set_group_material_status(stage, GroupStage.MaterialStatus.OPEN, self.operator)
        group = Group.objects.get(stage=stage, name="A组")
        reconcile_group_material_checks(group)
        check = MaterialCheck.objects.get(
            group=group, file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT
        )

        upload = SimpleUploadedFile("a.mp3", b"ID3" + b"chorus", content_type="audio/mpeg")
        stored = submit_participant_material_for_check(
            owner=group,
            check_id=check.pk,
            uploaded_file=upload,
            actor=self.singers[0].user,
        )
        self.assertEqual(stored.group_id, group.pk)
        self.assertEqual(SubmissionFile.objects.filter(group=group, is_current=True).count(), 1)
        self.assertEqual(group_material_readiness(group), GroupReadiness.MISSING_MATERIAL)
        review_material_check(
            check, status=MaterialCheck.Status.APPROVED, note="音频清晰", actor=self.operator
        )
        self.assertEqual(group_material_readiness(group), GroupReadiness.READY)
        self.assertFalse(group_stage_readiness(stage)["ready"])

        with self.assertRaises(ValidationError):
            submit_participant_material_for_check(
                owner=group,
                check_id=check.pk,
                uploaded_file=SimpleUploadedFile(
                    "b.mp3", b"ID3" + b"chorus", content_type="audio/mpeg"
                ),
                actor=self.singers[2].user,
            )

    def test_group_material_window_decides_independently_of_the_activity_phase(self):
        """The group's own window decides, not the registration phase.

        Grouping happens after registration closed — the roster comes from an external draw
        taken while the contest is already running — so a group's first submission must be
        possible in a phase whose action set contains no ``UPLOAD_MATERIAL`` at all.
        """
        stage = create_group_stage(
            self.activity, stage_key="chorus", name="分组合唱", operator=self.operator
        )
        record_group_stage(stage, self._groups(), self.operator)
        confirm_group_stage(stage, self.operator)
        group = Group.objects.get(stage=stage, name="A组")
        reconcile_group_material_checks(group)
        check = MaterialCheck.objects.get(
            group=group, file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT
        )
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=self.activity.pk).update(phase=Activity.Phase.LIVE)

        def upload(name: str):
            return submit_participant_material_for_check(
                owner=group,
                check_id=check.pk,
                uploaded_file=SimpleUploadedFile(
                    name, b"ID3" + b"chorus", content_type="audio/mpeg"
                ),
                actor=self.singers[0].user,
            )

        # Closed by default. The activity is past registration, and no phase can reopen it.
        with self.assertRaisesMessage(ValidationError, "不接受材料提交"):
            upload("closed.mp3")

        set_group_material_status(stage, GroupStage.MaterialStatus.OPEN, self.operator)
        self.assertEqual(upload("open.mp3").group_id, group.pk)

        set_group_material_status(stage, GroupStage.MaterialStatus.CLOSED, self.operator)
        with self.assertRaisesMessage(ValidationError, "不接受材料提交"):
            upload("closed-again.mp3")

    def test_group_material_window_is_audited_and_rejects_unknown_states(self):
        draft = create_group_stage(
            self.activity, stage_key="draft", name="草稿组", operator=self.operator
        )
        with self.assertRaisesMessage(ValidationError, "只有已确认"):
            set_group_material_status(draft, GroupStage.MaterialStatus.OPEN, self.operator)

        stage = create_group_stage(
            self.activity, stage_key="chorus", name="分组合唱", operator=self.operator
        )
        record_group_stage(stage, self._groups(), self.operator)
        confirm_group_stage(stage, self.operator)
        set_group_material_status(stage, GroupStage.MaterialStatus.OPEN, self.operator)
        # Re-setting the same window is a no-op, so the audit trail records decisions
        # rather than button presses.
        set_group_material_status(stage, GroupStage.MaterialStatus.OPEN, self.operator)
        audits = AuditLog.objects.filter(
            target=f"GroupStage:{stage.pk}",
            action_type=AuditLog.ActionType.SET_GROUP_MATERIAL_STATUS,
        )
        self.assertEqual(audits.count(), 1)
        self.assertEqual(audits.get().new_value, GroupStage.MaterialStatus.OPEN)

        with self.assertRaisesMessage(ValidationError, "未知的分组合唱材料窗口状态"):
            set_group_material_status(stage, "bogus", self.operator)

    def test_member_upload_notifies_the_group_room(self):
        """A member's upload must reach the other members' pages.

        The owner here *is* the Group, which has no ``group_id`` of its own, so probing for
        that attribute silently dropped the event while staff reviews (which go through the
        check's ``group_id``) still worked.
        """
        stage = create_group_stage(
            self.activity, stage_key="chorus", name="分组合唱", operator=self.operator
        )
        record_group_stage(stage, self._groups(), self.operator)
        confirm_group_stage(stage, self.operator)
        set_group_material_status(stage, GroupStage.MaterialStatus.OPEN, self.operator)
        group = Group.objects.get(stage=stage, name="A组")
        reconcile_group_material_checks(group)
        check = MaterialCheck.objects.get(
            group=group, file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT
        )
        with patch("realtime.events.schedule_group_material_event") as notify:
            submit_participant_material_for_check(
                owner=group,
                check_id=check.pk,
                uploaded_file=SimpleUploadedFile(
                    "a.mp3", b"ID3" + b"chorus", content_type="audio/mpeg"
                ),
                actor=self.singers[0].user,
            )
        notify.assert_called_once()
        self.assertEqual(notify.call_args.args[0], group.pk)

    def test_background_video_does_not_satisfy_the_accompaniment_contract(self):
        stage = create_group_stage(
            self.activity,
            stage_key="chorus",
            name="分组合唱",
            operator=self.operator,
        )
        record_group_stage(stage, self._groups(), self.operator)
        confirm_group_stage(stage, self.operator)
        group = Group.objects.get(stage=stage, name="A组")
        SubmissionFile.objects.create(
            group=group,
            file_purpose=SubmissionFile.Purpose.BACKGROUND_VIDEO,
            file=SimpleUploadedFile("background.mp4", b"video"),
            original_name="background.mp4",
            file_size=5,
            is_current=True,
            is_test_data=True,
        )
        self.assertEqual(group_material_readiness(group), GroupReadiness.MISSING_MATERIAL)
