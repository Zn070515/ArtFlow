"""P8 — the designer and the previews, end to end through the staff routes.

The designer is held to the same rule as every other editor: it patches the ``questionnaire``
section and returns the rest of the definition root byte-identical. That is the one
property that matters most here, because the questionnaire is the section most likely to be
edited often.
"""

import json
from uuid import uuid4

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, authority_write
from common.test_characterization import _CharacterizationBase
from django.urls import reverse
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import freeze_ruleset_version
from singer_contest.models import ContestRound, RubricCriterion, ScoringRubric, SingerRegistration

from .staff_views import PREVIEW_CONTEXTS

QUESTIONNAIRE = {
    "schema_version": 1,
    "key": "singer_submission",
    "pages": [
        {
            "key": "basic",
            "title": "基本信息",
            "sections": [
                {
                    "key": "identity",
                    "title": "身份",
                    "questions": [
                        {
                            "key": "name",
                            "type": "text",
                            "label": "姓名",
                            "binding": "registration.name",
                        },
                        {"key": "r1.song", "type": "text", "label": "第一轮曲目", "round": "r1"},
                        {
                            "key": "r1.accompaniment",
                            "type": "file",
                            "label": "第一轮伴奏",
                            "round": "r1",
                            "file": {
                                "purpose": "accompaniment",
                                "extensions": [".mp3"],
                                "max_mb": 100,
                                "max_files": 1,
                            },
                        },
                    ],
                }
            ],
        }
    ],
}


def _definition():
    return json.dumps(
        {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
                {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
                {"key": "top2", "type": "SELECT", "source": "rank1", "count": 2},
            ],
        },
        ensure_ascii=False,
    )


class _BuilderBase(_CharacterizationBase):
    def staff(self):
        cached = getattr(self, "_staff_user", None)
        if cached is not None:
            return cached
        user = self.make_user(f"builder-{uuid4().hex[:8]}")
        user.role = User.Role.STAFF
        with authority_write(ACCOUNT_AUTHORITY):
            user.save()
        self._staff_user = user
        return user

    def admin(self):
        cached = getattr(self, "_admin_user", None)
        if cached is not None:
            return cached
        user = self.make_user(f"builder-admin-{uuid4().hex[:8]}")
        user.role = User.Role.ADMIN
        with authority_write(ACCOUNT_AUTHORITY):
            user.save()
        self._admin_user = user
        return user

    def make_version(self, *, with_questionnaire=True, frozen=False):
        activity = self.make_activity(is_test_mode=True, title=f"builder-{uuid4().hex[:6]}")
        ruleset = ContestRuleset.objects.create(activity=activity, name="RS", is_test_data=True)
        rubric = ScoringRubric.objects.create(activity=activity, name="r1评分", is_test_data=True)
        RubricCriterion.objects.create(rubric=rubric, name="总分", max_score=100, is_test_data=True)
        contest_round = ContestRound.objects.create(
            activity=activity, round_type=ContestRound.RoundType.PRELIMINARY, name="r1"
        )
        contest_round.rubric = rubric
        contest_round.save(update_fields=["rubric"])
        ruleset.round_keys = {"r1": contest_round.pk}
        ruleset.save(update_fields=["round_keys"])
        for i in range(3):
            self.make_singer(
                activity,
                username=f"builder-field-{activity.pk}-{i}",
                student_id=f"40{i:04d}",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            )
        root = json.loads(_definition())
        if with_questionnaire:
            root["questionnaire"] = QUESTIONNAIRE
        version = RulesetVersion.objects.create(
            ruleset=ruleset, definition=json.dumps(root, ensure_ascii=False)
        )
        if frozen:
            freeze_ruleset_version(version, self.admin())
            version.refresh_from_db()
        return version

    def designer_url(self, version):
        return reverse("staff:ruleset_questionnaire", args=[version.pk])


