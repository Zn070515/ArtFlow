"""Gate for the mandatory Test architecture section in new specs and plans.

`CLAUDE.md` / `AGENTS.md` require every document under `docs/artflow-plus/specs`
and `docs/artflow-plus/plans` to name the contracts, consumers, lifecycle edges,
adapters, fault cases, anti-bloat decision, and gates before implementation. The
rule applies to documents dated on or after 2026-11-12; undated documents are
treated as new.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DOC_DIRECTORIES = [
    ROOT / "docs" / "artflow-plus" / "specs",
    ROOT / "docs" / "artflow-plus" / "plans",
]
CUTOFF = "2026-11-12"
MIN_SECTION_CHARS = 200

HEADING = re.compile(r"^##\s+.*test architecture.*$", re.IGNORECASE | re.MULTILINE)
NEXT_HEADING = re.compile(r"^##\s+", re.MULTILINE)


def section_body(text: str) -> str | None:
    heading = HEADING.search(text)
    if heading is None:
        return None
    rest = text[heading.end():]
    next_heading = NEXT_HEADING.search(rest)
    body = rest if next_heading is None else rest[:next_heading.start()]
    return body.strip()


def is_new_document(path: Path) -> bool:
    stamp = path.name[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", stamp):
        return True
    return stamp >= CUTOFF


def test_new_specs_and_plans_declare_test_architecture() -> None:
    problems: list[str] = []
    for directory in DOC_DIRECTORIES:
        if not directory.exists():
            continue
        for path in sorted(directory.glob("*.md")):
            if not is_new_document(path):
                continue
            body = section_body(path.read_text(encoding="utf-8"))
            relative = path.relative_to(ROOT).as_posix()
            if body is None:
                problems.append(f"{relative}: missing '## Test architecture' section")
            elif len(body) < MIN_SECTION_CHARS:
                problems.append(
                    f"{relative}: the Test architecture section is {len(body)} chars; "
                    f"at least {MIN_SECTION_CHARS} are required"
                )
    assert not problems, "\n".join(problems)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
