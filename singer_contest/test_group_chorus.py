from decimal import Decimal
from unittest.mock import patch

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    SCORE_SUMMARY_RECALCULATE,
    authority_write,
)
from common.models import AuditLog
from core.models import Activity
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from files.models import MaterialCheck, SubmissionFile
from files.services import (
    FileSlotStale,
    reconcile_group_material_checks,
    review_material_check,
    submit_participant_material_for_check,
)

from .group_chorus import (
    GroupReadiness,
    cancel_group_stage,
    confirm_group_stage,
    correct_group_stage,
    create_group_stage,
    freeze_group_stage,
    group_material_readiness,
    group_stage_archive_blocker,
    group_stage_readiness,
    record_group_stage,
    set_group_material_status,
)
from .models import (
    ContestRound,
    Group,
    GroupMembership,
    GroupStage,
    Judge,
    RoundEntry,
    RoundJudge,
    ScoreRecord,
    ScoreSummary,
    SingerRegistration,
)


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

        with self.assertRaisesMessage(ValidationError, "必须覆盖该赛段应有的全部选手"):
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
        review_material_check(
            check,
            status=MaterialCheck.Status.APPROVED,
            note="现场材料已核验",
            actor=self.operator,
        )
        check.refresh_from_db()
        self.assertEqual(check.status, MaterialCheck.Status.APPROVED)

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

    def test_shared_group_file_refuses_a_stale_replacement(self):
        """A member working from a stale page must not silently replace the current file.

        The accompaniment is the one artifact the group must produce; without this the
        second uploader overwrites the first without ever seeing it.
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

        def upload(name: str, expected):
            return submit_participant_material_for_check(
                owner=group,
                check_id=check.pk,
                uploaded_file=SimpleUploadedFile(
                    name, b"ID3" + b"chorus", content_type="audio/mpeg"
                ),
                actor=self.singers[0].user,
                expected_current_version=expected,
            )

        first = upload("first.mp3", 0)
        self.assertEqual(first.version, 1)

        # A teammate's page still believes the slot is empty.
        with self.assertRaises(FileSlotStale) as caught:
            upload("stale.mp3", 0)
        self.assertEqual(caught.exception.current_version, 1)
        self.assertEqual(caught.exception.current_name, "first.mp3")
        self.assertEqual(SubmissionFile.objects.filter(group=group, is_current=True).count(), 1)
        self.assertEqual(
            SubmissionFile.objects.get(group=group, is_current=True).original_name, "first.mp3"
        )

        # Choosing to replace against the version it was told about goes through.
        replaced = upload("deliberate.mp3", caught.exception.current_version)
        self.assertEqual(replaced.version, 2)

    def test_a_retired_group_stage_no_longer_has_to_be_frozen(self):
        """The year's format can be settled after someone started recording groups.

        Without a terminal state the abandoned stage could never be retired, and archiving
        requires every stage to be frozen — so a format decision could block the archive.
        """
        from questionnaire.registration import GroupMaterialWriteScope, group_material_write_scope

        stage = create_group_stage(
            self.activity, stage_key="chorus", name="分组合唱", operator=self.operator
        )
        record_group_stage(stage, self._groups(), self.operator)
        confirm_group_stage(stage, self.operator)
        set_group_material_status(stage, GroupStage.MaterialStatus.OPEN, self.operator)
        group = Group.objects.get(stage=stage, name="A组")

        cancelled = cancel_group_stage(stage, self.operator, reason="当届赛制无分组合唱")

        self.assertEqual(cancelled.status, GroupStage.Status.CANCELLED)
        self.assertEqual(cancelled.material_status, GroupStage.MaterialStatus.CLOSED)
        self.assertIs(group_material_write_scope(group), GroupMaterialWriteScope.NONE)
        self.assertTrue(
            AuditLog.objects.filter(
                target=f"GroupStage:{stage.pk}",
                action_type=AuditLog.ActionType.CANCEL_GROUP_STAGE,
                note="当届赛制无分组合唱",
            ).exists()
        )
        # Idempotent, and the history is still there.
        self.assertEqual(
            cancel_group_stage(stage, self.operator, reason="再点一次").status,
            GroupStage.Status.CANCELLED,
        )
        self.assertTrue(GroupMembership.objects.filter(group=group).exists())

    def test_only_an_unfinished_stage_blocks_the_archive(self):
        stage = create_group_stage(
            self.activity, stage_key="chorus", name="分组合唱", operator=self.operator
        )
        self.assertIn("尚未冻结", group_stage_archive_blocker(stage))

        stage = record_group_stage(stage, self._groups(), self.operator)
        stage = confirm_group_stage(stage, self.operator)
        self.assertIn("尚未冻结", group_stage_archive_blocker(stage))

        stage = freeze_group_stage(stage, self.operator)
        self.assertEqual(group_stage_archive_blocker(stage), "")

    def test_a_cancelled_stage_stops_blocking_the_archive(self):
        stage = create_group_stage(
            self.activity, stage_key="chorus", name="分组合唱", operator=self.operator
        )
        stage = cancel_group_stage(stage, self.operator, reason="当届赛制无分组合唱")

        self.assertEqual(group_stage_archive_blocker(stage), "")

    def test_cancelling_requires_a_reason_and_spares_consumed_stages(self):
        draft = create_group_stage(
            self.activity, stage_key="draft", name="草稿组", operator=self.operator
        )
        with self.assertRaisesMessage(ValidationError, "必须说明取消"):
            cancel_group_stage(draft, self.operator, reason="   ")

        stage = create_group_stage(
            self.activity, stage_key="chorus", name="分组合唱", operator=self.operator
        )
        record_group_stage(stage, self._groups(), self.operator)
        confirm_group_stage(stage, self.operator)
        freeze_group_stage(stage, self.operator)
        with self.assertRaisesMessage(ValidationError, "已冻结的分组合唱赛段不能被取消"):
            cancel_group_stage(stage, self.operator, reason="反悔")

    def test_a_stage_can_source_its_roster_from_one_rounds_advancers(self):
        """GOAL §6: the year's format decides who sings in the chorus.

        Hard-coding "every approved registration" made the "only the survivors of an
        earlier round" case inexpressible, so the source is declared on the stage and
        resolved on the server from there.
        """
        contest_round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            name="第一轮",
        )
        judge = Judge.objects.create(activity=self.activity, name="评委")
        for singer in self.singers:
            RoundEntry.objects.create(round=contest_round, singer=singer, running_order=singer.pk)
        RoundJudge.objects.create(round=contest_round, judge=judge)
        for singer in self.singers:
            ScoreRecord.objects.create(
                round=contest_round,
                singer=singer,
                judge=judge,
                score=90,
                is_test_data=True,
            )
        for index, singer in enumerate(self.singers):
            with authority_write(SCORE_SUMMARY_RECALCULATE):
                ScoreSummary.objects.create(
                    round=contest_round,
                    singer=singer,
                    average_score=Decimal("90"),
                    rank=index + 1,
                    is_advanced=index < 2,
                    is_test_data=True,
                )
        contest_round.status = ContestRound.Status.LOCKED
        contest_round.is_locked = True
        with authority_write(CONTEST_ROUND_STATE):
            contest_round.save(update_fields=["status", "is_locked"])
        stage = create_group_stage(
            self.activity,
            stage_key="chorus",
            name="分组合唱",
            operator=self.operator,
            roster_source=GroupStage.RosterSource.ROUND_ADVANCED,
            roster_source_round=contest_round,
        )
        advanced = [singer.pk for singer in self.singers[:2]]

        # A group may only contain advanced singers: a non-advancer is not in the roster
        # at all, so the partition can never be completed with one.
        with self.assertRaisesMessage(ValidationError, "必须是当前活动已审核通过的选手"):
            record_group_stage(
                stage,
                [{"name": "A组", "singer_ids": advanced + [self.singers[2].pk]}],
                self.operator,
            )
        record_group_stage(stage, [{"name": "A组", "singer_ids": advanced}], self.operator)
        confirm_group_stage(stage, self.operator)
        stage.refresh_from_db()
        self.assertTrue(stage.source_roster_fingerprint)
        self.assertEqual(
            GroupMembership.objects.filter(group__stage=stage, is_current=True).count(), 2
        )

    def test_a_round_sourced_stage_must_name_its_round(self):
        with self.assertRaisesMessage(ValidationError, "必须指定来源轮次"):
            create_group_stage(
                self.activity,
                stage_key="chorus",
                name="分组合唱",
                operator=self.operator,
                roster_source=GroupStage.RosterSource.ROUND_ADVANCED,
            )

    def test_a_round_sourced_stage_requires_a_final_source_round(self):
        contest_round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            name="尚未完成的第一轮",
        )
        stage = create_group_stage(
            self.activity,
            stage_key="chorus",
            name="分组合唱",
            operator=self.operator,
            roster_source=GroupStage.RosterSource.ROUND_ADVANCED,
            roster_source_round=contest_round,
        )

        with self.assertRaisesMessage(ValidationError, "尚未锁定"):
            confirm_group_stage(stage, self.operator)

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
