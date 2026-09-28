"""Reading a compiled questionnaire against one participant's current answers (§P3/P4).

The compiler says what the questionnaire *is*; this says what it means for one person
right now — which questions they can see, which of those are due, which of those are
required, and which of those are still unanswered.

Two rules do most of the work:

- **required-ness is conditional on visibility.** A question hidden by its own
  ``visible_if`` can never be missing, however its ``required``/``required_if`` reads.
  Without this, a completion counter would demand an answer the form never showed.
- **due-ness is separate from required-ness.** A ``before_round`` question is shown early
  but is not owed until its round starts, which is what lets the form say "第三轮 2 / 4"
  instead of marking next month's material as missing today.

A bound question's value lives on the registration, never in ``answers``: there is one
copy of "what is your name" and it is the one the rest of the system already reads.
"""

from __future__ import annotations

from dataclasses import dataclass

from django.core.exceptions import ValidationError

from .compiler import QuestionnairePlan
from .conditions import evaluate_condition, is_blank
from .schema import FILE_TYPE

REGISTRATION_PREFIX = "registration"


@dataclass(frozen=True)
class ResolvedQuestion:
    """One question as it stands for one participant: visible, required, due."""

    question: dict
    visible: bool
    required: bool
    due: bool


def binding_value(registration, binding: str):
    """Read a whitelisted ``registration.<field>`` binding off the registration row."""
    prefix, _, field = binding.partition(".")
    if prefix != REGISTRATION_PREFIX:
        raise ValidationError(f"未知的绑定前缀：{binding!r}。")
    if registration is None:
        return None
    return getattr(registration, field, None)


def resolve_question_value(question: dict, *, answers, registration=None, files=None):
    """A question's current value, from whichever store owns it.

    Binding first, then file, then the response — in that order and nowhere else, so a
    bound question cannot also be answered into the JSON and drift.
    """
    binding = question.get("binding")
    if binding:
        return binding_value(registration, binding)
    if question["type"] == FILE_TYPE:
        # A file answer lives on ``SubmissionFile`` under its ``question_key``; that column
        # arrives with the submission-file migration (§P5). Until then a file question
        # reads as unanswered, which is the honest state — nothing stores it yet.
        return (files or {}).get(question["key"])
    return answers.get(question["key"])


def _is_due(question: dict, due_rounds: frozenset[str] | set[str]) -> bool:
    due = question.get("due")
    if not due or due["mode"] == "upfront":
        return True
    return due.get("round") in due_rounds


def resolve_questions(
    plan: QuestionnairePlan,
    *,
    answers,
    context,
    due_rounds: frozenset[str] | set[str] = frozenset(),
) -> tuple[ResolvedQuestion, ...]:
    resolved = []
    for question in plan.questions:
        visible = evaluate_condition(question.get("visible_if"), answers=answers, context=context)
        declared = bool(question.get("required")) or (
            question.get("required_if") is not None
            and evaluate_condition(question["required_if"], answers=answers, context=context)
        )
        resolved.append(
            ResolvedQuestion(
                question=question,
                visible=visible,
                required=visible and declared,
                due=visible and _is_due(question, due_rounds),
            )
        )
    return tuple(resolved)


def completion_summary(
    plan: QuestionnairePlan,
    *,
    registration,
    answers,
    context,
    due_rounds: frozenset[str] | set[str] = frozenset(),
    files=None,
) -> dict:
    """How far along one participant is, per group and overall.

    Counted over the questions the participant can actually see, and split into what is
    owed now and what is merely shown early. "Answered / total questions" would be wrong in
    both directions: it would mark next month's material as missing today, and it would
    count questions hidden by their own condition — which the participant has never been
    asked and cannot answer.
    """
    groups: dict[str, dict[str, int]] = {}
    totals = {"answered": 0, "required": 0, "upcoming": 0}
    for resolved in resolve_questions(
        plan, answers=answers, context=context, due_rounds=due_rounds
    ):
        if not resolved.visible:
            continue
        question = resolved.question
        group = question.get("round") or "basic"
        bucket = groups.setdefault(group, {"answered": 0, "required": 0, "upcoming": 0})
        value = resolve_question_value(
            question, answers=answers, registration=registration, files=files
        )
        if not is_blank(value):
            bucket["answered"] += 1
            totals["answered"] += 1
        if resolved.required and resolved.due:
            bucket["required"] += 1
            totals["required"] += 1
        elif resolved.required:
            bucket["upcoming"] += 1
            totals["upcoming"] += 1
    return {"groups": groups, **totals}


def missing_required(
    plan: QuestionnairePlan,
    *,
    registration,
    answers,
    context,
    due_rounds: frozenset[str] | set[str] = frozenset(),
    files=None,
) -> list[str]:
    """The question keys a submission still owes, in document order."""
    missing = []
    for resolved in resolve_questions(
        plan, answers=answers, context=context, due_rounds=due_rounds
    ):
        if not (resolved.visible and resolved.due and resolved.required):
            continue
        value = resolve_question_value(
            resolved.question, answers=answers, registration=registration, files=files
        )
        if is_blank(value):
            missing.append(resolved.question["key"])
    return missing
