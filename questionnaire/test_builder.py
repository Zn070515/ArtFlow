"""P8 — the builder's operations on a questionnaire document.

The builder edits the same JSON the compiler reads, and every operation it performs must
leave a document that still parses. Two of them carry a real rule rather than a shape:

- **duplicating generates a new stable key.** The key *is* the answer's identity — the
  file slot, the response entry, the carry-over across versions — so a copy that reused it
  would silently merge two answers into one.
- **deleting a question another question's condition names is refused.** The compiler
  would fail on the forward reference anyway, but the editor is where the operator can be
  told why, before the document is saved broken.
"""

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from .builder import (
    DEFAULT_KEYS,
    add_question,
    delete_question,
    duplicate_question,
    move_question,
    referenced_keys,
)
from .schema import FILE_PURPOSES, parse_questionnaire

QUESTIONNAIRE = {
    "schema_version": 1,
    "key": "singer_submission",
    "pages": [
        {
            "key": "basic",
            "title": "基本信息",
            "sections": [
                {"key": "identity", "title": "身份", "questions": []},
                {"key": "round3", "title": "第三轮", "questions": []},
            ],
        }
    ],
}


def _with_condition():
    document = parse_questionnaire(QUESTIONNAIRE)
    document = add_question(
        document, section_key="round3", question_type="boolean", key="r3.has_guest"
    )
    document = add_question(
        document, section_key="round3", question_type="text", key="r3.guest_name"
    )
    question = document["pages"][0]["sections"][1]["questions"][1]
    gate = {"all": [{"source": "answer", "key": "r3.has_guest", "op": "eq", "value": True}]}
    question["visible_if"] = gate
    question["required_if"] = gate
    return parse_questionnaire(document)


def _keys(document, section_key):
    for section in document["pages"][0]["sections"]:
        if section["key"] == section_key:
            return [q["key"] for q in section["questions"]]
    return []


class BuilderOperationTests(SimpleTestCase):
    def test_a_new_question_carries_a_key_and_a_label(self):
        document = add_question(
            parse_questionnaire(QUESTIONNAIRE), section_key="identity", question_type="text"
        )
        question = document["pages"][0]["sections"][0]["questions"][0]
        self.assertEqual(question["type"], "text")
        self.assertTrue(question["key"])
        self.assertTrue(question["label"])
        # The document it returns is one the compiler will accept.
        parse_questionnaire(document)

    def test_every_question_type_the_designer_offers_can_be_created(self):
        document = parse_questionnaire(QUESTIONNAIRE)
        for question_type in DEFAULT_KEYS:
            with self.subTest(question_type=question_type):
                document = add_question(
                    document, section_key="identity", question_type=question_type
                )
        self.assertEqual(len(_keys(document, "identity")), len(DEFAULT_KEYS))
        parse_questionnaire(document)

    def test_a_generated_key_does_not_collide_with_an_existing_one(self):
        document = parse_questionnaire(QUESTIONNAIRE)
        first = add_question(document, section_key="identity", question_type="text")
        second = add_question(first, section_key="identity", question_type="text")
        keys = _keys(second, "identity")
        self.assertEqual(len(keys), 2)
        self.assertEqual(len(set(keys)), 2)
        parse_questionnaire(second)

    def test_an_explicit_key_that_is_already_taken_is_refused(self):
        """Silently renaming a key the caller chose would break the very identity the key
        exists to carry."""
        document = add_question(
            parse_questionnaire(QUESTIONNAIRE), section_key="identity", question_type="text"
        )
        with self.assertRaises(ValidationError):
            add_question(document, section_key="identity", question_type="text", key="identity")


