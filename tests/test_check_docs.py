import shutil
import subprocess
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CHECKER_SOURCE = PROJECT_ROOT / "scripts" / "check_docs.ps1"
PWSH = shutil.which("pwsh")

pytestmark = pytest.mark.skipif(
    PWSH is None,
    reason="pwsh is required for documentation-checker tests",
)


def create_documentation_repository(tmp_path: Path) -> Path:
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    shutil.copy2(CHECKER_SOURCE, scripts / "check_docs.ps1")

    for name in ("README.md", "CLAUDE.md", "AGENTS.md", "CHANGELOG.md", "GOAL.md"):
        (tmp_path / name).write_text(f"# {name}\n", encoding="utf-8")

    return tmp_path


def run_checker(repository_root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [PWSH, "-NoProfile", "-File", "scripts/check_docs.ps1"],
        cwd=repository_root,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def test_checker_resolves_links_from_the_source_document_directory(tmp_path: Path):
    repository_root = create_documentation_repository(tmp_path)
    docs = repository_root / "docs"
    docs.mkdir()
    (docs / "development-baseline.md").write_text(
        "[Repository instructions](../AGENTS.md)\n",
        encoding="utf-8",
    )

    result = run_checker(repository_root)

    assert result.returncode == 0, result.stderr


def test_checker_rejects_links_that_escape_the_repository_root(tmp_path: Path):
    repository_root = create_documentation_repository(tmp_path)
    (repository_root / "README.md").write_text("[Outside](../outside.md)\n", encoding="utf-8")

    result = run_checker(repository_root)

    assert result.returncode != 0
    assert "escapes the repository root" in result.stderr


def test_checker_applies_stale_content_rules_to_changelog_and_goal(tmp_path: Path):
    repository_root = create_documentation_repository(tmp_path)
    (repository_root / "CHANGELOG.md").write_text("`seed_data`\n", encoding="utf-8")
    (repository_root / "GOAL.md").write_text("admin / admin123\n", encoding="utf-8")

    result = run_checker(repository_root)

    assert result.returncode != 0
    assert "CHANGELOG.md" in result.stderr
    assert "GOAL.md" in result.stderr


def test_checker_skips_superpowers_artifacts(tmp_path: Path):
    repository_root = create_documentation_repository(tmp_path)
    superpowers_docs = repository_root / "docs" / "superpowers"
    superpowers_docs.mkdir(parents=True)
    (superpowers_docs / "plan.md").write_text(
        "`seed_data` [outside](../../outside.md)\n",
        encoding="utf-8",
    )

    result = run_checker(repository_root)

    assert result.returncode == 0, result.stderr
