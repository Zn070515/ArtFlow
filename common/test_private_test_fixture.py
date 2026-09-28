from __future__ import annotations

from pathlib import Path

from django.test import SimpleTestCase

from common.private_test_fixture import (
    PrivateFixtureError,
    ensure_synthetic_provenance,
    parse_fixture_rows,
)


class PrivateTestFixtureParserTests(SimpleTestCase):
    def test_parse_fixture_rows_requires_named_columns(self):
        rows = parse_fixture_rows([{"stage": "round1", "provenance": "SYNTHETIC_TEST_ONLY"}])

        self.assertEqual(rows, ({"stage": "round1", "provenance": "SYNTHETIC_TEST_ONLY"},))

    def test_ensure_synthetic_provenance_rejects_historical_row(self):
        with self.assertRaisesRegex(PrivateFixtureError, "provenance"):
            ensure_synthetic_provenance(
                [{"provenance": "HISTORICAL_SOURCE"}], source=Path("scores.csv")
            )

    def test_ensure_synthetic_provenance_accepts_sanitized_vote_marker(self):
        ensure_synthetic_provenance(
            [{"provenance": "SANITIZED_SOURCE_EXPORT_FOR_TEST_ONLY"}],
            source=Path("p1r2_ballots_sanitized.csv"),
        )
