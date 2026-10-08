"""The group chorus questionnaire's HTTP surface.

A group shares one response between its members, so this is the one questionnaire page
where the write rules are not "the phase decides": the stage carries its own material
window, the answers are compare-and-set, and the shared file slot refuses a stale
replacement. Those rules live in the service layer, but the page contract — which status
code, which code, which payload — is only visible here.
"""

import json
from unittest.mock import patch
from uuid import uuid4

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from common.test_characterization import _CharacterizationBase
from core.models import Activity
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import freeze_ruleset_version
from singer_contest.group_chorus import (
    confirm_group_stage,
    create_group_stage,
    record_group_stage,
    set_group_material_status,
)
from singer_contest.models import Group, GroupStage, SingerRegistration

GROUP_QUESTIONNAIRE = {
    "schema_version": 1,
    "key": "group_chorus",
    "subject": "group",
    "pages": [
        {
            "key": "material",
            "title": "分组合唱材料",
            "sections": [
                {
                    "key": "chorus",
                    "title": "合唱",
                    "questions": [
                        {"key": "stage_note", "type": "text", "label": "舞台说明"},
                        {
                            "key": "chorus_audio",
                            "type": "file",
                            "label": "合唱伴奏",
                            "file": {
                                "purpose": "accompaniment",
                                "max_mb": 20,
                                "extensions": [".mp3"],
                            },
                        },
                    ],
                }
            ],
        }
    ],
}


def _definition() -> str:
    return json.dumps(
        {
            "schema_version": 1,
            "nodes": [{"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"}],
        },
        ensure_ascii=False,
    )


class _GroupMaterialBase(_CharacterizationBase):
    def setUp(self):
        super().setUp()
        from django.core.cache import cache

        cache.clear()
        self.operator = self.make_user(f"group-http-admin-{uuid4().hex[:8]}")
        self.operator.role = User.Role.ADMIN
        with authority_write(ACCOUNT_AUTHORITY):
            self.operator.save()

    def frozen_group_version(self, questionnaire=None):
        # FORMAL: a non-staff member may only reach a formal activity's group page (§14.2).
        activity = self.make_activity(
            is_test_mode=False,
            phase=Activity.Phase.REGISTRATION_OPEN,
            title=f"分组问卷-{uuid4().hex[:6]}",
        )
        ruleset = ContestRuleset.objects.create(activity=activity, name="RS", is_test_data=False)
        root = json.loads(_definition())
        root["questionnaire"] = questionnaire or GROUP_QUESTIONNAIRE
        version = RulesetVersion.objects.create(
            ruleset=ruleset, definition=json.dumps(root, ensure_ascii=False)
        )
        freeze_ruleset_version(version, self.operator)
        version.refresh_from_db()
        return version

    def confirmed_group(self, version, *, members=2):
        activity = version.ruleset.activity
        singers = [
            self.make_singer(
                activity,
                username=f"group-http-singer-{uuid4().hex[:8]}",
                student_id=f"71{index:04d}",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=False,
            )
            for index in range(members)
        ]
        stage = create_group_stage(
            activity, stage_key="chorus", name="分组合唱", operator=self.operator
        )
        record_group_stage(
            stage, [{"name": "A组", "singer_ids": [s.pk for s in singers]}], self.operator
        )
        confirm_group_stage(stage, self.operator)
        group = Group.objects.get(stage=stage, name="A组")
        return stage, group, singers

    def login_member(self, singer):
        self.client.force_login(singer.user)

    def autosave(self, group, payload):
        return self.client.post(
            reverse("questionnaire:group_autosave", args=[group.pk]),
            data=json.dumps(payload),
            content_type="application/json",
        )

    def schema_hash(self, version):
        from .registration import questionnaire_plan

        return questionnaire_plan(version).schema_hash


