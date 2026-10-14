"""The one official arithmetic boundary for singer-contest scores.

Raw score facts stay owned by the existing scoring authority services.  This module only
defines the pure arithmetic and completion semantics that those services, the resolver,
and the live operator surface must share.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from enum import StrEnum
from typing import Iterable

OFFICIAL_SCORE_QUANTUM = Decimal("0.01")


class ScoreCompletionMode(StrEnum):
    """How a contestant becomes eligible for manual score locking."""

    FULL_MATRIX = "full_matrix"
    MINIMUM_VALID = "minimum_valid"


class ScoreCompletionState(StrEnum):
    NOT_OPENED = "not_opened"
    BELOW_MINIMUM = "below_minimum"
    READY_TO_LOCK = "ready_to_lock"
    LOCKED = "locked"


@dataclass(frozen=True)
class ScoreCompleteness:
    state: ScoreCompletionState
    expected_judge_count: int
    minimum_judge_count: int
    valid_score_count: int

    @property
    def can_lock(self) -> bool:
        return self.state == ScoreCompletionState.READY_TO_LOCK


def _as_decimal(value: object) -> Decimal:
    if isinstance(value, bool):
        raise ValueError("score must be a finite decimal")
    try:
        decimal_value = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError("score must be a finite decimal") from exc
    if not decimal_value.is_finite():
        raise ValueError("score must be a finite decimal")
    return decimal_value


def quantize_official_score(value: object) -> Decimal:
    """Return the official two-decimal score using ``ROUND_HALF_UP``."""

    return _as_decimal(value).quantize(OFFICIAL_SCORE_QUANTUM, rounding=ROUND_HALF_UP)


def official_average(scores: Iterable[object]) -> Decimal:
    """Average valid scores and quantize the result at the official boundary."""

    values = [_as_decimal(score) for score in scores]
    if not values:
        raise ValueError("cannot average an empty score collection")
    return quantize_official_score(sum(values, Decimal("0")) / Decimal(len(values)))


def official_weighted_score(components: Iterable[tuple[object, object]]) -> Decimal:
    """Compute and quantize a weighted score from already official components.

    ``components`` contains ``(official_score, weight)`` pairs.  Weights are expressed as
    fractions (for example ``Decimal("0.6")`` and ``Decimal("0.4")``) and must sum to one.
    """

    rows = [(_as_decimal(score), _as_decimal(weight)) for score, weight in components]
    if not rows:
        raise ValueError("cannot weight an empty score collection")
    if sum((weight for _, weight in rows), Decimal("0")) != Decimal("1"):
        raise ValueError("weights must sum to one")
    return quantize_official_score(
        sum((quantize_official_score(score) * weight for score, weight in rows), Decimal("0"))
    )


def assess_score_completeness(
    *,
    expected_judge_count: int,
    valid_score_count: int,
    minimum_judge_count: int,
    completion_mode: ScoreCompletionMode | str,
    opened: bool,
    locked: bool,
) -> ScoreCompleteness:
    """Classify one contestant's score collection without inventing missing scores."""

    if expected_judge_count < 1:
        raise ValueError("expected_judge_count must be positive")
    if minimum_judge_count < 1 or minimum_judge_count > expected_judge_count:
        raise ValueError("minimum_judge_count must be within the expected panel size")
    if valid_score_count < 0 or valid_score_count > expected_judge_count:
        raise ValueError("valid_score_count must be within the expected panel size")
    if locked and not opened:
        raise ValueError("a locked score collection must have been opened")

    mode = ScoreCompletionMode(completion_mode)
    required_count = (
        expected_judge_count if mode == ScoreCompletionMode.FULL_MATRIX else minimum_judge_count
    )
    if locked:
        state = ScoreCompletionState.LOCKED
    elif not opened:
        state = ScoreCompletionState.NOT_OPENED
    elif valid_score_count >= required_count:
        state = ScoreCompletionState.READY_TO_LOCK
    else:
        state = ScoreCompletionState.BELOW_MINIMUM
    return ScoreCompleteness(
        state=state,
        expected_judge_count=expected_judge_count,
        minimum_judge_count=required_count,
        valid_score_count=valid_score_count,
    )