class DuplicateTests(SimpleTestCase):
    def test_duplicating_gets_a_new_stable_key(self):
        document = _with_condition()
        copied = duplicate_question(document, key="r3.guest_name")
        keys = _keys(copied, "round3")
        self.assertEqual(len(keys), 3)
        self.assertEqual(len(set(keys)), 3)
        self.assertIn("r3.guest_name", keys)
        parse_questionnaire(copied)

    def test_a_duplicate_drops_the_conditions_it_was_gated_by(self):
        """A copy that kept ``visible_if: r3.has_guest`` would be hidden by a sibling it no
        longer sits beside; the operator re-attaches a condition deliberately."""
        document = _with_condition()
        copied = duplicate_question(document, key="r3.guest_name")
        self.assertNotIn("visible_if", copied["pages"][0]["sections"][1]["questions"][2])

    def test_duplicating_leaves_the_original_alone(self):
        document = _with_condition()
        duplicate_question(document, key="r3.guest_name")
        original = document["pages"][0]["sections"][1]["questions"][1]
        self.assertIn("visible_if", original)
        self.assertEqual(original["key"], "r3.guest_name")


class DeleteTests(SimpleTestCase):
    def test_deleting_removes_the_question(self):
        document = _with_condition()
        trimmed = delete_question(document, key="r3.guest_name")
        self.assertEqual(_keys(trimmed, "round3"), ["r3.has_guest"])
        parse_questionnaire(trimmed)

    def test_deleting_a_question_a_condition_names_is_refused(self):
        document = _with_condition()
        with self.assertRaises(ValidationError) as caught:
            delete_question(document, key="r3.has_guest")
        self.assertIn("r3.guest_name", str(caught.exception))

    def test_the_refusal_names_every_dependent(self):
        document = _with_condition()
        document = add_question(
            document, section_key="round3", question_type="text", key="r3.other"
        )
        question = document["pages"][0]["sections"][1]["questions"][2]
        question["visible_if"] = {
            "all": [{"source": "answer", "key": "r3.has_guest", "op": "eq", "value": True}]
        }
        document = parse_questionnaire(document)
        with self.assertRaises(ValidationError) as caught:
            delete_question(document, key="r3.has_guest")
        message = str(caught.exception)
        self.assertIn("r3.guest_name", message)
        self.assertIn("r3.other", message)


class MoveTests(SimpleTestCase):
    def _with_free_question(self):
        return add_question(
            _with_condition(), section_key="round3", question_type="text", key="r3.song"
        )

    def test_moving_reorders_within_its_section(self):
        document = self._with_free_question()
        moved = move_question(document, key="r3.song", delta=-1)
        self.assertEqual(_keys(moved, "round3"), ["r3.has_guest", "r3.song", "r3.guest_name"])
        parse_questionnaire(moved)

    def test_moving_a_gated_pair_together_is_allowed(self):
        """The pair keeps its relative order, so the condition still points backwards."""
        document = self._with_free_question()
        moved = move_question(document, key="r3.song", delta=2)
        self.assertEqual(_keys(moved, "round3"), ["r3.has_guest", "r3.guest_name", "r3.song"])

    def test_moving_a_conditioned_question_above_its_source_is_refused(self):
        """Forward-only is what makes cyclic visibility impossible, so the editor cannot
        let the operator create the cycle and then blame the compiler."""
        document = _with_condition()
        # Pushing the gate below its dependent makes the dependent forward-reference it.
        with self.assertRaises(ValidationError):
            move_question(document, key="r3.has_guest", delta=1)

    def test_moving_past_the_edge_is_a_no_op(self):
        document = _with_condition()
        self.assertEqual(
            _keys(move_question(document, key="r3.has_guest", delta=-1), "round3"),
            ["r3.has_guest", "r3.guest_name"],
        )


class ReferencedKeysTests(SimpleTestCase):
    def test_it_reports_every_key_a_condition_names(self):
        document = _with_condition()
        self.assertEqual(referenced_keys(document), {"r3.has_guest"})

    def test_a_document_with_no_conditions_references_nothing(self):
        self.assertEqual(referenced_keys(parse_questionnaire(QUESTIONNAIRE)), set())


class FilePurposeAgreementTests(SimpleTestCase):
    def test_the_questionnaire_purpose_list_is_exactly_what_files_can_police(self):
        """A questionnaire may name a technical file type the upload path knows how to
        check, and may not invent one the ``files`` app would refuse at upload time."""
        from files.models import SubmissionFile

        self.assertEqual(FILE_PURPOSES, {value for value, _label in SubmissionFile.Purpose.choices})
