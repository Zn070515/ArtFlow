"""Reusable pytest decorators for cross-database test contracts."""

from typing import TypeVar

import pytest
from django.db import connection

_TestObject = TypeVar("_TestObject")


def postgresql_only(test: _TestObject) -> _TestObject:
    """Mark and skip a test whose correctness depends on PostgreSQL semantics."""

    skipped = pytest.mark.skipif(
        connection.vendor != "postgresql",
        reason="requires PostgreSQL database semantics",
    )(test)
    return pytest.mark.postgresql(skipped)
