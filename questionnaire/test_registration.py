"""P3 — opening, filling, and submitting a registration through the frozen questionnaire.

The participant's first view of the form *creates* the draft: a registration row in DRAFT
plus a response, both keyed to the current FROZEN version. Filling is incremental and
survives a reload; submitting is one atomic server-side act that reloads the frozen
ruleset, re-evaluates every condition, proves the due-now required questions are answered,
and only then finishes the registration.

Two things are structural rather than prose, and the tests below pin both. The submission
context is *built from server facts* — there is no parameter a browser could put a phase or
a qualification into. And a bound answer lives on the registration from the first
keystroke, so there is exactly one copy of "what is your name" and no second one to drift.
"""

import json
from types import SimpleNamespace
from uuid import uuid4

from common.authority import ACCOUNT_AUTHORITY, authority_write
from common.test_characterization import _CharacterizationBase
from core.models import Activity
from django.core.exceptions import ValidationError
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import freeze_ruleset_version
from singer_contest.models import ContestRound, RubricCriterion, ScoringRubric, SingerRegistration

from .compiler import compile_questionnaire
from .conditions import evaluate_condition
from .registration import (
    build_submission_context,
    get_or_create_draft_registration,
    normalize_answer,
    submit_registration,
)
from .runtime import missing_required, resolve_questions
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
                        {
                            "key": "r1.song",
                            "type": "text",
                            "label": "第一轮曲目",
                            "round": "r1",
                            "required": True,
                            "due": {"mode": "before_round", "round": "r1"},
                        },
                        {"key": "r3.has_guest", "type": "boolean", "label": "是否有嘉宾"},
                        {
                            "key": "r3.guest_name",
                            "type": "text",
                            "label": "嘉宾姓名",
                            "round": "r3",
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
                    ],
                }
            ],
        }
    ],
}

PLAN = compile_questionnaire(QUESTIONNAIRE)


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


class ConditionTests(_CharacterizationBase):
    def _condition(self, op, *, value=None, key="a"):
        leaf = {"source": "answer", "key": key, "op": op}
        if value is not None:
            leaf["value"] = value
        return {"all": [leaf]}

    def test_eq_and_neq_compare_the_stored_answer(self):
        eq = self._condition("eq", value=True)
        self.assertTrue(evaluate_condition(eq, answers={"a": True}, context={}))
        self.assertFalse(evaluate_condition(eq, answers={"a": False}, context={}))
        self.assertTrue(
            evaluate_condition(self._condition("neq", value=True), answers={"a": False}, context={})
        )

    def test_in_and_not_in_treat_the_value_as_a_set(self):
        condition = self._condition("in", value=["r1", "r2"])
        self.assertTrue(evaluate_condition(condition, answers={"a": "r2"}, context={}))
        self.assertFalse(evaluate_condition(condition, answers={"a": "r3"}, context={}))

    def test_contains_reads_a_list_valued_answer(self):
        condition = self._condition("contains", value="r2")
        self.assertTrue(evaluate_condition(condition, answers={"a": ["r1", "r2"]}, context={}))
        self.assertFalse(evaluate_condition(condition, answers={"a": ["r1"]}, context={}))

    def test_empty_and_not_empty_ignore_a_value(self):
        empty = self._condition("empty")
        self.assertTrue(evaluate_condition(empty, answers={}, context={}))
        self.assertTrue(evaluate_condition(empty, answers={"a": ""}, context={}))
        self.assertFalse(evaluate_condition(empty, answers={"a": "x"}, context={}))
        self.assertTrue(
            evaluate_condition(self._condition("not_empty"), answers={"a": "x"}, context={})
        )

    def test_context_conditions_read_server_facts_not_answers(self):
        condition = {
            "all": [{"source": "context", "key": "qualified.r3", "op": "eq", "value": True}]
        }
        self.assertTrue(evaluate_condition(condition, answers={}, context={"qualified.r3": True}))
        self.assertFalse(evaluate_condition(condition, answers={"qualified.r3": True}, context={}))

    def test_an_unanswered_question_is_not_equal_to_a_value(self):
        """Absent is not False — otherwise ``visible_if: true`` would reveal a dependent
        question before anyone answered its gate."""
        self.assertFalse(
            evaluate_condition(self._condition("eq", value=True), answers={}, context={})
        )

    def test_an_absent_condition_is_visible(self):
        self.assertTrue(evaluate_condition(None, answers={}, context={}))


