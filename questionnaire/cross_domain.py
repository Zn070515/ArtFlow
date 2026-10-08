"""Cross-domain validation between the questionnaire and the frozen ruleset (§P2).

Neither compiler can see the other's world, so the facts that live *between* them are
checked here, at freeze time, where both halves are in hand. There is exactly one:

    a question may only bind a round the ruleset actually binds to a ContestRound
    of the activity.

Deliberately **not** checked: that the round has an ``ASSESS`` node. A round that only
collects material — a guest singer's name, a lyric sheet, a stage plot — is a legal round
and always will be, so the round namespace belongs to the ruleset's round binding, not to
the flow graph's node list.
"""

from __future__ import annotations

from collections.abc import Mapping, Set

from django.core.exceptions import ValidationError

from .compiler import QuestionnairePlan


def referenced_round_keys(plan: QuestionnairePlan) -> frozenset[str]:
    """Every round a question binds, or is due before."""
    keys = {q["round"] for q in plan.questions if q.get("round")}
    keys |= {
        q["due"]["round"]
        for q in plan.questions
        if isinstance(q.get("due"), dict) and q["due"].get("mode") == "before_round"
    }
    return frozenset(keys)


def validate_questionnaire_rounds(plan: QuestionnairePlan, bound_round_keys: Mapping | Set) -> None:
    """Refuse a questionnaire that names a round the ruleset does not bind."""
    missing = sorted(referenced_round_keys(plan) - set(bound_round_keys))
    if missing:
        raise ValidationError(f"问卷引用了赛制未绑定的轮次：{missing}。")


def _context_keys_in(condition) -> set[str]:
    if not condition:
        return set()
    for combinator in ("all", "any"):
        if combinator in condition:
            keys: set[str] = set()
            for child in condition[combinator]:
                keys |= _context_keys_in(child)
            return keys
    return {condition["key"]} if condition.get("source") == "context" else set()


def referenced_qualification_round_keys(plan: QuestionnairePlan) -> frozenset[str]:
    """Every round a ``qualified.<round>`` context condition asks the server about."""
    keys: set[str] = set()
    for question in plan.questions:
        for field in ("visible_if", "required_if"):
            keys |= _context_keys_in(question.get(field))
    return frozenset(key.removeprefix("qualified.") for key in keys if key.startswith("qualified."))


def validate_questionnaire_context_keys(
    plan: QuestionnairePlan, bound_round_keys: Mapping | Set
) -> None:
    """Refuse a ``qualified.<round>`` condition the frozen binding cannot answer.

    The static vocabulary (`conditions.is_known_context_key`) stops a typo of the *shape*
    — ``qualifed.r3`` — but ``qualified.r9`` is well-shaped and still answers nothing, so
    the question it guards is hidden for the whole contest with no error anywhere. Only the
    binding knows which rounds exist.
    """
    missing = sorted(referenced_qualification_round_keys(plan) - set(bound_round_keys))
    if missing:
        raise ValidationError(f"问卷条件引用了赛制未绑定的晋级轮次：{missing}。")
