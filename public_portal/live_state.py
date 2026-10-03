"""Process-local short-TTL memo for the shared live-state payload.

Every open live page polls ``GET /e/<code>/live/state/`` roughly every 2.5 s. The
vote state, vote name, time window, vote link and result-publication lookup are
identical for every viewer of an activity — only the ticket qualification state
is personal. Recomputing the shared half on every poll (notably
``PublicPost.published_public()``, which carries Exists/Subquery guards) is what
made this endpoint expensive.

The shared half is therefore memoised per process for one second: long enough to
collapse a polling wave, short enough that a staff action becomes visible almost
immediately. PostgreSQL stays the source of truth — a cache hit only skips a
recomputation, a miss simply queries again, and nothing here caches ticket
status, login state or any user-specific authorization.

This is deliberately not a Redis/Channels dependency: the advice for this
codebase is to make heavy polling cheap, not to add a realtime tier.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

from core.models import Activity
from django.conf import settings
from django.utils import timezone
from voting.models import VoteSession
from voting.policies import vote_ui_state

from .models import PublicPost

_DEFAULT_TTL_SECONDS = 1
_MAX_ENTRIES = 256

_cache_lock = threading.Lock()
_cache: dict[int, tuple[float, SharedLiveState]] = {}


@dataclass(frozen=True)
class SharedLiveState:
    """The activity-wide half of the live-state payload.

    ``start_timestamp``/``end_timestamp`` are ``None`` when there is no open vote
    session so the revision string stays byte-identical to the pre-cache one.
    """

    vote_session_id: int | None
    vote_name: str
    state: str
    label: str
    can_submit: bool
    start_timestamp: float | None
    end_timestamp: float | None
    result_post_id: int | None

    def revision(self, ticket_status: str) -> str:
        """The client's change token: identical inputs must produce one string."""
        return ":".join(
            [
                str(self.vote_session_id or 0),
                self.state,
                str(self.start_timestamp if self.start_timestamp is not None else 0),
                str(self.end_timestamp if self.end_timestamp is not None else 0),
                str(self.result_post_id or 0),
                ticket_status,
            ]
        )


def activity_result_posts(activity: Activity):
    """The published result-publication posts for one activity."""
    return PublicPost.published_public().filter(
        related_activity=activity,
        post_type=PublicPost.PostType.RESULT_PUBLICATION,
    )


def clear_live_state_cache() -> None:
    """Drop every memoised entry (tests that assert immediate transitions use this)."""
    with _cache_lock:
        _cache.clear()


def shared_live_state(activity: Activity) -> SharedLiveState:
    """Return the cached-or-recomputed shared live state for *activity*."""
    ttl = _ttl_seconds()
    if ttl <= 0:
        return _compute_shared_live_state(activity)
    with _cache_lock:
        cached = _cache.get(activity.pk)
    if cached is not None and time.monotonic() - cached[0] < ttl:
        return cached[1]
    state = _compute_shared_live_state(activity)
    with _cache_lock:
        _cache[activity.pk] = (time.monotonic(), state)
        if len(_cache) > _MAX_ENTRIES:
            _prune_locked(time.monotonic())
    return state


def _ttl_seconds() -> int:
    return int(getattr(settings, "LIVE_STATE_CACHE_SECONDS", _DEFAULT_TTL_SECONDS))


def _prune_locked(observed_at: float) -> None:
    """Drop expired entries, then the oldest ones, until the cache is bounded."""
    ttl = _ttl_seconds()
    for key in [key for key, (stored_at, _) in _cache.items() if observed_at - stored_at >= ttl]:
        del _cache[key]
    while len(_cache) > _MAX_ENTRIES:
        del _cache[min(_cache, key=lambda key: _cache[key][0])]


def _compute_shared_live_state(activity: Activity) -> SharedLiveState:
    now = timezone.now()
    vote_session = (
        VoteSession.objects.select_related("activity")
        .filter(activity=activity, is_open=True, is_locked=False)
        .order_by("start_time", "pk")
        .first()
    )
    if vote_session is None:
        state, label, can_submit = "waiting", "当前暂无开放投票", False
    else:
        state, label, can_submit = vote_ui_state(vote_session, now)
    result_post = activity_result_posts(activity).first()
    return SharedLiveState(
        vote_session_id=vote_session.pk if vote_session else None,
        vote_name=vote_session.name if vote_session else "",
        state=state,
        label=label,
        can_submit=can_submit,
        start_timestamp=vote_session.start_time.timestamp() if vote_session else None,
        end_timestamp=vote_session.end_time.timestamp() if vote_session else None,
        result_post_id=result_post.pk if result_post else None,
    )
