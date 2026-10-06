"""P4 — the participant form is rendered from the frozen questionnaire, and autosaves.

The page is a container: the questions, their order, their conditions and their file
limits all come from the frozen plan, so a template that named a field would be a second
source of truth that drifts the moment a question is added.

Autosave writes through the same services the submit path uses, so there is one write
path and one set of rules: bound answers land on the registration, unknown keys are
dropped, a stale form is told to refresh, and a submitted response is no longer editable.
The completion count is computed from what the participant can actually see and actually
owes — counting "answered / total questions" would mark next month's material as missing
today.
"""

import json
from uuid import uuid4

from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from common.test_characterization import _CharacterizationBase
from core.models import Activity
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import freeze_ruleset_version
from singer_contest.models import ContestRound, RubricCriterion, ScoringRubric, SingerRegistration

from .models import QuestionnaireResponse
from .runtime import completion_summary
from .schema import schema_hash

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
                            "required": True,
                        },
                        {"key": "intro", "type": "notice", "label": "请如实填写"},
                    ],
                }
            ],
        },
        {
            "key": "rounds",
            "title": "各轮材料",
            "sections": [
                {
                    "key": "round3",
                    "title": "第三轮",
                    "questions": [
                        {"key": "r3.has_guest", "type": "boolean", "label": "是否有嘉宾"},
                        {
                            "key": "r3.guest_name",
                            "type": "text",
                            "label": "嘉宾姓名",
                            "visible_if": {
                                "all": [
                                    {
                                        "source": "answer",
                                        "key": "r3.has_guest",
                                        "op": "eq",
                                        "value": True,
                                    }
                                ]
                            },
                            "required_if": {
                                "all": [
                                    {
                                        "source": "answer",
                                        "key": "r3.has_guest",
                                        "op": "eq",
                                        "value": True,
                                    }
                                ]
                            },
                        },
                        {
                            "key": "r3.song",
                            "type": "text",
                            "label": "第三轮曲目",
                            "round": "r3",
                            "required": True,
                            "due": {"mode": "before_round", "round": "r3"},
                        },
                    ],
                }
            ],
        },
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


class _FormBase(_CharacterizationBase):
    def operator(self):
        from accounts.models import User

        cached = getattr(self, "_operator_user", None)
        if cached is not None:
            return cached
        user = self.make_user(f"form-admin-{uuid4().hex[:8]}")
        user.role = User.Role.ADMIN
        with authority_write(ACCOUNT_AUTHORITY):
            user.save()
        self._operator_user = user
        return user

    def frozen_version(self, *, phase=Activity.Phase.REGISTRATION_OPEN, test_mode=False):
        activity = self.make_activity(
            is_test_mode=test_mode, title=f"问卷页-{uuid4().hex[:6]}", phase=phase
        )
        ruleset = ContestRuleset.objects.create(
            activity=activity, name="RS", is_test_data=test_mode
        )
        rubric = ScoringRubric.objects.create(
            activity=activity, name="r3评分", is_test_data=test_mode
        )
        RubricCriterion.objects.create(
            rubric=rubric, name="总分", max_score=100, is_test_data=test_mode
        )
        contest_round = ContestRound.objects.create(
            activity=activity, round_type=ContestRound.RoundType.PRELIMINARY, name="r3"
        )
        contest_round.rubric = rubric
        contest_round.save(update_fields=["rubric"])
        ruleset.round_keys = {"r3": contest_round.pk}
        ruleset.save(update_fields=["round_keys"])
        for i in range(3):
            self.make_singer(
                activity,
                username=f"form-field-{activity.pk}-{i}",
                student_id=f"50{i:04d}",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=test_mode,
            )
        root = json.loads(_definition())
        root["questionnaire"] = QUESTIONNAIRE
        version = RulesetVersion.objects.create(
            ruleset=ruleset, definition=json.dumps(root, ensure_ascii=False)
        )
        freeze_ruleset_version(version, self.operator())
        version.refresh_from_db()
        return version

    def participant(self, version):
        return self.make_user(f"form-singer-{uuid4().hex[:8]}")


