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
from ruleset.services import LIVE_CHALLENGE_FORMAT_KEY, freeze_ruleset_version
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


GROUP_QUESTIONNAIRE = {
    "schema_version": 1,
    "key": "group_submission",
    "subject": "group",
    "pages": [
        {
            "key": "group_materials",
            "title": "分组合唱材料",
            "sections": [
                {
                    "key": "songs",
                    "title": "歌曲",
                    "questions": [
                        {
                            "key": "group.song",
                            "type": "text",
                            "label": "合唱曲目",
                            "required": True,
                        },
                        {
                            "key": "group.media",
                            "type": "file",
                            "label": "合唱音视频",
                            "required": True,
                            "file": {
                                "purpose": "accompaniment",
                                "accepts": ["performance_video"],
                                "extensions": [".mp3", ".mp4"],
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


def _logical_round_questionnaire():
    """The 2026 shape: one question per personal round, bound to a round key, not a round."""

    return {
        "schema_version": 1,
        "key": "singer_submission",
        "pages": [
            {
                "key": "materials",
                "title": "现场材料",
                "sections": [
                    {
                        "key": "songs",
                        "title": "歌曲",
                        "questions": [
                            {
                                "key": "r2.song",
                                "type": "text",
                                "label": "踢馆曲目",
                                "round": "r2",
                                "required": True,
                            },
                            {
                                "key": "r3.song",
                                "type": "text",
                                "label": "第三轮曲目",
                                "round": "r3",
                                "required": True,
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

    def make_version(
        self,
        *,
        with_questionnaire=True,
        frozen=False,
        round_name="r1",
        questionnaire=None,
        group_questionnaire=None,
        live_challenge=None,
    ):
        activity = self.make_activity(is_test_mode=True, title=f"builder-{uuid4().hex[:6]}")
        ruleset = ContestRuleset.objects.create(activity=activity, name="RS", is_test_data=True)
        rubric = ScoringRubric.objects.create(activity=activity, name="r1评分", is_test_data=True)
        RubricCriterion.objects.create(rubric=rubric, name="总分", max_score=100, is_test_data=True)
        contest_round = ContestRound.objects.create(
            activity=activity, round_type=ContestRound.RoundType.PRELIMINARY, name=round_name
        )
        contest_round.rubric = rubric
        contest_round.save(update_fields=["rubric"])
        ruleset.round_keys = {"r1": contest_round.pk}
        if live_challenge is None:
            ruleset.save(update_fields=["round_keys"])
        else:
            ruleset.live_challenge = live_challenge
            ruleset.save(update_fields=["round_keys", "live_challenge"])
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
            root["questionnaire"] = QUESTIONNAIRE if questionnaire is None else questionnaire
        if group_questionnaire is not None:
            root["group_questionnaire"] = group_questionnaire
        version = RulesetVersion.objects.create(
            ruleset=ruleset, definition=json.dumps(root, ensure_ascii=False)
        )
        if frozen:
            freeze_ruleset_version(version, self.admin())
            version.refresh_from_db()
        return version

    def designer_url(self, version):
        return reverse("staff:ruleset_questionnaire", args=[version.pk])

    def group_designer_url(self, version):
        return reverse("staff:ruleset_group_questionnaire", args=[version.pk])

    def group_preview_url(self, version, context="participant"):
        return reverse(
            "staff:ruleset_group_questionnaire_preview", args=[version.pk, context]
        )


class BuilderViewTests(_BuilderBase):
    def setUp(self):
        super().setUp()
        self.version = self.make_version()
        self.client.force_login(self.staff())

    def _stored_questionnaire(self):
        self.version.refresh_from_db()
        return json.loads(self.version.definition)["questionnaire"]

    def _post(self, **payload):
        self.version.refresh_from_db()
        payload.setdefault("base_content_hash", self.version.content_hash)
        return self.client.post(self.designer_url(self.version), payload)

    def test_the_designer_lists_every_question(self):
        response = self.client.get(self.designer_url(self.version))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "姓名")
        self.assertContains(response, "r1.accompaniment")

    def test_the_designer_exposes_basic_question_editing_without_raw_json(self):
        response = self.client.get(self.designer_url(self.version))

        self.assertContains(response, "编辑题目")
        self.assertContains(response, "高级 JSON（通常不需要打开）")

    def test_editing_basic_question_fields_uses_the_structured_builder(self):
        self._post(
            action="edit",
            key="r1.song",
            label="第一轮演唱曲目",
            description="填写正式演唱的歌曲名称。",
            round="r1",
        )
        question = next(
            q
            for q in self._stored_questionnaire()["pages"][0]["sections"][0]["questions"]
            if q["key"] == "r1.song"
        )
        self.assertEqual(question["label"], "第一轮演唱曲目")
        self.assertEqual(question["description"], "填写正式演唱的歌曲名称。")

    def test_editing_choice_options_uses_structured_fields(self):
        self._post(action="add", section_key="identity", question_type="single_choice")
        key = self._stored_questionnaire()["pages"][0]["sections"][0]["questions"][-1]["key"]
        self._post(
            action="edit",
            key=key,
            label="曲目类型",
            option_value=["original", "cover"],
            option_label=["原创", "翻唱"],
        )
        question = self._stored_questionnaire()["pages"][0]["sections"][0]["questions"][-1]
        self.assertEqual(
            question["options"],
            [{"value": "original", "label": "原创"}, {"value": "cover", "label": "翻唱"}],
        )

    def test_editing_file_policy_uses_structured_fields(self):
        self._post(action="add", section_key="identity", question_type="file")
        key = self._stored_questionnaire()["pages"][0]["sections"][0]["questions"][-1]["key"]
        self._post(
            action="edit",
            key=key,
            label="伴奏文件",
            file_purpose="accompaniment",
            file_extensions=".mp3, .wav, .flac",
            file_max_mb="100",
        )
        question = self._stored_questionnaire()["pages"][0]["sections"][0]["questions"][-1]
        self.assertEqual(
            question["file"],
            {
                "purpose": "accompaniment",
                "extensions": [".mp3", ".wav", ".flac"],
                "max_mb": 100,
                "max_files": 1,
            },
        )

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

    def _newer_version_of(self, version):
        """A frozen successor on the same ruleset, which makes ``version`` history."""

        newer = RulesetVersion.objects.create(
            ruleset=version.ruleset,
            version=version.version + 1,
            definition=version.definition,
        )
        freeze_ruleset_version(newer, self.admin())
        newer.refresh_from_db()
        return newer

    def test_a_draft_its_successor_has_replaced_is_read_only_too(self):
        """``v1 DRAFT`` beside ``v2 FROZEN`` is history, and history is not an editing target.

        The write path already refused it, so the editable page was a false affordance: the
        operator could add, edit and save, and only met the refusal after doing the work.
        """

        older = self.make_version()
        newer = self._newer_version_of(older)

        page = self.client.get(self.designer_url(older))

        self.assertContains(page, f"已被 v{newer.version} 替代")
        self.assertEqual(
            self.client.post(self.designer_url(older), {"action": "add"}).status_code, 403
        )

    def _round_choices(self, version):
        return dict(self.client.get(self.designer_url(version)).context["round_choices"])

    def test_the_picker_keeps_a_round_key_a_question_already_uses(self):
        """A key no binding declares must still round-trip.

        Whatever a question is already bound to has to stay selectable, or editing that
        question's label quietly drops the round it belongs to.
        """

        version = self.make_version(
            questionnaire={
                "schema_version": 1,
                "key": "singer_submission",
                "pages": [
                    {
                        "key": "materials",
                        "title": "材料",
                        "sections": [
                            {
                                "key": "songs",
                                "title": "歌曲",
                                "questions": [
                                    {
                                        "key": "r4.song",
                                        "type": "text",
                                        "label": "第四轮曲目",
                                        "round": "r4",
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        )

        choices = self._round_choices(version)

        self.assertIn("r4", choices)

    def test_the_picker_keeps_the_formats_logical_rounds(self):
        """2026's r2/r3 are logical rounds, not missing physical ones.

        r2's scoring round is created by the challenge at the venue and r3 only after the
        session is confirmed, so neither is in ``round_keys`` while the questionnaire is
        written — and the built-in questionnaire binds questions to both.
        """

        version = self.make_version(
            questionnaire=_logical_round_questionnaire(),
            live_challenge={"format_key": LIVE_CHALLENGE_FORMAT_KEY},
        )

        choices = self._round_choices(version)

        self.assertIn("r2", choices)
        self.assertIn("r3", choices)
        self.assertIn("踢馆轮", choices["r2"])
        self.assertIn("第三轮", choices["r3"])

    def test_a_frozen_version_names_its_own_rounds(self):
        """The picker asked the live ruleset, so a rebound successor rewrote history.

        A FROZEN version is self-authoritative: its binding snapshot is what its questions
        were written against, and a successor draft may already have moved the shared
        ``ContestRuleset`` to a different physical round.
        """

        frozen = self.make_version(frozen=True, round_name="初赛第一轮")
        successor_round = ContestRound.objects.create(
            activity=frozen.ruleset.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            name="第一轮（后继）",
            sequence=2,
        )
        frozen.ruleset.round_keys = {"r1": successor_round.pk}
        frozen.ruleset.save(update_fields=["round_keys"])

        choices = self._round_choices(frozen)

        self.assertEqual(choices["r1"], "r1 · 初赛第一轮")

    def test_the_round_picker_offers_the_binding_keys_and_nothing_it_made_up(self):
        """``sequence → rN`` is a guess, and the guess is wrong exactly where it matters.

        A round cloned for a successor carries ``sequence = max + 1``, so the designer
        offered "r2 · 第一轮" beside the real "r1 · 第一轮" — while r2 in this format means
        the challenge round. The format's own round keys are the authority on what a round
        is called; nothing else gets to name one.
        """

        version = self.make_version()
        ContestRound.objects.create(
            activity=version.ruleset.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            name="第一轮（复制）",
            sequence=2,
        )

        response = self.client.get(self.designer_url(version))

        choices = dict(response.context["round_choices"])
        self.assertEqual(set(choices), {"", "r1"})


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


class GroupBuilderViewTests(_BuilderBase):
    def setUp(self):
        super().setUp()
        self.version = self.make_version(group_questionnaire=GROUP_QUESTIONNAIRE)
        self.client.force_login(self.staff())

    def _stored(self):
        self.version.refresh_from_db()
        root = json.loads(self.version.definition)
        return root["questionnaire"], root["group_questionnaire"]

    def _post(self, **payload):
        self.version.refresh_from_db()
        payload.setdefault("base_content_hash", self.version.content_hash)
        return self.client.post(self.group_designer_url(self.version), payload)

    def test_group_designer_renders_the_group_questions(self):
        response = self.client.get(self.group_designer_url(self.version))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "合唱曲目")
        self.assertContains(response, "group.media")

    def test_editing_group_question_leaves_participant_untouched(self):
        before_participant, _ = self._stored()

        response = self._post(action="edit", key="group.song", label="合唱歌名")

        self.assertEqual(response.status_code, 302)
        participant, group = self._stored()
        self.assertEqual(participant, before_participant)
        self.assertEqual(
            group["pages"][0]["sections"][0]["questions"][0]["label"], "合唱歌名"
        )

    def test_editing_group_file_question_keeps_accepts(self):
        self._post(
            action="edit",
            key="group.media",
            label="合唱音视频",
            file_purpose="accompaniment",
            file_extensions=".mp3, .mp4",
            file_max_mb="100",
            file_accepts=["performance_video"],
        )

        _, group = self._stored()
        question = group["pages"][0]["sections"][0]["questions"][1]
        self.assertEqual(question["file"]["accepts"], ["performance_video"])

    def test_json_mode_cannot_put_the_participant_document_in_the_group_slot(self):
        _, before_group = self._stored()

        response = self._post(
            action="save_json", questionnaire_json=json.dumps(QUESTIONNAIRE)
        )

        self.assertEqual(response.status_code, 302)
        _, after_group = self._stored()
        self.assertEqual(after_group, before_group)

    def test_group_preview_renders(self):
        response = self.client.get(self.group_preview_url(self.version, "partial"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "分组合唱材料")
        self.assertContains(response, "合唱音视频")

    def test_saving_a_legacy_group_document_moves_it_to_the_group_slot(self):
        version = self.make_version(with_questionnaire=False)
        root = json.loads(version.definition)
        root["questionnaire"] = GROUP_QUESTIONNAIRE
        version.definition = json.dumps(root, ensure_ascii=False)
        version.save(update_fields=["definition"])
        version.refresh_from_db()

        response = self.client.post(
            self.group_designer_url(version),
            {
                "action": "edit",
                "key": "group.song",
                "label": "合唱歌名",
                "base_content_hash": version.content_hash,
            },
        )

        self.assertEqual(response.status_code, 302)
        version.refresh_from_db()
        stored = json.loads(version.definition)
        self.assertNotIn("questionnaire", stored)
        self.assertIn("group_questionnaire", stored)
        self.assertEqual(
            stored["group_questionnaire"]["pages"][0]["sections"][0]["questions"][0][
                "label"
            ],
            "合唱歌名",
        )
