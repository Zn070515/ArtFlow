"""Data migrations must not ALTER a table they just wrote to inside one transaction.

PostgreSQL runs foreign keys as ``DEFERRABLE INITIALLY DEFERRED`` triggers, so any row
write queues trigger events that are still pending when the next statement in the same
transaction runs. Django adds constraints with ``ALTER TABLE``, and PostgreSQL refuses
that while the table has pending trigger events:

    cannot ALTER TABLE "x" because it has pending trigger events

A fresh database has no rows for a data step to touch, so CI on an empty SQLite or
PostgreSQL database passes either way and the failure only appears when a populated
database is upgraded. These migrations exist to normalise pre-existing rows, so that is
exactly the case they are written for. ``atomic = False`` lets the data step commit
before the constraint is added; ``ruleset/migrations/0011`` is the original fix.
"""

from pathlib import Path

MIGRATIONS = sorted(Path(__file__).resolve().parents[1].glob("*/migrations/0*.py"))


def _mixes_data_step_with_constraint_change(source: str) -> bool:
    return "RunPython" in source and ("AddConstraint" in source or "RemoveConstraint" in source)


def test_data_migrations_that_change_constraints_run_non_atomically():
    offenders = [
        str(path.relative_to(path.parents[2]))
        for path in MIGRATIONS
        if _mixes_data_step_with_constraint_change(path.read_text(encoding="utf-8"))
        and "atomic = False" not in path.read_text(encoding="utf-8")
    ]

    assert offenders == [], (
        "these migrations run a data step and then ALTER the same table in one "
        f"transaction, which PostgreSQL rejects on a populated database: {offenders}"
    )


def test_the_contract_covers_the_migrations_it_was_written_for():
    """Guard against the check silently matching nothing after a refactor."""
    covered = [
        str(path.relative_to(path.parents[2]))
        for path in MIGRATIONS
        if _mixes_data_step_with_constraint_change(path.read_text(encoding="utf-8"))
    ]

    assert len(covered) >= 10