class CompletionSummaryTests(_CharacterizationBase):
    def _plan(self):
        from .compiler import compile_questionnaire

        return compile_questionnaire(QUESTIONNAIRE)

    def test_hidden_questions_are_not_counted_at_all(self):
        summary = completion_summary(
            self._plan(),
            registration=None,
            answers={},
            context={},
            due_rounds=frozenset({"r3"}),
        )
        # name is required; r3.song is required and due; r3.guest_name is hidden.
        self.assertEqual(summary["required"], 2)
        self.assertEqual(summary["answered"], 0)

    def test_a_question_shown_early_is_not_counted_as_owed(self):
        summary = completion_summary(
            self._plan(), registration=None, answers={}, context={}, due_rounds=frozenset()
        )
        self.assertEqual(summary["required"], 1)
        self.assertEqual(summary["upcoming"], 1)

    def test_the_summary_groups_by_round(self):
        summary = completion_summary(
            self._plan(),
            registration=None,
            answers={},
            context={},
            due_rounds=frozenset({"r3"}),
        )
        self.assertEqual(summary["groups"]["r3"], {"answered": 0, "required": 1, "upcoming": 0})
        self.assertEqual(summary["groups"]["basic"], {"answered": 0, "required": 1, "upcoming": 0})

    def test_an_answered_question_is_counted_once(self):
        summary = completion_summary(
            self._plan(),
            registration=None,
            answers={"r3.song": "歌"},
            context={},
            due_rounds=frozenset({"r3"}),
        )
        self.assertEqual(summary["answered"], 1)
        self.assertEqual(summary["required"], 2)
        self.assertEqual(summary["required_answered"], 1)


class QuestionnaireFormViewTests(_FormBase):
    def setUp(self):
        super().setUp()
        self.version = self.frozen_version()
        self.activity = self.version.ruleset.activity
        self.client.force_login(self.participant(self.version))

    def _url(self):
        return reverse("questionnaire:form", args=[self.activity.pk])

    def test_the_form_renders_the_questions_of_the_frozen_questionnaire(self):
        response = self.client.get(self._url())
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "姓名")
        self.assertContains(response, "请如实填写")
        self.assertContains(response, "第三轮曲目")

    def test_opening_the_form_creates_the_draft(self):
        self.client.get(self._url())
        self.assertTrue(
            SingerRegistration.objects.filter(
                activity=self.activity,
                user_id=self.client.session["_auth_user_id"],
                pre_status=SingerRegistration.PreStatus.DRAFT,
            ).exists()
        )
        self.assertEqual(QuestionnaireResponse.objects.count(), 1)

    def test_a_reload_shows_what_was_already_answered(self):
        self.client.post(
            reverse("questionnaire:autosave", args=[self.activity.pk]),
            data=json.dumps(
                {"answers": {"r3.song": "左手指月"}, "schema_hash": schema_hash(QUESTIONNAIRE)}
            ),
            content_type="application/json",
        )
        response = self.client.get(self._url())
        self.assertContains(response, "左手指月")

    def test_a_participant_can_still_read_their_form_after_registration_closes(self):
        """Closing registration takes away the right to *edit*, not the right to see what
        was submitted — and the supplement flow needs the page to exist."""
        with authority_write(ACTIVITY_STATE):
            self.activity.phase = Activity.Phase.REGISTRATION_CLOSED
            self.activity.save(update_fields=["phase"])
        response = self.client.get(self._url())
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.context["editable"])

    def test_staff_may_preview_a_closed_activity(self):
        with authority_write(ACTIVITY_STATE):
            self.activity.phase = Activity.Phase.REGISTRATION_CLOSED
            self.activity.save(update_fields=["phase"])
        self.client.force_login(self.operator())
        self.assertEqual(self.client.get(self._url()).status_code, 200)