class AnswerNormalizationTests(_CharacterizationBase):
    def test_choice_values_must_belong_to_the_frozen_domain(self):
        question = {
            "key": "kind",
            "type": "single_choice",
            "options": [{"value": "solo", "label": "独唱"}],
        }
        self.assertEqual(normalize_answer(question, "solo"), "solo")
        with self.assertRaises(ValidationError):
            normalize_answer(question, "forged")

    def test_multiple_choice_is_a_validated_list(self):
        question = {
            "key": "roles",
            "type": "multiple_choice",
            "options": [
                {"value": "lead", "label": "主唱"},
                {"value": "guest", "label": "嘉宾"},
            ],
            "validation": {"min_selections": 1, "max_selections": 2},
        }
        self.assertEqual(normalize_answer(question, ["lead", "guest"]), ["lead", "guest"])
        with self.assertRaises(ValidationError):
            normalize_answer(question, ["forged"])
        with self.assertRaises(ValidationError):
            normalize_answer(question, [])

    def test_text_length_and_phone_domains_are_enforced(self):
        question = {
            "key": "phone",
            "type": "text",
            "validation": {"max_length": 11, "format": "phone_cn"},
        }
        self.assertEqual(normalize_answer(question, "13800138000"), "13800138000")
        with self.assertRaises(ValidationError):
            normalize_answer(question, "not-a-phone")
        with self.assertRaises(ValidationError):
            normalize_answer(question, "138001380001")


class ResolvedConditionSourceTests(_CharacterizationBase):
    def test_conditions_read_bound_and_file_answers_in_document_order(self):
        plan = compile_questionnaire(
            {
                "schema_version": 1,
                "key": "sources",
                "pages": [
                    {
                        "key": "p",
                        "title": "P",
                        "sections": [
                            {
                                "key": "s",
                                "title": "S",
                                "questions": [
                                    {
                                        "key": "name",
                                        "type": "text",
                                        "label": "姓名",
                                        "binding": "registration.name",
                                    },
                                    {
                                        "key": "proof",
                                        "type": "file",
                                        "label": "证明",
                                        "file": {
                                            "purpose": "other",
                                            "extensions": [".txt"],
                                            "max_mb": 1,
                                            "max_files": 1,
                                        },
                                    },
                                    {
                                        "key": "bound_dependent",
                                        "type": "text",
                                        "label": "绑定条件",
                                        "visible_if": {
                                            "source": "answer",
                                            "key": "name",
                                            "op": "eq",
                                            "value": "陈",
                                        },
                                    },
                                    {
                                        "key": "file_dependent",
                                        "type": "text",
                                        "label": "文件条件",
                                        "visible_if": {
                                            "source": "answer",
                                            "key": "proof",
                                            "op": "not_empty",
                                        },
                                    },
                                ],
                            }
                        ],
                    }
                ],
            }
        )
        resolved = resolve_questions(
            plan,
            answers={},
            context={},
            registration=SimpleNamespace(name="陈"),
            files={"proof": object()},
        )
        self.assertTrue(resolved[2].visible)
        self.assertTrue(resolved[3].visible)


class ResolveQuestionTests(_CharacterizationBase):
    def _questions(self, *, answers, context=None, due_rounds=frozenset()):
        resolved = resolve_questions(
            PLAN, answers=answers, context=context or {}, due_rounds=due_rounds
        )
        return {q.question["key"]: q for q in resolved}

    def test_a_dependent_question_is_hidden_until_its_gate_is_true(self):
        self.assertFalse(self._questions(answers={})["r3.guest_name"].visible)
        self.assertTrue(self._questions(answers={"r3.has_guest": True})["r3.guest_name"].visible)

    def test_required_if_only_bites_while_the_question_is_visible(self):
        self.assertFalse(self._questions(answers={"r3.has_guest": False})["r3.guest_name"].required)
        self.assertTrue(self._questions(answers={"r3.has_guest": True})["r3.guest_name"].required)

    def test_a_before_round_question_is_not_due_until_its_round_starts(self):
        self.assertFalse(self._questions(answers={})["r1.song"].due)
        self.assertTrue(self._questions(answers={}, due_rounds=frozenset({"r1"}))["r1.song"].due)


