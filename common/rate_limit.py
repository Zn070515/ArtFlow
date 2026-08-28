from django.core.cache import cache


class RateLimitExceeded(Exception):
    """Raised when an action exceeds its allowed attempts within the window."""


def hit_rate_limit(key: str, *, limit: int, window_seconds: int) -> None:
    """Record one attempt and raise ``RateLimitExceeded`` once ``limit`` is passed.

    The counter lives in the cache for ``window_seconds`` from the first attempt,
    so the whole throttle resets when the key expires. ``limit`` counts the
    attempt being recorded, so a limit of 10 allows the first 10 hit calls and
    raises on the 11th.
    """
    cache_key = f"rate-limit:{key}"
    if cache.add(cache_key, 1, timeout=window_seconds):
        return
    try:
        current = cache.incr(cache_key)
    except ValueError:
        # Key expired between the failed add and this incr; restart the window.
        cache.set(cache_key, 1, timeout=window_seconds)
        return
    if current > limit:
        raise RateLimitExceeded("请求过于频繁，请稍后再试。")
