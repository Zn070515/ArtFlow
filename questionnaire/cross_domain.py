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
