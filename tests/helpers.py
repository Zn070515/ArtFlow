"""Reusable pytest decorators for cross-database test contracts."""

from typing import TypeVar, cast
from unittest import skipUnless

from django.db import connection

try:
    import pytest
except ModuleNotFoundError:  # pragma: no cover - exercised by the production test image
    pytest = None  # type: ignore[assignment]

_TestObject = TypeVar("_TestObject")


def postgresql_only(test: _TestObject) -> _TestObject:
    """Mark and skip a test whose correctness depends on PostgreSQL semantics."""

    if pytest is None:
        return cast(
            _TestObject,
            skipUnless(
                connection.vendor == "postgresql",
                "requires PostgreSQL database semantics",
            )(test),
        )
    skipped = pytest.mark.skipif(
        connection.vendor != "postgresql",
        reason="requires PostgreSQL database semantics",
    )(test)
    return cast(_TestObject, pytest.mark.postgresql(skipped))
