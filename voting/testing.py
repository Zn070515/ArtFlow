"""Fixture-side access to the audience-fact write authority.

GOAL §8.4 makes a ballot the raw audience fact a stage result is computed from, so
:class:`VoteBallot` and :class:`VoteRecord` are written only by
:func:`voting.services.submit_ballot`, which holds :data:`VOTE_BALLOT_WRITE` while it
writes. A test or rehearsal fixture that manufactures one of those rows directly is
standing in for the service, and has to say so — the same shape as the stage-candidate
fixtures that hold ``STAGE_RESULT_RESOLVE``. These two helpers exist so that statement is
written once instead of re-derived at every call site.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from common.authority import VOTE_BALLOT_WRITE, authority_write


@contextmanager
def ballot_write_authority() -> Iterator[None]:
    """Hold the scope ``submit_ballot`` writes under."""
    with authority_write(VOTE_BALLOT_WRITE):
        yield


def create_legacy_vote_record(**kwargs: Any) -> Any:
    """Create a no-ballot audience fact, the GOAL §9.4 compatibility shape.

    A legacy record has no ticket and no ballot, so the browser session key is its whole
    identity; it is still a raw audience fact and still needs the service's authority.
    """
    from .models import VoteRecord

    with ballot_write_authority():
        return VoteRecord.objects.create(**kwargs)
