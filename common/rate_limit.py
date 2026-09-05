from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha256
from math import ceil
from typing import cast

from django.conf import settings
from django.core.cache import cache
from django.db import IntegrityError, connection, transaction
from django.db.models import F
from django.utils import timezone

from common.models import RateLimitBucket


class RateLimitExceeded(Exception):
    """Raised when an action exceeds its allowed attempts within the window."""


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    retry_after_seconds: int


def _storage_key(key: str) -> str:
    """Avoid persisting source IPs or browser-session values in the shared store."""
    return sha256(key.encode("utf-8")).hexdigest()


def _decision(*, count: int, expires_at: datetime, limit: int, now: datetime) -> RateLimitDecision:
    if count <= limit:
        return RateLimitDecision(allowed=True, retry_after_seconds=0)
    retry_after_seconds = max(1, ceil((expires_at - now).total_seconds()))
    return RateLimitDecision(allowed=False, retry_after_seconds=retry_after_seconds)


def _allow_locmem(
    key: str, *, limit: int, window_seconds: int, now: datetime
) -> RateLimitDecision:
    cache_key = f"rate-limit:{key}"
    expires_at = now + timedelta(seconds=window_seconds)
    if cache.add(cache_key, 1, timeout=window_seconds):
        return _decision(count=1, expires_at=expires_at, limit=limit, now=now)
    try:
        count = cache.incr(cache_key)
    except ValueError:
        # The cache entry expired between add and incr; restart the local window.
        cache.set(cache_key, 1, timeout=window_seconds)
        return _decision(count=1, expires_at=expires_at, limit=limit, now=now)
    return _decision(count=count, expires_at=expires_at, limit=limit, now=now)


def _allow_postgresql(
    key: str, *, limit: int, window_seconds: int, now: datetime
) -> RateLimitDecision:
    expires_at = now + timedelta(seconds=window_seconds)
    quote = connection.ops.quote_name
    table = quote(RateLimitBucket._meta.db_table)
    key_column = quote("key")
    window_column = quote("window_started_at")
    count_column = quote("count")
    expiry_column = quote("expires_at")
    statement = f"""
        INSERT INTO {table} ({key_column}, {window_column}, {count_column}, {expiry_column})
        VALUES (%s, %s, 1, %s)
        ON CONFLICT ({key_column}) DO UPDATE SET
            {window_column} = CASE
                WHEN {table}.{expiry_column} <= EXCLUDED.{window_column}
                THEN EXCLUDED.{window_column}
                ELSE {table}.{window_column}
            END,
            {count_column} = CASE
                WHEN {table}.{expiry_column} <= EXCLUDED.{window_column}
                THEN 1
                ELSE {table}.{count_column} + 1
            END,
            {expiry_column} = CASE
                WHEN {table}.{expiry_column} <= EXCLUDED.{window_column}
                THEN EXCLUDED.{expiry_column}
                ELSE {table}.{expiry_column}
            END
        RETURNING {count_column}, {expiry_column}
    """
    with connection.cursor() as cursor:
        cursor.execute(statement, [key, now, expires_at])
        row = cursor.fetchone()
    if row is None:  # pragma: no cover - PostgreSQL RETURNING always supplies one row.
        raise RuntimeError("Rate-limit upsert did not return a bucket.")
    count, actual_expiry = cast(tuple[int, datetime], row)
    return _decision(count=count, expires_at=actual_expiry, limit=limit, now=now)


def _allow_sqlite(
    key: str, *, limit: int, window_seconds: int, now: datetime
) -> RateLimitDecision:
    expires_at = now + timedelta(seconds=window_seconds)
    for _ in range(2):
        with transaction.atomic():
            bucket = RateLimitBucket.objects.select_for_update().filter(key=key).first()
            if bucket is None:
                try:
                    with transaction.atomic():
                        RateLimitBucket.objects.create(
                            key=key,
                            window_started_at=now,
                            count=1,
                            expires_at=expires_at,
                        )
                except IntegrityError:
                    continue
                return _decision(count=1, expires_at=expires_at, limit=limit, now=now)

            if bucket.expires_at <= now:
                RateLimitBucket.objects.filter(pk=bucket.pk).update(
                    window_started_at=now,
                    count=1,
                    expires_at=expires_at,
                )
                return _decision(count=1, expires_at=expires_at, limit=limit, now=now)

            RateLimitBucket.objects.filter(pk=bucket.pk).update(count=F("count") + 1)
            bucket.refresh_from_db(fields=["count", "expires_at"])
            return _decision(count=bucket.count, expires_at=bucket.expires_at, limit=limit, now=now)
    raise RuntimeError("Rate-limit bucket creation conflicted repeatedly.")


def allow(key: str, *, limit: int, window_seconds: int) -> RateLimitDecision:
    """Record an attempt and return only its allowance and retry metadata.

    Production uses the primary database so every web worker observes the same
    bucket. Development and test retain the local cache backend.
    """
    if limit < 1:
        raise ValueError("Rate-limit limit must be positive.")
    if window_seconds < 1:
        raise ValueError("Rate-limit window must be positive.")

    now = timezone.now()
    if getattr(settings, "RATE_LIMIT_BACKEND", "locmem") == "database":
        storage_key = _storage_key(key)
        if connection.vendor == "postgresql":
            return _allow_postgresql(
                storage_key,
                limit=limit,
                window_seconds=window_seconds,
                now=now,
            )
        return _allow_sqlite(storage_key, limit=limit, window_seconds=window_seconds, now=now)
    return _allow_locmem(key, limit=limit, window_seconds=window_seconds, now=now)


def hit_rate_limit(key: str, *, limit: int, window_seconds: int) -> None:
    """Compatibility wrapper for callers that still prefer an exception."""
    decision = allow(key, limit=limit, window_seconds=window_seconds)
    if not decision.allowed:
        raise RateLimitExceeded("请求过于频繁，请稍后再试。")
