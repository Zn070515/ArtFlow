from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from scripts.verify_private_test_package import verify_private_test_package


class PrivateFixtureError(ValueError):
    """Raised when a private rehearsal row is unsafe to load."""


@dataclass(frozen=True)
class PrivateTestFixture:
    root: Path
    reference: Mapping[str, Any]
    identities: tuple[dict[str, str], ...]
    panel_assignments: tuple[dict[str, str], ...]
    score_rows: tuple[dict[str, str], ...]
    ticket_rows: tuple[dict[str, str], ...]
    media_assignments: tuple[dict[str, str], ...]
    p1_votes: tuple[dict[str, str], ...]
    p2_votes: tuple[dict[str, str], ...]

    @classmethod
    def from_root(cls, root: Path) -> "PrivateTestFixture":
        package_root = root.expanduser().resolve()
        addendum_root = package_root / "07_realistic_test_addendum"
        if not addendum_root.is_dir():
            raise PrivateFixtureError("fixture root must contain 07_realistic_test_addendum")
        try:
            verify_private_test_package(package_root, require_sanitized_votes=True)
            reference = json.loads(
                (
                    package_root / "02_私测夹具" / "artflow_2025_full_reference_fixture.json"
                ).read_text(encoding="utf-8")
            )
            paths = {
                "identities": addendum_root / "synthetic_identities.csv",
                "panel_assignments": addendum_root / "judge_panel_assignments.csv",
                "score_rows": addendum_root / "synthetic_judge_scores.csv",
                "ticket_rows": addendum_root / "synthetic_ticket_inventory.csv",
                "media_assignments": addendum_root / "media_assignments.csv",
                "p1_votes": addendum_root / "sanitized_vote_exports" / "p1r2_ballots_sanitized.csv",
                "p2_votes": addendum_root / "sanitized_vote_exports" / "p2r2_ballots_sanitized.csv",
            }
            rows = {name: read_fixture_csv(path) for name, path in paths.items()}
            for name, path in paths.items():
                ensure_synthetic_provenance(rows[name], source=path)
        except (OSError, json.JSONDecodeError) as error:
            raise PrivateFixtureError(f"cannot read private fixture: {package_root}") from error
        if not isinstance(reference, dict):
            raise PrivateFixtureError("reference fixture must be an object")
        return cls(root=package_root, reference=reference, **rows)

    def dry_run_report(self) -> dict[str, object]:
        return {
            "fixture_id": self.reference.get("fixture_id"),
            "provenance": "SYNTHETIC_TEST_ONLY",
            "contestants": len(self.identities),
            "judges": len(self.reference.get("judges") or []),
            "rounds": 4,
            "panel_assignments": len(self.panel_assignments),
            "criterion_score_rows": len(self.score_rows),
            "tickets": len(self.ticket_rows),
            "media_assignments": len(self.media_assignments),
            "p1_ballots": len(self.p1_votes),
            "p2_ballots": len(self.p2_votes),
            "target_top3": ["A1", "J10", "C3"],
            "database_write": False,
            "media_write": False,
        }


def parse_fixture_rows(rows: list[Mapping[str, object]]) -> tuple[dict[str, str], ...]:
    normalized: list[dict[str, str]] = []
    for row in rows:
        if not isinstance(row, Mapping):
            raise PrivateFixtureError("fixture row must be a mapping")
        normalized.append(
            {str(key): "" if value is None else str(value) for key, value in row.items()}
        )
    return tuple(normalized)


def read_fixture_csv(path: Path) -> tuple[dict[str, str], ...]:
    try:
        with path.open("r", newline="", encoding="utf-8-sig") as handle:
            return parse_fixture_rows(list(csv.DictReader(handle)))
    except OSError as error:
        raise PrivateFixtureError(f"cannot read fixture CSV: {path}") from error


def ensure_synthetic_provenance(
    rows: list[Mapping[str, object]] | tuple[Mapping[str, object], ...], *, source: Path
) -> None:
    allowed = {"SYNTHETIC_TEST_ONLY"}
    if "sanitized" in source.name:
        allowed.add("SANITIZED_SOURCE_EXPORT_FOR_TEST_ONLY")
    for index, row in enumerate(rows, start=1):
        provenance = str(row.get("provenance", "")).strip()
        if provenance not in allowed:
            raise PrivateFixtureError(
                "fixture row "
                f"{index} in {source.name} has unsafe provenance: "
                f"{provenance or '<empty>'}"
            )
