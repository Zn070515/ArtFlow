"""P1 — the Questionnaire DSL's compiler gate.

A questionnaire is a second, independent DSL inside the ruleset definition root (see
``ruleset.services.update_ruleset_definition_section``): it has its own ``schema_version``
so it can evolve without touching the flow DSL. Nothing here executes — this module only
proves a questionnaire is *well-formed* and produces the canonical plan later phases
(freeze integration, response validation, rendering) read.

The rules the gate enforces, from the Questionnaire workflow spec:

- keys are unique per scope (page, section, question) to prevent an ambiguous answer slot;
- only registered question types, condition operators, file purposes, and bindings;
- a condition may only reference questions that appear *before* it (forward-only), which
  makes cyclic visibility and cyclic required-ness structurally impossible;
- a participant-facing question may never bind a staff-only registration field;
- a file question's ``max_mb`` may not exceed the server's hard limit;
- the same JSON always canonicalises to the same plan and the same ``schema_hash``, so a
  hash comparison can stand in for "has this questionnaire changed".
"""

import json

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from questionnaire.compiler import compile_questionnaire
from questionnaire.schema import parse_questionnaire, schema_hash


def _question(key, **overrides):
    question = {"key": key, "type": "text", "label": key}
    question.update(overrides)
    return question


def _questionnaire(questions, *, key="singer_submission", pages=None):
    if pages is None:
        pages = [
            {
                "key": "basic",
                "title": "基本信息",
                "sections": [{"key": "identity", "title": "身份", "questions": questions}],
            }
        ]
    return {"schema_version": 1, "key": key, "pages": pages}


class QuestionnaireParseTests(SimpleTestCase):
    def test_minimal_questionnaire_parses(self):
        parsed = parse_questionnaire(_questionnaire([_question("name")]))
        self.assertEqual(parsed["schema_version"], 1)
        self.assertEqual(parsed["key"], "singer_submission")

    def test_duplicate_question_key_fails(self):
        bad = _questionnaire([_question("r2.song"), _question("r2.song")])
        self.assertRaises(ValidationError, parse_questionnaire, bad)

    def test_duplicate_page_key_fails(self):
        page = {"key": "basic", "title": "一", "sections": []}
        bad = _questionnaire([_question("a")], pages=[page, dict(page)])
        self.assertRaises(ValidationError, parse_questionnaire, bad)

    def test_duplicate_section_key_fails(self):
        section = {"key": "identity", "title": "身份", "questions": [_question("a")]}
        bad = _questionnaire(
            [], pages=[{"key": "p", "title": "P", "sections": [section, dict(section)]}]
        )
        self.assertRaises(ValidationError, parse_questionnaire, bad)

    def test_unknown_question_type_fails(self):
        bad = _questionnaire([_question("a", type="signature")])
        self.assertRaises(ValidationError, parse_questionnaire, bad)

    def test_unsupported_schema_version_fails(self):
        bad = _questionnaire([_question("a")])
        bad["schema_version"] = 99
        self.assertRaises(ValidationError, parse_questionnaire, bad)

    def test_bad_round_key_format_fails(self):
        bad = _questionnaire([_question("a", round="round-one")])
        self.assertRaises(ValidationError, parse_questionnaire, bad)

    def test_duplicate_choice_options_fail(self):
        bad = _questionnaire(
            [
                _question(
                    "a",
                    type="single_choice",
                    options=[{"value": "yes", "label": "是"}, {"value": "yes", "label": "否"}],
                )
            ]
        )
        self.assertRaises(ValidationError, parse_questionnaire, bad)

    def test_duplicate_bindings_fail_during_compilation(self):
        bad = _questionnaire(
            [
                _question("name_a", binding="registration.name"),
                _question("name_b", binding="registration.name"),
            ]
        )
        self.assertRaises(ValidationError, compile_questionnaire, bad)

    def test_staff_audience_is_rejected_until_a_staff_viewer_contract_exists(self):
        bad = _questionnaire([_question("internal", audience="staff")])
        self.assertRaises(ValidationError, parse_questionnaire, bad)

    def test_validation_domain_is_normalized_and_unknown_fields_fail(self):
        parsed = parse_questionnaire(
            _questionnaire(
                [
                    _question(
                        "phone",
                        validation={"format": "phone_cn", "max_length": 11},
                    )
                ]
            )
        )
        self.assertEqual(
            parsed["pages"][0]["sections"][0]["questions"][0]["validation"],
            {"format": "phone_cn", "max_length": 11},
        )
        with self.assertRaises(ValidationError):
            parse_questionnaire(_questionnaire([_question("phone", validation={"unknown": True})]))


class QuestionnaireBindingTests(SimpleTestCase):
    def test_whitelisted_binding_is_accepted(self):
        parsed = parse_questionnaire(
            _questionnaire([_question("name", binding="registration.name")])
        )
        question = parsed["pages"][0]["sections"][0]["questions"][0]
        self.assertEqual(question["binding"], "registration.name")

    def test_illegal_binding_fails(self):
        bad = _questionnaire([_question("phase", binding="activity.phase")])
        self.assertRaises(ValidationError, parse_questionnaire, bad)

    def test_staff_only_registration_field_is_not_bindable(self):
        """``pre_status``/``live_status`` are staff decisions, not participant answers."""
        for field in ("registration.pre_status", "registration.live_status", "user.role"):
            with self.subTest(field=field):
                self.assertRaises(
                    ValidationError,
                    parse_questionnaire,
                    _questionnaire([_question("x", binding=field)]),
                )