class GroupMaterialWindowHttpTests(_GroupMaterialBase):
    def test_a_closed_window_rejects_an_autosave(self):
        version = self.frozen_group_version()
        stage, group, singers = self.confirmed_group(version)
        self.login_member(singers[0])
        response = self.autosave(
            group,
            {"answers": {"stage_note": "x"}, "schema_hash": self.schema_hash(version)},
        )
        self.assertEqual(response.status_code, 409)

    def test_an_open_window_accepts_an_autosave_in_a_phase_past_registration(self):
        """Grouping happens after registration closed, so the phase cannot gate this."""
        version = self.frozen_group_version()
        stage, group, singers = self.confirmed_group(version)
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=version.ruleset.activity_id).update(
                phase=Activity.Phase.LIVE
            )
        set_group_material_status(stage, GroupStage.MaterialStatus.OPEN, self.operator)
        self.login_member(singers[0])
        response = self.autosave(
            group,
            {"answers": {"stage_note": "开场合唱"}, "schema_hash": self.schema_hash(version)},
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn("answer_bases", response.json())


class GroupQuestionnaireCompareAndSetHttpTests(_GroupMaterialBase):
    def _open_group(self):
        version = self.frozen_group_version()
        stage, group, singers = self.confirmed_group(version)
        set_group_material_status(stage, GroupStage.MaterialStatus.OPEN, self.operator)
        return version, group, singers

    def test_a_change_built_on_the_current_base_is_applied(self):
        version, group, singers = self._open_group()
        self.login_member(singers[0])
        schema = self.schema_hash(version)
        first = self.autosave(group, {"answers": {"stage_note": "初稿"}, "schema_hash": schema})
        self.assertEqual(first.status_code, 200, first.content)
        base = first.json()["answer_bases"].get("stage_note", "")
        second = self.autosave(
            group,
            {
                "changes": [{"key": "stage_note", "base": base, "value": "定稿"}],
                "schema_hash": schema,
            },
        )
        self.assertEqual(second.status_code, 200, second.content)

    def test_a_change_built_on_a_moved_base_is_refused_with_the_server_value(self):
        version, group, singers = self._open_group()
        schema = self.schema_hash(version)

        # Both members open the same page and see the same empty answer.
        self.login_member(singers[0])
        shared_base = self.autosave(
            group, {"answers": {"stage_note": ""}, "schema_hash": schema}
        ).json()["answer_bases"]["stage_note"]

        # One of them commits first.
        self.login_member(singers[0])
        first = self.autosave(
            group,
            {
                "changes": [{"key": "stage_note", "base": shared_base, "value": "队友版本"}],
                "schema_hash": schema,
            },
        )
        self.assertEqual(first.status_code, 200, first.content)

        # The other still holds the base from before that save.
        self.login_member(singers[1])
        conflict = self.autosave(
            group,
            {
                "changes": [{"key": "stage_note", "base": shared_base, "value": "我的版本"}],
                "schema_hash": schema,
            },
        )
        self.assertEqual(conflict.status_code, 409)
        body = conflict.json()
        self.assertEqual(body["code"], "QUESTION_STALE")
        self.assertEqual(body["conflicts"][0]["server"], "队友版本")
        self.assertEqual(body["conflicts"][0]["local"], "我的版本")
        self.assertTrue(body["conflicts"][0]["base"])
        self.assertNotEqual(body["conflicts"][0]["base"], shared_base)

    def test_a_successful_save_tells_the_other_members_pages(self):
        version, group, singers = self._open_group()
        self.login_member(singers[0])
        with patch("realtime.events.schedule_group_material_event") as notify:
            response = self.autosave(
                group,
                {"answers": {"stage_note": "广播"}, "schema_hash": self.schema_hash(version)},
            )
        self.assertEqual(response.status_code, 200, response.content)
        notify.assert_called_once()
        self.assertEqual(notify.call_args.args[0], group.pk)
        self.assertEqual(notify.call_args.kwargs["event"], "group.questionnaire_changed")


class GroupMaterialFileSlotHttpTests(_GroupMaterialBase):
    def test_an_upload_built_on_a_stale_slot_is_refused(self):
        version = self.frozen_group_version()
        stage, group, singers = self.confirmed_group(version)
        set_group_material_status(stage, GroupStage.MaterialStatus.OPEN, self.operator)
        url = reverse("questionnaire:group_upload", args=[group.pk, "chorus_audio"])
        schema = self.schema_hash(version)

        self.login_member(singers[0])
        first = self.client.post(
            url,
            {
                "file": SimpleUploadedFile(
                    "first.mp3", b"ID3" + b"chorus", content_type="audio/mpeg"
                ),
                "schema_hash": schema,
                "expected_current_version": "0",
            },
        )
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(first.json()["version"], 1)

        self.login_member(singers[1])
        conflict = self.client.post(
            url,
            {
                "file": SimpleUploadedFile(
                    "stale.mp3", b"ID3" + b"chorus", content_type="audio/mpeg"
                ),
                "schema_hash": schema,
                "expected_current_version": "0",
            },
        )
        self.assertEqual(conflict.status_code, 409)
        body = conflict.json()
        self.assertEqual(body["code"], "FILE_SLOT_STALE")
        self.assertEqual(body["current_version"], 1)
        self.assertEqual(body["current_name"], "first.mp3")

        deliberate = self.client.post(
            url,
            {
                "file": SimpleUploadedFile(
                    "mine.mp3", b"ID3" + b"chorus", content_type="audio/mpeg"
                ),
                "schema_hash": schema,
                "expected_current_version": str(body["current_version"]),
            },
        )
        self.assertEqual(deliberate.status_code, 200, deliberate.content)
        self.assertEqual(deliberate.json()["version"], 2)


class GroupSubmitCompareAndSetHttpTests(_GroupMaterialBase):
    """A submission is the whole form, so it has to carry the same bases as the autosave.

    The autosave path has always refused a write built on a moved answer, but the submit
    path re-sent the entire form with no evidence of what it was built on — so a member
    whose page was open before a teammate's edit could put their older text back, silently.
    """

    def _open_group(self):
        version = self.frozen_group_version()
        stage, group, singers = self.confirmed_group(version)
        set_group_material_status(stage, GroupStage.MaterialStatus.OPEN, self.operator)
        return version, group, singers

    def submit(self, group, payload):
        return self.client.post(
            reverse("questionnaire:group_submit", args=[group.pk]),
            data=json.dumps(payload),
            content_type="application/json",
        )

    def stored_answers(self, group):
        from .models import QuestionnaireResponse

        return QuestionnaireResponse.objects.get(group=group).answers

    def test_a_submission_must_carry_the_bases_it_was_built_on(self):
        version, group, singers = self._open_group()
        self.login_member(singers[0])

        response = self.submit(
            group,
            {"answers": {"stage_note": "x"}, "schema_hash": self.schema_hash(version)},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("基准版本", response.json()["error"])

    def test_a_whole_form_submission_on_a_moved_answer_is_refused(self):
        version, group, singers = self._open_group()
        schema = self.schema_hash(version)
        self.login_member(singers[0])
        base = self.autosave(
            group, {"answers": {"stage_note": "初稿"}, "schema_hash": schema}
        ).json()["answer_bases"]["stage_note"]

        self.login_member(singers[1])
        moved = self.autosave(
            group,
            {
                "changes": [{"key": "stage_note", "base": base, "value": "队友改过"}],
                "schema_hash": schema,
            },
        )
        self.assertEqual(moved.status_code, 200, moved.content)

        self.login_member(singers[0])
        response = self.submit(
            group,
            {
                "answers": {"stage_note": "初稿"},
                "bases": {"stage_note": base},
                "schema_hash": schema,
            },
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "QUESTION_STALE")
        self.assertEqual(response.json()["conflicts"][0]["server"], "队友改过")
        self.assertEqual(self.stored_answers(group)["stage_note"], "队友改过")

    def test_a_whole_form_submission_on_the_current_bases_is_accepted(self):
        version, group, singers = self._open_group()
        schema = self.schema_hash(version)
        self.login_member(singers[0])
        bases = self.autosave(group, {"answers": {"stage_note": ""}, "schema_hash": schema}).json()[
            "answer_bases"
        ]

        response = self.submit(
            group,
            {"answers": {"stage_note": "定稿"}, "bases": bases, "schema_hash": schema},
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.stored_answers(group)["stage_note"], "定稿")


class GroupUploadVersionHttpTests(_GroupMaterialBase):
    def _open_group(self):
        version = self.frozen_group_version()
        stage, group, singers = self.confirmed_group(version)
        set_group_material_status(stage, GroupStage.MaterialStatus.OPEN, self.operator)
        return version, group, singers

    def _upload(self, group, schema, **fields):
        payload = {
            "file": SimpleUploadedFile("x.mp3", b"ID3" + b"chorus", content_type="audio/mpeg"),
            "schema_hash": schema,
            **fields,
        }
        return self.client.post(
            reverse("questionnaire:group_upload", args=[group.pk, "chorus_audio"]), payload
        )

    def test_an_upload_without_the_slot_version_is_refused(self):
        """Absent used to read as "this client does not do the check" — a silent replace."""
        version, group, singers = self._open_group()
        self.login_member(singers[0])

        response = self._upload(group, self.schema_hash(version))

        self.assertEqual(response.status_code, 400)
        self.assertIn("材料版本标识", response.json()["error"])

    def test_an_upload_on_a_current_version_is_accepted(self):
        version, group, singers = self._open_group()
        self.login_member(singers[0])

        response = self._upload(group, self.schema_hash(version), expected_current_version="0")

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["version"], 1)


AUDIO_OR_VIDEO_QUESTIONNAIRE = {
    "schema_version": 1,
    "key": "group_chorus",
    "subject": "group",
    "pages": [
        {
            "key": "material",
            "title": "分组合唱材料",
            "sections": [
                {
                    "key": "chorus",
                    "title": "合唱",
                    "questions": [
                        {
                            "key": "chorus_accompaniment",
                            "type": "file",
                            "label": "合唱伴奏（音频或视频）",
                            "required": True,
                            "file": {
                                "purpose": "accompaniment",
                                "accepts": ["performance_video"],
                                "max_mb": 20,
                                "extensions": [".mp3", ".mp4"],
                            },
                        },
                    ],
                }
            ],
        }
    ],
}


class GroupEitherBranchFileQuestionTests(_GroupMaterialBase):
    """GOAL §6.7: the accompaniment contract is "audio exists OR video exists".

    A questionnaire file question names one purpose, so a group holding only a video could
    not answer the accompaniment question at all. `file.accepts` names the other branch and
    the server decides which one an upload is from the file itself — the browser still
    never names a purpose.
    """

    def _open_group(self):
        version = self.frozen_group_version(questionnaire=AUDIO_OR_VIDEO_QUESTIONNAIRE)
        stage, group, singers = self.confirmed_group(version)
        set_group_material_status(stage, GroupStage.MaterialStatus.OPEN, self.operator)
        return version, group, singers

    # A signature the storage layer accepts: `ID3` for audio, an `ftyp` box for video.
    _BODIES = {
        "audio/mpeg": b"ID3" + b"body",
        "video/mp4": bytes.fromhex("00000018") + b"ftypmp42",
        "application/pdf": b"%PDF-1.4 body",
    }

    def _upload(self, group, schema, name, content_type, **fields):
        return self.client.post(
            reverse("questionnaire:group_upload", args=[group.pk, "chorus_accompaniment"]),
            {
                "file": SimpleUploadedFile(
                    name, self._BODIES[content_type], content_type=content_type
                ),
                "schema_hash": schema,
                "expected_current_version": "0",
                **fields,
            },
        )

    def _check(self, group, version):
        from files.services import reconcile_group_questionnaire_material_checks

        from questionnaire.registration import questionnaire_plan

        reconcile_group_questionnaire_material_checks(
            group=group, version=version, plan=questionnaire_plan(version)
        )
        from files.models import MaterialCheck

        return MaterialCheck.objects.get(group=group, question_key="chorus_accompaniment")

    def test_the_check_declares_both_branches(self):
        version, group, _singers = self._open_group()

        check = self._check(group, version)

        self.assertEqual(check.file_purpose, "accompaniment")
        self.assertEqual(check.accepted_file_purposes, ["performance_video"])

    def test_a_video_answers_an_audio_or_video_question(self):
        version, group, singers = self._open_group()
        self.login_member(singers[0])

        response = self._upload(group, self.schema_hash(version), "chorus.mp4", "video/mp4")

        self.assertEqual(response.status_code, 200, response.content)
        from files.models import SubmissionFile

        stored = SubmissionFile.objects.get(group=group, is_current=True)
        self.assertEqual(stored.file_purpose, "performance_video")
        self.assertEqual(stored.question_key, "chorus_accompaniment")

    def test_the_other_branch_replaces_the_first_rather_than_joining_it(self):
        """The question is the slot, so switching branch cannot leave two current files."""
        version, group, singers = self._open_group()
        self.login_member(singers[0])
        first = self._upload(group, self.schema_hash(version), "chorus.mp4", "video/mp4")
        self.assertEqual(first.status_code, 200, first.content)

        second = self._upload(
            group,
            self.schema_hash(version),
            "chorus.mp3",
            "audio/mpeg",
            expected_current_version=str(first.json()["version"]),
        )

        self.assertEqual(second.status_code, 200, second.content)
        from files.models import SubmissionFile

        current = SubmissionFile.objects.filter(group=group, is_current=True)
        self.assertEqual(current.count(), 1)
        self.assertEqual(current.get().file_purpose, "accompaniment")

    def test_a_file_that_is_neither_branch_is_refused(self):
        version, group, singers = self._open_group()
        self.login_member(singers[0])

        response = self._upload(group, self.schema_hash(version), "notes.pdf", "application/pdf")

        # The group upload view answers every domain rejection with the shared questionnaire
        # error, so the code is the view's convention; what matters here is that nothing was
        # stored under a question that accepts neither kind.
        self.assertGreaterEqual(response.status_code, 400)
        from files.models import SubmissionFile

        self.assertFalse(SubmissionFile.objects.filter(group=group).exists())
