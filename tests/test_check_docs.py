import os
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


def remove_link_without_following(path: Path) -> None:
    if path.is_symlink():
        path.unlink()
        return

    if path.is_junction():
        result = subprocess.run(
            ["cmd", "/c", "rmdir", str(path)],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise OSError(f"could not remove junction {path}: {result.stderr}")


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


def test_checker_skips_anchor_links_and_all_uri_schemes(tmp_path: Path):
    repository_root = create_documentation_repository(tmp_path)
    (repository_root / "README.md").write_text(
        "\n".join(
            (
                "[Anchor](#section)",
                "[FTP](ftp://example.test/artflow)",
                "[File](file:///tmp/artflow.md)",
                "[Custom](artflow+guide:setup)",
            )
        ),
        encoding="utf-8",
    )

    result = run_checker(repository_root)

    assert result.returncode == 0, result.stderr


def test_checker_does_not_mistake_a_windows_drive_path_for_a_uri(tmp_path: Path):
    repository_root = create_documentation_repository(tmp_path)
    (repository_root / "README.md").write_text("[Outside](C:\\outside.md)\n", encoding="utf-8")

    result = run_checker(repository_root)

    assert result.returncode != 0
    assert "escapes the repository root" in result.stderr


@pytest.mark.skipif(os.name != "nt", reason="Windows drive paths require Windows")
def test_checker_accepts_a_windows_drive_path_inside_the_repository(tmp_path: Path):
    repository_root = create_documentation_repository(tmp_path)
    inside_document = repository_root / "docs" / "inside.md"
    inside_document.parent.mkdir()
    inside_document.write_text("inside\n", encoding="utf-8")
    windows_path = str(inside_document).replace("/", "\\")
    (repository_root / "README.md").write_text(
        f"[Inside]({windows_path})\n",
        encoding="utf-8",
    )

    result = run_checker(repository_root)

    assert result.returncode == 0, result.stderr


def test_checker_rejects_a_repository_symlink_to_an_external_target(tmp_path: Path):
    repository_root = create_documentation_repository(tmp_path)
    docs = repository_root / "docs"
    docs.mkdir()
    outside_target = tmp_path.parent / f"{tmp_path.name}-outside"
    outside_target.mkdir()
    (outside_target / "target.md").write_text("outside\n", encoding="utf-8")
    symlink = docs / "outside"

    try:
        symlink.symlink_to(outside_target, target_is_directory=True)
    except OSError as error:
        if os.name != "nt":
            (outside_target / "target.md").unlink(missing_ok=True)
            outside_target.rmdir()
            pytest.skip(f"symlink creation is unavailable: {error}")

        junction = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(symlink), str(outside_target)],
            check=False,
            capture_output=True,
            text=True,
        )
        if junction.returncode != 0:
            (outside_target / "target.md").unlink(missing_ok=True)
            outside_target.rmdir()
            pytest.skip(f"symlink and junction creation are unavailable: {error}")

    try:
        (repository_root / "README.md").write_text(
            "[Outside](docs/outside/target.md)\n",
            encoding="utf-8",
        )

        result = run_checker(repository_root)

        assert result.returncode != 0
        assert "escapes the repository root" in result.stderr
    finally:
        if symlink.exists() or symlink.is_symlink():
            remove_link_without_following(symlink)
        assert outside_target.is_dir()
        (outside_target / "target.md").unlink(missing_ok=True)
        outside_target.rmdir()