class QuestionnaireConditionTests(SimpleTestCase):
    def test_condition_on_an_earlier_question_is_accepted(self):
        parsed = parse_questionnaire(
            _questionnaire(
                [
                    _question("r3.has_guest", type="boolean"),
                    _question(
                        "r3.guest_name",
                        visible_if={
                            "all": [
                                {
                                    "source": "answer",
                                    "key": "r3.has_guest",
                                    "op": "eq",
                                    "value": True,
                                }
                            ]
                        },
                    ),
                ]
            )
        )
        self.assertEqual(len(parsed["pages"][0]["sections"][0]["questions"]), 2)

    def test_forward_condition_fails(self):
        bad = _questionnaire(
            [
                _question(
                    "r3.guest_name",
                    visible_if={
                        "all": [
                            {"source": "answer", "key": "r3.has_guest", "op": "eq", "value": True}
                        ]
                    },
                ),
                _question("r3.has_guest", type="boolean"),
            ]
        )
        self.assertRaises(ValidationError, parse_questionnaire, bad)

    def test_unknown_operator_fails(self):
        bad = _questionnaire(
            [
                _question("a", type="boolean"),
                _question(
                    "b",
                    visible_if={
                        "all": [{"source": "answer", "key": "a", "op": "matches", "value": "x"}]
                    },
                ),
            ]
        )
        self.assertRaises(ValidationError, parse_questionnaire, bad)

    def test_unknown_condition_source_fails(self):
        bad = _questionnaire(
            [
                _question("a", type="boolean"),
                _question(
                    "b",
                    visible_if={
                        "all": [{"source": "browser", "key": "a", "op": "eq", "value": True}]
                    },
                ),
            ]
        )
        self.assertRaises(ValidationError, parse_questionnaire, bad)

    def test_context_sourced_condition_is_allowed(self):
        parsed = parse_questionnaire(
            _questionnaire(
                [
                    _question(
                        "r3.guest_name",
                        visible_if={
                            "all": [
                                {
                                    "source": "context",
                                    "key": "qualified.r3",
                                    "op": "eq",
                                    "value": True,
                                }
                            ]
                        },
                    )
                ]
            )
        )
        self.assertEqual(parsed["pages"][0]["sections"][0]["questions"][0]["key"], "r3.guest_name")


class QuestionnaireFileTests(SimpleTestCase):
    def _file_question(self, **file_overrides):
        config = {
            "purpose": "accompaniment",
            "extensions": [".mp3", ".wav"],
            "max_mb": 100,
            "max_files": 1,
        }
        config.update(file_overrides)
        return _question("r2.accompaniment", type="file", required=True, file=config)

    def test_registered_file_purpose_is_accepted(self):
        parsed = parse_questionnaire(_questionnaire([self._file_question()]))
        question = parsed["pages"][0]["sections"][0]["questions"][0]
        self.assertEqual(question["file"]["purpose"], "accompaniment")

    def test_illegal_file_purpose_fails(self):
        self.assertRaises(
            ValidationError,
            parse_questionnaire,
            _questionnaire([self._file_question(purpose="任意用途")]),
        )

    def test_oversized_max_mb_fails(self):
        self.assertRaises(
            ValidationError,
            parse_questionnaire,
            _questionnaire([self._file_question(max_mb=10_000)]),
        )

    def test_file_question_without_config_fails(self):
        self.assertRaises(
            ValidationError,
            parse_questionnaire,
            _questionnaire([_question("r2.accompaniment", type="file")]),
        )


class QuestionnairePlanTests(SimpleTestCase):
    def test_plan_lists_questions_in_document_order(self):
        plan = compile_questionnaire(
            _questionnaire(
                [
                    _question("name"),
                    _question("r1.song"),
                    _question("r1.accompaniment", type="text"),
                ]
            )
        )
        self.assertEqual(
            [q["key"] for q in plan.questions], ["name", "r1.song", "r1.accompaniment"]
        )

    def test_canonical_plan_and_hash_are_stable_across_object_key_order(self):
        """Canonicalisation ignores JSON *object* key order — not list order, which is the
        document order the participant actually sees and must be preserved."""
        first = _questionnaire(
            [_question("r1.song", round="r1"), _question("r1.note", type="textarea")]
        )
        second = {"pages": first["pages"], "key": first["key"], "schema_version": 1}
        self.assertEqual(schema_hash(first), schema_hash(second))
        self.assertEqual(
            [q["key"] for q in compile_questionnaire(first).questions],
            [q["key"] for q in compile_questionnaire(second).questions],
        )

    def test_identical_json_yields_identical_schema_hash(self):
        definition = _questionnaire([_question("r1.song", round="r1")])
        self.assertEqual(schema_hash(definition), schema_hash(json.loads(json.dumps(definition))))

    def test_changing_a_label_changes_the_schema_hash(self):
        """P2's premise: the questionnaire rides inside the ruleset definition, so editing a
        question must move the questionnaire hash (and, through it, the ruleset content
        hash)."""
        first = _questionnaire([_question("r1.song", label="第一轮曲目")])
        second = _questionnaire([_question("r1.song", label="第二轮曲目")])
        self.assertNotEqual(schema_hash(first), schema_hash(second))

    def test_notice_blocks_are_not_answerable_questions(self):
        plan = compile_questionnaire(
            _questionnaire(
                [
                    {"key": "r3.notice", "type": "notice", "label": "以下材料可提前提交"},
                    _question("r3.song", round="r3"),
                ]
            )
        )
        self.assertEqual([q["key"] for q in plan.questions], ["r3.song"])
        self.assertEqual([n["key"] for n in plan.notices], ["r3.notice"])
