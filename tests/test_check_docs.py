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
    assert PWSH is not None  # skipif above guarantees pwsh is available
    return subprocess.run(
        [PWSH, "-NoProfile", "-File", "scripts/check_docs.ps1"],
        cwd=repository_root,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def normalized_document(name: str) -> str:
    document = (PROJECT_ROOT / "docs" / name).read_text(encoding="utf-8")
    return " ".join(document.split())


def test_production_readiness_describes_complete_award_authority_behaviors():
    readiness = normalized_document("production-readiness.md")

    assert "AWARD → StageAwardDecision → CONFIRM → Award" in readiness
    assert (
        "`StageResult` 此时只能是候选状态（通常为 `READY_TO_CONFIRM`）。候选不得进入正式 "
        "Award 列表或导出。"
        in readiness
    )
    assert "重复核定必须幂等，不能产生重复 Award。" in readiness
    assert (
        "`StageResult.status == CONFIRMED` 才是赛段来源 Award 的正式 authority。"
        in readiness
    )
    assert (
        "Staff 正式奖项列表和 `award_list` 导出只显示无赛段来源的历史 Award，或 "
        "`source_stage_result.status == CONFIRMED` 的 Award。"
        in readiness
    )
    assert "`VoteSession` 锁定本身不会创建 `Award`。" in readiness
    assert (
        "当 AWARD 节点确实消费投票时，该 VoteSession 只是核定前必须静止的原始输入，且其 "
        "`purpose` 必须与冻结绑定一致； 不依赖投票的 AWARD 不需要 VoteSession。"
        in readiness
    )
    assert "不得恢复“锁投票即颁奖”的旧流程。" in readiness
    assert (
        "输入或最新结果版本变化后，旧候选必须拒绝核定， 先重新 resolve 再核定；解锁已核定 "
        "StageResult 后，其已物化 Award 因来源赛段不再 `CONFIRMED` 而退出正式列表/导出。"
        in readiness
    )
    assert (
        "修正输入产生的新候选必须重新核定，旧候选和旧 Award 只保留可追溯性，不能冒充当前正式奖项。"
        in readiness
    )
    assert (
        "`Award.source_vote_session` 仅作为历史行可能仍需的 legacy provenance 保留。"
        in readiness
    )
    assert (
        "它不再 授权 Award 创建、重算或替换；删除该字段或清理历史值前，必须先审计真实历史数据并 "
        "通过显式迁移处理。"
        in readiness
    )


def test_production_rehearsal_runbook_describes_complete_award_authority_behaviors():
    runbook = normalized_document("production-rehearsal-runbook.md")

    assert (
        "正式链路严格为 `AWARD → StageAwardDecision → CONFIRM → Award`。"
        "`StageResult.status == CONFIRMED` 才是赛段来源 Award 的正式 authority；"
        "Staff 正式奖项列表和 `award_list` 导出只显示无赛段来源的历史 Award，或 "
        "`source_stage_result.status == CONFIRMED` 的 Award。"
        "`VoteSession 锁定本身不会创建 Award`；首次核定只物化一份来源完整的 Award，"
        "重复核定不重复；input fingerprint 或 result version 已变化的 stale 候选不能物化；"
        "解锁后旧来源赛段不再 `CONFIRMED`，所以旧 Award 不进入正式列表/导出，新候选必须重新核定。"
        in runbook
    )
    assert (
        "`Award.source_vote_session` 只解释可能存在的历史行，不是当前 Award authority。"
        "删除或迁移前先核查历史数据，不得用它恢复 vote-lock 自动颁奖。"
        in runbook
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
