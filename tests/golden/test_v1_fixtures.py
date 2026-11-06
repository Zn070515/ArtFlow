"""Run the implementation-agnostic golden fixtures against v1.

Only fixtures with a registered v1 adapter are executed here. The rest are
already proven by focused v1 tests; ``V1_COVERAGE`` records where, so the gap
between "fixture written" and "fixture executable on v1" stays visible.
"""

from __future__ import annotations

import json
from pathlib import Path

from django.test import TestCase

from .v1_adapter import ADAPTERS, GoldenRejected, ResultReleaseAdapter

GOLDEN_DIR = Path(__file__).resolve().parent

V1_COVERAGE = {
    # The remaining fixtures are proven by these v1 suites today. They will get
    # adapters when Plus starts consuming the same files.
    "duplicate-score-fact": "staff_panel.tests / singer_contest.test_judge_authority",
    "capability-reissue-close": "staff_panel.tests (judge entry claim/reissue/close)",
    "unknown-roster": "ruleset.test_deferred_roster",
    "static-artifact-identity": "tests.test_production_compose_config",
    "archive-identity": "public_portal.tests / staff_panel.tests (archive workbooks)",
}


def load_fixture(fixture_id: str) -> dict:
    return json.loads((GOLDEN_DIR / f"{fixture_id}.json").read_text(encoding="utf-8"))


def assert_subset(expected, actual, path: str = "read_model") -> None:
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{path}: expected an object, got {type(actual)!r}"
        for key, value in expected.items():
            assert key in actual, f"{path}.{key}: missing"
            assert_subset(value, actual[key], f"{path}.{key}")
        return
    if isinstance(expected, list):
        assert isinstance(actual, list), f"{path}: expected a list, got {type(actual)!r}"
        assert len(expected) == len(actual), f"{path}: length {len(actual)} != {len(expected)}"
        for index, value in enumerate(expected):
            assert_subset(value, actual[index], f"{path}[{index}]")
        return
    assert expected == actual, f"{path}: expected {expected!r}, got {actual!r}"


class GoldenFixtureTests(TestCase):
    def test_every_fixture_is_structurally_valid(self) -> None:
        from .validate_fixtures import main

        self.assertEqual(main(), 0)

    def test_every_fixture_has_an_adapter_or_recorded_v1_coverage(self) -> None:
        fixture_ids = {path.stem for path in GOLDEN_DIR.glob("*.json")}
        covered = set(ADAPTERS) | set(V1_COVERAGE)
        self.assertEqual(fixture_ids - covered, set())

    def test_result_release_lifecycle_fixture_matches_v1(self) -> None:
        fixture = load_fixture(ResultReleaseAdapter.fixture_id)
        adapter = ResultReleaseAdapter(fixture["facts"])
        adapter.setup()
        for step in fixture["steps"]:
            with self.subTest(step=step["step"], command=step["command"]):
                self._run_step(adapter, step)

    def _run_step(self, adapter, step: dict) -> None:
        expect = step["expect"]
        if expect["outcome"] == "rejected":
            before = adapter.read_model()
            with self.assertRaises(GoldenRejected) as caught:
                adapter.execute(step["command"], step["actor"], step["input"])
            self.assertEqual(caught.exception.reason, expect["reason"])
            self.assertEqual(adapter.read_model(), before)
            return
        result = adapter.execute(step["command"], step["actor"], step["input"])
        for event in expect.get("events", []):
            self.assertIn(event, result["events"])
        assert_subset(expect.get("read_model", {}), result["read_model"])