class BuilderViewTests(_BuilderBase):
    def setUp(self):
        super().setUp()
        self.version = self.make_version()
        self.client.force_login(self.staff())

    def _stored_questionnaire(self):
        self.version.refresh_from_db()
        return json.loads(self.version.definition)["questionnaire"]

    def _post(self, **payload):
        payload.setdefault("base_content_hash", self.version.content_hash)
        return self.client.post(self.designer_url(self.version), payload)

    def test_the_designer_lists_every_question(self):
        response = self.client.get(self.designer_url(self.version))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "姓名")
        self.assertContains(response, "r1.accompaniment")

    def test_adding_a_question_writes_the_questionnaire_section(self):
        self._post(action="add", section_key="identity", question_type="textarea")
        keys = [
            q["key"] for q in self._stored_questionnaire()["pages"][0]["sections"][0]["questions"]
        ]
        self.assertEqual(len(keys), 4)

    def test_editing_the_questionnaire_leaves_the_flow_untouched(self):
        before = json.loads(self.version.definition)
        self._post(action="add", section_key="identity", question_type="text")
        after = json.loads(self.version.definition)
        self.assertEqual(sorted(after), sorted(before))
        self.assertEqual(after["nodes"], before["nodes"])

    def test_deleting_a_referenced_question_changes_nothing(self):
        document = self._stored_questionnaire()
        document["pages"][0]["sections"][0]["questions"][1]["visible_if"] = {
            "all": [{"source": "answer", "key": "name", "op": "not_empty"}]
        }
        RulesetVersion._base_manager.filter(pk=self.version.pk).update(
            definition=json.dumps(
                {**json.loads(self.version.definition), "questionnaire": document}
            )
        )
        before = self._stored_questionnaire()
        self._post(action="delete", key="name")
        self.assertEqual(self._stored_questionnaire(), before)

    def test_json_mode_saves_a_valid_document(self):
        document = self._stored_questionnaire()
        document["pages"][0]["sections"][0]["questions"].append(
            {"key": "r1.note", "type": "textarea", "label": "备注"}
        )
        self._post(action="save_json", questionnaire_json=json.dumps(document))
        keys = [
            q["key"] for q in self._stored_questionnaire()["pages"][0]["sections"][0]["questions"]
        ]
        self.assertIn("r1.note", keys)

    def test_json_mode_refuses_an_invalid_document(self):
        before = self._stored_questionnaire()
        document = self._stored_questionnaire()
        document["pages"][0]["sections"][0]["questions"][0]["binding"] = "registration.pre_status"
        self._post(action="save_json", questionnaire_json=json.dumps(document))
        self.assertEqual(self._stored_questionnaire(), before)

    def test_json_mode_refuses_a_stale_content_hash(self):
        document = self._stored_questionnaire()
        document["pages"][0]["sections"][0]["questions"].append(
            {"key": "r1.note", "type": "text", "label": "备注"}
        )
        self._post(
            action="save_json",
            questionnaire_json=json.dumps(document),
            base_content_hash="0" * 64,
        )
        self.assertNotIn(
            "r1.note",
            [
                q["key"]
                for q in self._stored_questionnaire()["pages"][0]["sections"][0]["questions"]
            ],
        )

    def test_a_version_with_no_questionnaire_yet_opens_on_an_empty_skeleton(self):
        bare = self.make_version(with_questionnaire=False)
        response = self.client.get(self.designer_url(bare))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "这个分区还没有题目")

    def test_a_frozen_version_cannot_be_edited_from_the_designer(self):
        frozen = self.make_version(frozen=True)
        self.assertEqual(
            self.client.post(self.designer_url(frozen), {"action": "add"}).status_code, 403
        )
        self.assertContains(self.client.get(self.designer_url(frozen)), "已冻结赛制版本不可编辑")


class PreviewViewTests(_BuilderBase):
    def setUp(self):
        super().setUp()
        self.version = self.make_version()
        self.client.force_login(self.staff())

    def _url(self, context):
        return reverse("staff:ruleset_questionnaire_preview", args=[self.version.pk, context])

    def test_every_context_renders(self):
        for context in PREVIEW_CONTEXTS:
            with self.subTest(context=context):
                response = self.client.get(self._url(context))
                self.assertEqual(response.status_code, 200)

    def test_the_partial_context_shows_a_filled_answer(self):
        body = self.client.get(self._url("partial")).content.decode()
        self.assertIn("示例回答", body)
        self.assertNotIn("尚未填写", body.split("第一轮伴奏")[-1][:200])

    def test_the_bare_context_shows_nothing_filled_in(self):
        body = self.client.get(self._url("participant")).content.decode()
        self.assertIn("尚未填写", body)

    def test_the_supplement_context_marks_exactly_one_question(self):
        body = self.client.get(self._url("supplement")).content.decode()
        self.assertEqual(body.count("⚠ 需补交"), 1)

    def test_preview_is_staff_only(self):
        self.client.force_login(self.make_user(f"outsider-{uuid4().hex[:8]}"))
        response = self.client.get(self._url("participant"))
        self.assertIn(response.status_code, (302, 403))

    def test_an_unknown_context_is_refused(self):
        self.assertEqual(self.client.get(self._url("imaginary")).status_code, 403)
