"""P9 — what carries across a questionnaire version, and what may not.

The case this exists for is ordinary: registration is open, ten people have filled their
details in, and someone realises a question is missing. Superseding the ruleset must not
ask all ten to start again.

What carries is decided by the stable key **and** by whether the question still means the
same thing. A key that exists on both sides with the same type, binding and file purpose
carries its answer; a new key contributes nothing and is simply missing; and a key that
changes meaning — a file question becoming a text one, an accompaniment becoming a
background video — is refused outright. Silently reusing the slot is how a participant's
file ends up answering a question it was never uploaded for.

File answers need no carrying at all: they are identified by ``question_key`` and read
through ``is_current``, so the second round's accompaniment still answers the second
round's question in the next version. Bound answers are already on the registration. Only
the free-text answers move, and they move into a response of their own — one row per
version, so the old one keeps its audit trail.
"""

from __future__ import annotations

from django.core.exceptions import ValidationError

from .compiler import QuestionnairePlan


def question_semantics(question: dict) -> tuple:
    """What a question *means*, apart from its label and description.

    The label is deliberately excluded: renaming "第一轮曲目" is an edit staff make freely,
    and it must not cost ten participants their answer. The type is included, and so is a
    file question's purpose — those are what the stored value has to be compatible with.
    """
    return (
        question["type"],
        question.get("binding"),
        (question.get("file") or {}).get("purpose"),
    )


def _semantics_by_key(plan: QuestionnairePlan) -> dict[str, tuple]:
    return {question["key"]: question_semantics(question) for question in plan.questions}


def carry_over_keys(previous: QuestionnairePlan, current: QuestionnairePlan) -> frozenset[str]:
    """Keys present on both sides that still mean the same thing."""
    before = _semantics_by_key(previous)
    return frozenset(
        key for key, semantics in _semantics_by_key(current).items() if before.get(key) == semantics
    )


def incompatible_keys(previous: QuestionnairePlan, current: QuestionnairePlan) -> list[str]:
    """Keys reused with a different meaning — the redefinitions a successor may not make."""
    before = _semantics_by_key(previous)
    return sorted(
        key
        for key, semantics in _semantics_by_key(current).items()
        if key in before and before[key] != semantics
    )


def validate_successor(previous: QuestionnairePlan, current: QuestionnairePlan) -> None:
    """Refuse a successor that redefines a key instead of adding a new one."""
    reused = incompatible_keys(previous, current)
    if reused:
        raise ValidationError(
            f"同 key 不得改变基础语义：{'、'.join(reused)}。"
            "请为新的含义新建 key（例如 r2.accompaniment_v2），否则旧答案会被当成新题的答案。"
        )


def carry_answers(previous: QuestionnairePlan, current: QuestionnairePlan, answers) -> dict:
    """The subset of ``answers`` that still means the same thing under ``current``."""
    keys = carry_over_keys(previous, current)
    return {key: value for key, value in (answers or {}).items() if key in keys}
