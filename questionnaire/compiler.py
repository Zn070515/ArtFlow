"""Compile a questionnaire into the canonical ``QuestionnairePlan`` (§P1).

This is the counterpart of :func:`ruleset.compiler.compile_definition` for the flow DSL:
it turns a validated questionnaire into the single structure the rest of the system reads,
so that the renderer, the response validator, and the file upload path all agree on what
questions exist, in what order, and under what keys.

Like the flow compiler it is pure — no database reads. Cross-domain checks (does the
question's ``round`` exist in the frozen ruleset's round binding?) happen at freeze time
(§P2), where both halves are in hand.

``schema_hash`` is computed over the *normalized* form, so two documents that differ only
in whitespace, key order, or unknown extra fields are the same questionnaire — which is
what makes the hash usable as "has this changed?" rather than "were these bytes equal?".
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .schema import FILE_TYPE, parse_questionnaire, schema_hash


@dataclass(frozen=True)
class QuestionnairePlan:
    """The canonical, order-preserving view of one questionnaire."""

    key: str
    schema_version: int
    schema_hash: str
    pages: tuple[dict, ...]
    questions: tuple[dict, ...]
    notices: tuple[dict, ...]
    file_questions: tuple[dict, ...]
    # ``binding -> question key``. A binding may be claimed by at most one question, which
    # the gate enforces; responses write straight through to the bound registration field.
    bindings: Mapping[str, str] = field(default_factory=dict)

    def question(self, key: str) -> dict | None:
        for question in self.questions:
            if question["key"] == key:
                return question
        return None

    def questions_for_round(self, round_key: str) -> tuple[dict, ...]:
        return tuple(q for q in self.questions if q.get("round") == round_key)

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "schema_version": self.schema_version,
            "schema_hash": self.schema_hash,
            "pages": list(self.pages),
            "questions": [dict(q) for q in self.questions],
            "notices": [dict(n) for n in self.notices],
            "bindings": dict(self.bindings),
        }


def compile_questionnaire(questionnaire: dict | str | None) -> QuestionnairePlan:
    """Validate ``questionnaire`` and return its canonical plan."""
    parsed = parse_questionnaire(questionnaire)
    questions = [
        question
        for page in parsed["pages"]
        for section in page["sections"]
        for question in section["questions"]
    ]
    bindings: dict[str, str] = {}
    for question in questions:
        binding = question.get("binding")
        if binding:
            bindings[binding] = question["key"]
    return QuestionnairePlan(
        key=parsed["key"],
        schema_version=parsed["schema_version"],
        schema_hash=schema_hash(parsed),
        pages=tuple(parsed["pages"]),
        questions=tuple(questions),
        notices=tuple(parsed["notices"]),
        file_questions=tuple(q for q in questions if q["type"] == FILE_TYPE),
        bindings=bindings,
    )
