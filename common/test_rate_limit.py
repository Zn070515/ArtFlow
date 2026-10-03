import time
from datetime import timedelta
from unittest.mock import patch

from django.db import DatabaseError
from django.test import TestCase, override_settings
from django.utils import timezone

from common import rate_limit
from common.models import RateLimitBucket
from common.rate_limit import allow


@override_settings(RATE_LIMIT_BACKEND="database")
class RateLimitCleanupHotPathTests(TestCase):
    """Cleanup is housekeeping; it must not run on every ``allow()``."""

    def test_one_sweep_per_process_interval(self) -> None:
        with (
            patch.object(rate_limit, "_last_cleanup_at", -float("inf")),
            patch.object(rate_limit, "_cleanup_expired_buckets") as sweep,
        ):
            decisions = [
                allow(f"cleanup:{index}", limit=10, window_seconds=60) for index in range(5)
            ]

        self.assertTrue(all(decision.allowed for decision in decisions))
        self.assertEqual(sweep.call_count, 1)

    def test_a_new_interval_allows_another_sweep(self) -> None:
        with (
            patch.object(rate_limit, "_last_cleanup_at", -float("inf")),
            patch.object(rate_limit, "_CLEANUP_INTERVAL_SECONDS", 0),
            patch.object(rate_limit, "_cleanup_expired_buckets") as sweep,
        ):
            for index in range(3):
                allow(f"interval:{index}", limit=10, window_seconds=60)

        self.assertEqual(sweep.call_count, 3)

    def test_a_skipped_sweep_does_not_change_the_decision(self) -> None:
        now = timezone.now()
        RateLimitBucket.objects.create(
            key=rate_limit._storage_key("skipped"),
            window_started_at=now - timedelta(minutes=5),
            count=9,
            expires_at=now - timedelta(minutes=1),
        )

        with (
            # Hold the throttle closed so the point of the test is the decision,
            # not whether a sweep happened to be due in this process.
            patch.object(rate_limit, "_last_cleanup_at", time.monotonic()),
            patch.object(rate_limit, "_cleanup_expired_buckets") as sweep,
        ):
            first = allow("skipped", limit=10, window_seconds=60)
            second = allow("skipped", limit=10, window_seconds=60)

        sweep.assert_not_called()
        self.assertTrue(first.allowed)
        self.assertTrue(second.allowed)
        self.assertEqual(RateLimitBucket.objects.count(), 1)

    def test_a_failing_sweep_never_changes_the_allowance(self) -> None:
        with (
            patch.object(rate_limit, "_last_cleanup_at", -float("inf")),
            patch.object(rate_limit, "_cleanup_expired_buckets", side_effect=DatabaseError),
        ):
            decision = allow("cleanup-failure", limit=10, window_seconds=60)

        self.assertTrue(decision.allowed)

    def test_a_limit_is_still_enforced_when_cleanup_never_runs(self) -> None:
        with (
            patch.object(rate_limit, "_last_cleanup_at", time.monotonic()),
            patch.object(rate_limit, "_cleanup_expired_buckets"),
        ):
            decisions = [allow("exhausted", limit=2, window_seconds=60) for _ in range(3)]

        self.assertEqual([decision.allowed for decision in decisions], [True, True, False])