class _RegistrationBase(_CharacterizationBase):
    def operator(self):
        from accounts.models import User

        cached = getattr(self, "_operator_user", None)
        if cached is not None:
            return cached
        user = self.make_user(f"reg-admin-{uuid4().hex[:8]}")
        user.role = User.Role.ADMIN
        with authority_write(ACCOUNT_AUTHORITY):
            user.save()
        self._operator_user = user
        return user

    def frozen_version(self):
        # Registration is open, because these tests are about registering: submitting a
        # form during rehearsal is not a thing the lifecycle allows.
        activity = self.make_activity(
            is_test_mode=True,
            phase=Activity.Phase.REGISTRATION_OPEN,
            title=f"报名-{uuid4().hex[:6]}",
        )
        ruleset = ContestRuleset.objects.create(activity=activity, name="RS", is_test_data=True)
        binding = {}
        for key in ("r1", "r3"):
            rubric = ScoringRubric.objects.create(
                activity=activity, name=f"{key}评分", is_test_data=True
            )
            RubricCriterion.objects.create(
                rubric=rubric, name="总分", max_score=100, is_test_data=True
            )
            contest_round = ContestRound.objects.create(
                activity=activity, round_type=ContestRound.RoundType.PRELIMINARY, name=key
            )
            contest_round.rubric = rubric
            contest_round.save(update_fields=["rubric"])
            binding[key] = contest_round.pk
        ruleset.round_keys = binding
        ruleset.save(update_fields=["round_keys"])
        for i in range(3):
            self.make_singer(
                activity,
                username=f"reg-field-{activity.pk}-{i}",
                student_id=f"90{i:04d}",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            )
        root = json.loads(_definition())
        root["questionnaire"] = QUESTIONNAIRE
        version = RulesetVersion.objects.create(
            ruleset=ruleset, definition=json.dumps(root, ensure_ascii=False)
        )
        freeze_ruleset_version(version, self.operator())
        version.refresh_from_db()
        return version

    def participant(self, activity, index=99):
        return self.make_user(f"reg-singer-{activity.pk}-{index}")

    def draft(self):
        version = self.frozen_version()
        activity = version.ruleset.activity
        registration, response = get_or_create_draft_registration(
            version=version, user=self.participant(activity)
        )
        return version, registration, response


class MissingRequiredTests(_RegistrationBase):
    def test_only_visible_due_required_questions_can_be_missing(self):
        _version, registration, _response = self.draft()
        # `name` is required and unanswered; `r1.song` is not due yet; `r3.guest_name`
        # is hidden, so its required_if does not bite.
        self.assertEqual(
            missing_required(
                PLAN, registration=registration, answers={}, context={}, due_rounds=frozenset()
            ),
            ["name"],
        )

    def test_a_bound_answer_reads_from_the_registration_not_from_answers(self):
        _version, registration, _response = self.draft()
        registration.name = "陈昭艺"
        registered = missing_required(
            PLAN, registration=registration, answers={}, context={}, due_rounds=frozenset()
        )
        self.assertEqual(registered, [])

    def test_a_question_becomes_missing_once_its_round_starts(self):
        _version, registration, _response = self.draft()
        registration.name = "陈"
        self.assertEqual(
            missing_required(
                PLAN,
                registration=registration,
                answers={},
                context={},
                due_rounds=frozenset({"r1"}),
            ),
            ["r1.song"],
        )

    def test_a_hidden_question_is_never_missing(self):
        _version, registration, _response = self.draft()
        registration.name = "陈"
        self.assertEqual(
            missing_required(
                PLAN,
                registration=registration,
                answers={},
                context={},
                due_rounds=frozenset({"r1", "r3"}),
            ),
            ["r1.song"],
        )


