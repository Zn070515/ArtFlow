"""Validate the golden fixtures without importing Django or the Plus runtime.

Run from the repository root:

    uv run python tests/golden/validate_fixtures.py

Every fixture must use the v1 schema, carry an id matching its filename, reference
invariants that exist in ``docs/invariants``, and make each step's expectation
unambiguous: accepted steps name the events, rejected steps name the reason and
assert that no side effect happened.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INVARIANTS_DIR = ROOT / "docs" / "invariants"
GOLDEN_DIR = ROOT / "tests" / "golden"


def known_invariants() -> set[str]:
    known: set[str] = set()
    for path in INVARIANTS_DIR.glob("*.md"):
        known.update(re.findall(r"^##\s+([A-Z]+-\d+)\b", path.read_text(encoding="utf-8"), re.M))
    return known


def main() -> int:
    known = known_invariants()
    problems: list[str] = []
    ids: set[str] = set()

    for path in sorted(GOLDEN_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as error:
            problems.append(f"{path.name}: invalid JSON: {error}")
            continue
        if data.get("schema") != "artflow.golden.fixture.v1":
            problems.append(f"{path.name}: schema must be artflow.golden.fixture.v1")
        fixture_id = data.get("id")
        if fixture_id != path.stem:
            problems.append(f"{path.name}: id {fixture_id!r} does not match the filename")
        if fixture_id in ids:
            problems.append(f"{path.name}: duplicate fixture id")
        ids.add(str(fixture_id))
        for invariant in data.get("invariants", []):
            if invariant not in known:
                problems.append(f"{path.name}: unknown invariant {invariant}")
        for index, step in enumerate(data.get("steps", []), start=1):
            expect = step.get("expect", {})
            outcome = expect.get("outcome")
            if outcome not in {"accepted", "rejected"}:
                problems.append(f"{path.name} step {index}: outcome must be accepted/rejected")
            if outcome == "rejected":
                if not expect.get("reason"):
                    problems.append(f"{path.name} step {index}: rejected step has no reason")
                if expect.get("side_effects") != "none":
                    problems.append(
                        f"{path.name} step {index}: rejected step must assert side_effects=none"
                    )
            if outcome == "accepted" and not expect.get("events"):
                problems.append(f"{path.name} step {index}: accepted step has no events")

    print(f"fixtures={len(ids)} invariants={len(known)}")
    for problem in problems:
        print(f"PROBLEM {problem}")
    print("OK" if not problems else "FAILED")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