class QuestionnaireAutosaveTests(_FormBase):
    def setUp(self):
        super().setUp()
        self.version = self.frozen_version()
        self.activity = self.version.ruleset.activity
        self.user = self.participant(self.version)
        self.client.force_login(self.user)

    def _post(self, payload):
        """Post an autosave with the page's own version, as the browser would."""
        body = {"schema_hash": schema_hash(QUESTIONNAIRE), **payload}
        return self.client.post(
            reverse("questionnaire:autosave", args=[self.activity.pk]),
            data=json.dumps(body),
            content_type="application/json",
        )

    def test_autosave_writes_bound_and_unbound_answers(self):
        response = self._post({"answers": {"name": "陈昭艺", "r3.song": "歌"}})
        self.assertEqual(response.status_code, 200)
        registration = SingerRegistration.objects.get(activity=self.activity, user=self.user)
        self.assertEqual(registration.name, "陈昭艺")
        stored = QuestionnaireResponse.objects.get(singer_registration=registration)
        self.assertEqual(stored.answers.get("r3.song"), "歌")
        self.assertNotIn("name", stored.answers)

    def test_autosave_returns_the_completion_summary(self):
        body = self._post({"answers": {"name": "陈"}}).json()
        self.assertEqual(body["completion"]["required"], 1)
        self.assertEqual(body["completion"]["answered"], 1)

    def test_autosave_drops_a_key_the_plan_does_not_define(self):
        self._post({"answers": {"name": "陈", "r9.invented": "x"}})
        registration = SingerRegistration.objects.get(activity=self.activity, user=self.user)
        stored = QuestionnaireResponse.objects.get(singer_registration=registration)
        self.assertNotIn("r9.invented", stored.answers)

    def test_autosave_refuses_a_stale_schema_hash(self):
        self._post({"answers": {"name": "陈"}, "schema_hash": schema_hash(QUESTIONNAIRE)})
        response = self._post({"answers": {"name": "改"}, "schema_hash": "0" * 64})
        self.assertEqual(response.status_code, 409)

    def test_autosave_still_works_after_submitting_while_registration_is_open(self):
        """A participant who has submitted may correct their details until the deadline."""
        from .registration import get_or_create_draft_registration
        from .services import mark_submitted

        registration, response = get_or_create_draft_registration(
            version=self.version, user=self.user
        )
        mark_submitted(response)
        self.assertEqual(self._post({"answers": {"name": "改"}}).status_code, 200)
        registration.refresh_from_db()
        self.assertEqual(registration.name, "改")

    def test_autosave_needs_a_json_body(self):
        response = self.client.post(
            reverse("questionnaire:autosave", args=[self.activity.pk]),
            data="not json",
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_autosave_does_not_echo_validation_exception_details(self):
        response = self._post({"answers": {"name": []}})

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"], "问卷内容未通过校验，请检查后重试。")
        self.assertNotIn("必须是文本", response.json()["error"])

    def test_a_participant_cannot_autosave_into_a_closed_activity(self):
        with authority_write(ACTIVITY_STATE):
            self.activity.phase = Activity.Phase.REGISTRATION_CLOSED
            self.activity.save(update_fields=["phase"])
        self.assertEqual(self._post({"answers": {"name": "陈"}}).status_code, 409)


class ParticipantBoundaryTests(_FormBase):
    """The three contracts a participant-facing write route owes.

    Every one of them replaces something the legacy apply path already did, and which the
    questionnaire route had quietly stopped doing.
    """

    def setUp(self):
        super().setUp()
        self.version = self.frozen_version()
        self.activity = self.version.ruleset.activity
        self.user = self.participant(self.version)
        self.client.force_login(self.user)

    def _autosave(self, payload):
        return self.client.post(
            reverse("questionnaire:autosave", args=[self.activity.pk]),
            data=json.dumps(payload),
            content_type="application/json",
        )

    def test_autosave_requires_the_page_version(self):
        """A client can omit an optional field, so on this boundary it is not optional:
        without it a page that cannot see the current questionnaire could write into it."""
        self.assertEqual(self._autosave({"answers": {"name": "陈"}}).status_code, 400)

    def test_upload_requires_the_page_version(self):
        response = self.client.post(
            reverse("questionnaire:upload", args=[self.activity.pk, "stage.note"]),
            data={"file": SimpleUploadedFile("a.mp3", b"ID3\x04\x00\x00")},
        )
        self.assertEqual(response.status_code, 400)

    def test_submit_requires_the_page_version(self):
        response = self.client.post(
            reverse("questionnaire:submit", args=[self.activity.pk]),
            data=json.dumps({"answers": {"name": "陈"}}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_staff_may_not_write_through_the_participant_route(self):
        """Staff preview the form; a staff account must not be able to create or fill a
        registration of its own through it."""
        self.client.force_login(self.operator())
        requests: tuple[tuple[str, dict[str, object]], ...] = (
            (reverse("questionnaire:autosave", args=[self.activity.pk]), {"answers": {}}),
            (reverse("questionnaire:submit", args=[self.activity.pk]), {"answers": {}}),
            (reverse("questionnaire:upload", args=[self.activity.pk, "stage.note"]), {}),
        )
        for url, payload in requests:
            with self.subTest(url=url):
                response = self.client.post(
                    url, data=json.dumps(payload), content_type="application/json"
                )
                self.assertEqual(response.status_code, 403)
        self.assertEqual(SingerRegistration.objects.filter(activity=self.activity).count(), 3)

    def test_a_participant_cannot_open_a_test_activity(self):
        """The legacy path filtered its lookup to FORMAL activities, so guessing a primary
        key found nothing. The questionnaire route has to do the same."""
        rehearsal = self.frozen_version(test_mode=True)
        self.assertEqual(
            self.client.get(
                reverse("questionnaire:form", args=[rehearsal.ruleset.activity_id])
            ).status_code,
            404,
        )

    def test_staff_can_preview_a_test_activity(self):
        rehearsal = self.frozen_version(test_mode=True)
        self.client.force_login(self.operator())
        self.assertEqual(
            self.client.get(
                reverse("questionnaire:form", args=[rehearsal.ruleset.activity_id])
            ).status_code,
            200,
        )


class QuestionnaireSubmitTests(_FormBase):
    def setUp(self):
        super().setUp()
        self.version = self.frozen_version()
        self.activity = self.version.ruleset.activity
        self.user = self.participant(self.version)
        self.client.force_login(self.user)

    def _submit(self, payload):
        return self.client.post(
            reverse("questionnaire:submit", args=[self.activity.pk]),
            data=json.dumps(payload),
            content_type="application/json",
        )

    def _filled(self, **extra):
        return {
            "answers": {"name": "陈昭艺", "r3.song": "左手指月", **extra},
            "schema_hash": schema_hash(QUESTIONNAIRE),
        }

    def test_the_form_carries_a_submit_button_pointing_at_the_route(self):
        body = self.client.get(
            reverse("questionnaire:form", args=[self.activity.pk])
        ).content.decode()
        self.assertIn("data-submit-questionnaire", body)
        self.assertIn(reverse("questionnaire:submit", args=[self.activity.pk]), body)

    def test_submit_finishes_the_registration(self):
        response = self._submit({**self._filled(), "schema_hash": schema_hash(QUESTIONNAIRE)})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "submitted")
        registration = SingerRegistration.objects.get(activity=self.activity, user=self.user)
        self.assertEqual(registration.pre_status, SingerRegistration.PreStatus.SUBMITTED)
        self.assertEqual(registration.name, "陈昭艺")

    def test_submit_refuses_while_a_required_answer_is_missing(self):
        response = self._submit(
            {"answers": {"r3.song": "歌"}, "schema_hash": schema_hash(QUESTIONNAIRE)}
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"], "问卷内容未通过校验，请检查后重试。")

    def test_submit_refuses_a_stale_schema_hash(self):
        self.assertEqual(self._submit({**self._filled(), "schema_hash": "0" * 64}).status_code, 409)

    def test_submit_refuses_a_request_that_omits_the_schema_hash(self):
        """An HTTP caller always has one; accepting a submission without it would let a
        page that cannot see the current questionnaire write into it."""
        response = self._submit({"answers": {"name": "陈", "r3.song": "歌"}})
        self.assertEqual(response.status_code, 400)

    def test_submitting_again_after_an_edit_is_allowed_while_registration_is_open(self):
        self._submit(self._filled())
        changed = {
            "answers": {"name": "改过的名字", "r3.song": "左手指月"},
            "schema_hash": schema_hash(QUESTIONNAIRE),
        }
        self.assertEqual(self._submit(changed).status_code, 200)
        registration = SingerRegistration.objects.get(activity=self.activity, user=self.user)
        self.assertEqual(registration.name, "改过的名字")


class ClosedRegistrationTests(_FormBase):
    def setUp(self):
        super().setUp()
        self.version = self.frozen_version()
        self.activity = self.version.ruleset.activity
        self.user = self.participant(self.version)
        self.client.force_login(self.user)
        from .registration import get_or_create_draft_registration

        self.registration, _response = get_or_create_draft_registration(
            version=self.version, user=self.user
        )

    def _close(self):
        with authority_write(ACTIVITY_STATE):
            self.activity.phase = Activity.Phase.REGISTRATION_CLOSED
            self.activity.save(update_fields=["phase"])

    def _grant_supplement(self, question_key):
        """Send one question back. The check already exists — opening the form created one
        per question — so this flips its status rather than adding a second."""
        from files.models import MaterialCheck

        check, _created = MaterialCheck.objects.get_or_create(
            singer_registration=self.registration,
            question_key=question_key,
            defaults={"item_name": question_key},
        )
        check.status = MaterialCheck.Status.NEEDS_SUPPLEMENT
        check.save(update_fields=["status"])

    def _post(self, answers):
        return self.client.post(
            reverse("questionnaire:autosave", args=[self.activity.pk]),
            data=json.dumps({"answers": answers, "schema_hash": schema_hash(QUESTIONNAIRE)}),
            content_type="application/json",
        )

    def test_an_ordinary_edit_is_refused_once_registration_closes(self):
        self._close()
        self.assertEqual(self._post({"r3.song": "改"}).status_code, 409)
        self.registration.refresh_from_db()
        self.assertEqual(self.registration.name, "")

    def test_a_supplement_reopens_only_the_question_it_was_granted_for(self):
        self._close()
        self._grant_supplement("r3.song")
        self.assertEqual(self._post({"r3.song": "重新提交的曲目"}).status_code, 200)
        self.assertEqual(self._post({"name": "偷改的名字"}).status_code, 409)

    def test_a_whole_form_autosave_during_supplement_writes_only_the_granted_question(self):
        """The browser posts every input it rendered, including the disabled ones.

        The closed page disables the questions outside the window, but a form submission
        carries their current values anyway. The server rejected the whole payload for
        containing a non-writable key, so the one question staff sent back could never be
        saved: every autosave answered 409.
        """
        self._post({"name": "陈昭艺", "r1.song": "歌", "r3.song": "旧曲目"})
        self.registration.refresh_from_db()
        self.assertEqual(self.registration.name, "陈昭艺")
        self._close()
        self._grant_supplement("r3.song")

        response = self._post({"name": "陈昭艺", "r1.song": "歌", "r3.song": "新曲目"})

        self.assertEqual(response.status_code, 200)
        saved = QuestionnaireResponse.objects.get(singer_registration=self.registration)
        self.assertEqual(saved.answers.get("r3.song"), "新曲目")
        self.registration.refresh_from_db()
        self.assertEqual(self.registration.name, "陈昭艺")

    def test_the_closed_page_marks_the_supplemented_question_editable(self):
        self._close()
        self._grant_supplement("r3.song")
        response = self.client.get(reverse("questionnaire:form", args=[self.activity.pk]))
        rows = {
            row["key"]: row
            for page in response.context["pages"]
            for section in page["sections"]
            for row in section["questions"]
        }
        self.assertTrue(rows["r3.song"]["editable"])
        self.assertFalse(rows["name"]["editable"])
