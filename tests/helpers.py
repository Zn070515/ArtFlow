"""Reusable pytest decorators for cross-database test contracts."""

from collections.abc import Callable
from typing import TypeVar, cast
from unittest import skipUnless

from django.db import connection

try:
    import pytest
except ModuleNotFoundError:  # pragma: no cover - exercised by the production test image
    pytest = None  # type: ignore[assignment]

_TestObject = TypeVar("_TestObject")


def postgresql_only(test: _TestObject) -> _TestObject:
    """Mark and skip a test whose correctness depends on PostgreSQL semantics.

    ``skipUnless`` is applied unconditionally, not only when pytest is missing. Django's
    own test runner ignores pytest markers, so relying on the marker alone ran these
    ``TransactionTestCase`` concurrency tests against SQLite — where they fail on lock
    contention instead of reporting the PostgreSQL-only contract they actually verify.
    """

    skip_non_postgresql = cast(
        Callable[[_TestObject], _TestObject],
        skipUnless(
            connection.vendor == "postgresql",
            "requires PostgreSQL database semantics",
        ),
    )
    skipped = skip_non_postgresql(test)
    if pytest is None:
        return skipped
    return cast(_TestObject, pytest.mark.postgresql(skipped))