class DraftRegistrationTests(_RegistrationBase):
    def test_first_open_creates_a_draft_registration_and_its_response(self):
        version, registration, response = self.draft()
        self.assertEqual(registration.pre_status, SingerRegistration.PreStatus.DRAFT)
        self.assertEqual(response.status, "draft")
        self.assertEqual(response.questionnaire_key, "singer_submission")
        self.assertEqual(response.schema_hash, schema_hash(QUESTIONNAIRE))
        self.assertEqual(response.ruleset_version_id, version.pk)

    def test_a_draft_does_not_join_the_approved_roster(self):
        version = self.frozen_version()
        activity = version.ruleset.activity
        before = SingerRegistration.objects.filter(
            activity=activity, pre_status=SingerRegistration.PreStatus.APPROVED
        ).count()
        get_or_create_draft_registration(version=version, user=self.participant(activity))
        after = SingerRegistration.objects.filter(
            activity=activity, pre_status=SingerRegistration.PreStatus.APPROVED
        ).count()
        self.assertEqual(before, after)

    def test_reopening_the_form_reuses_the_same_draft(self):
        version = self.frozen_version()
        activity = version.ruleset.activity
        user = self.participant(activity)
        first_registration, first_response = get_or_create_draft_registration(
            version=version, user=user
        )
        second_registration, second_response = get_or_create_draft_registration(
            version=version, user=user
        )
        self.assertEqual(first_registration.pk, second_registration.pk)
        self.assertEqual(first_response.pk, second_response.pk)

    def test_two_participants_can_hold_drafts_at_once(self):
        """A draft has no student id yet, and that must not collide with the next person."""
        version = self.frozen_version()
        activity = version.ruleset.activity
        for index in (1, 2):
            get_or_create_draft_registration(
                version=version, user=self.participant(activity, index)
            )
        self.assertEqual(SingerRegistration.objects.filter(activity=activity).count(), 2 + 3)


class SubmissionContextTests(_RegistrationBase):
    def test_the_context_carries_server_facts_and_nothing_a_browser_supplied(self):
        """There is no parameter to forge: the context is read from the activity and the
        roster, so a browser cannot assert its own phase or its own qualification."""
        version, registration, _response = self.draft()
        activity = version.ruleset.activity
        context = build_submission_context(version=version, registration=registration)
        self.assertEqual(context["activity.phase"], activity.phase)
        self.assertFalse(context["qualified.r1"])


class SubmitTests(_RegistrationBase):
    def _submit(self, version, registration, answers, due_rounds=frozenset()):
        return submit_registration(
            version=version, registration=registration, answers=answers, due_rounds=due_rounds
        )

    def test_submit_is_refused_while_a_required_answer_is_missing(self):
        version, registration, _response = self.draft()
        with self.assertRaises(ValidationError):
            self._submit(version, registration, {})

    def test_a_refused_submit_keeps_what_was_already_filled(self):
        from .services import save_draft_answers

        version, registration, response = self.draft()
        save_draft_answers(response, answers={"r1.song": "歌"})
        with self.assertRaises(ValidationError):
            self._submit(version, registration, {})
        response.refresh_from_db()
        self.assertEqual(response.answers.get("r1.song"), "歌")

    def test_submit_writes_bound_answers_onto_the_registration(self):
        version, registration, _response = self.draft()
        self._submit(version, registration, {"name": "陈昭艺", "r1.song": "美丽的神话"})
        registration.refresh_from_db()
        self.assertEqual(registration.name, "陈昭艺")

    def test_unbound_answers_stay_in_the_response(self):
        version, registration, response = self.draft()
        self._submit(version, registration, {"name": "陈", "r1.song": "歌"})
        response.refresh_from_db()
        self.assertEqual(response.answers.get("r1.song"), "歌")

    def test_submit_marks_both_the_registration_and_the_response(self):
        version, registration, response = self.draft()
        self._submit(version, registration, {"name": "陈", "r1.song": "歌"})
        registration.refresh_from_db()
        response.refresh_from_db()
        self.assertEqual(registration.pre_status, SingerRegistration.PreStatus.SUBMITTED)
        self.assertEqual(response.status, "submitted")
        self.assertIsNotNone(response.submitted_at)

    def test_submit_records_the_schema_hash_it_validated_against(self):
        version, registration, response = self.draft()
        self._submit(version, registration, {"name": "陈"})
        response.refresh_from_db()
        self.assertEqual(response.schema_hash, schema_hash(QUESTIONNAIRE))

    def test_submit_ignores_a_bound_key_smuggled_in_through_answers(self):
        """A browser may post anything; only the questionnaire's own questions are read."""
        version, registration, response = self.draft()
        self._submit(version, registration, {"name": "陈", "registration.student_id": "99999999"})
        registration.refresh_from_db()
        self.assertEqual(registration.student_id, "")

    def test_submit_needs_the_versions_frozen_authority(self):
        """A superscript draft is not an authority to submit against."""
        version, registration, _response = self.draft()
        successor = RulesetVersion.objects.create(
            ruleset=version.ruleset, version=2, definition=version.definition
        )
        self.assertEqual(successor.status, RulesetVersion.Status.DRAFT)
        with self.assertRaises(ValidationError):
            self._submit(successor, registration, {"name": "陈"})
