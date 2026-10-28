from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(relative_path: str) -> str:
    path = ROOT / relative_path
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def test_backup_covers_plus_database_archive_and_media() -> None:
    script = read("scripts/backup_plus.sh")

    assert script.startswith("#!/usr/bin/env bash\nset -Eeuo pipefail")
    assert "--profile plus" in script
    assert "plus-db" in script and "plus-api" in script
    assert "pg_dump" in script
    assert "plus_archive_data" in script
    assert "plus_media_data" in script
    assert "manifest.json" in script
    assert "database_sha256" in script
    assert "archives_sha256" in script
    assert "media_sha256" in script
    assert "sha256sum" in script


def test_restore_isolated_and_never_resets_source() -> None:
    script = read("scripts/restore_plus_verify.sh")

    assert script.startswith("#!/usr/bin/env bash\nset -Eeuo pipefail")
    assert "--profile plus" in script
    assert "pg_restore" in script
    assert "kysely_migration" in script
    assert "tarfile" in script
    assert "symlink" in script
    assert "hardlink" in script
    assert "docker compose down --volumes" not in script
    assert "docker volume rm" not in script
    assert "DROP DATABASE" not in script


def test_docs_describe_plus_media_and_isolated_restore() -> None:
    backup_restore_doc = read("docs/artflow-plus/backup-restore.md")
    cutover_runbook = read("docs/artflow-plus/cutover-runbook.md")

    for document in (backup_restore_doc, cutover_runbook):
        assert "plus_postgres_data" in document
        assert "plus_archive_data" in document
        assert "plus_media_data" in document
        assert "backup_plus.sh" in document
        assert "restore_plus_verify.sh" in document

    assert "真实活动彩排" not in backup_restore_doc
    assert "不要求真实活动彩排" in cutover_runbook


def test_scripts_do_not_reset_source_compose_state() -> None:
    for relative_path in ("scripts/backup_plus.sh", "scripts/restore_plus_verify.sh"):
        script = read(relative_path)
        assert "docker compose down" not in script
        assert "docker volume rm" not in script
        assert "docker system prune" not in script
