"""Thread-local write-authority for formal state transitions (M1-Core-Close, Batch A).

A RulesetVersion may only become FROZEN/current inside ``freeze_ruleset_version`` and a
StageResult may only become CONFIRMED inside ``confirm_stage_result``/``unlock_stage_result``.
These are authority transitions that carry Admin, Activity-lock, bound-compiler, authority-hash
and audit machinery, so an untrusted ORM ``.create()``/``.update()`` must be refused unless the
service that owns the transition is actively wrapping the write.

The guard is thread-local so concurrent service calls in separate threads do not leak authority
into one another; prior scope is restored on exit so a nested grant never persists past its
context. The same pattern already covers :class:`ManualDecision` (singer_contest.models) — this
module generalises it so RulesetVersion and StageResult share one mechanism rather than a public
``_allow_freeze``/``_bypass_confirmed`` kwarg that any caller could pass.
"""

import threading
from collections.abc import Iterator
from contextlib import contextmanager

# Write-authority scope identifiers.
RULESET_FREEZE = "ruleset.freeze"
STAGE_RESULT_CONFIRM = "stageresult.confirm"

_scope = threading.local()


def _active_scopes() -> frozenset[str]:
    return frozenset(getattr(_scope, "scopes", ()))


def authority_authorized(scope: str) -> bool:
    """True when *scope* is currently granted by an enclosing :func:`authority_write`."""
    return scope in _active_scopes()


def _set_scope(scopes: frozenset[str]) -> None:
    _scope.scopes = frozenset(scopes)


@contextmanager
def authority_write(scope: str) -> Iterator[None]:
    """Bracket a formal write with *scope*; restores the prior authority on exit.

    ``authority_authorized`` is False outside any ``authority_write`` block, so a bare
    ``RulesetVersion.objects.create(status=\"frozen\", is_current=True)`` or
    ``StageResult.objects.create(status=\"confirmed\")`` raises instead of manufacturing
    a terminal row.
    """
    prior = _active_scopes()
    _set_scope(prior | {scope})
    try:
        yield
    finally:
        _set_scope(prior)
