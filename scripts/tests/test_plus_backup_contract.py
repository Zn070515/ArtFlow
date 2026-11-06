from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(relative_path: str) -> str:
    path = ROOT / relative_path
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def test_backup_covers_plus_database_archive_and_media() -> None:
    script = read("scripts/backup_plus.sh")

    assert script.startswith("#!/usr/bin/env bash\nset -Eeuo pipefail")
    assert "umask 077" in script
    assert "MSYS_NO_PATHCONV" in script
    assert "docker_host_path" in script
    assert "cygpath" in script
    assert "python_bin" in script
    assert 'docker_host_path "$backup_set/archives.tar.gz"' in script
    assert "--profile plus" in script
    assert "plus-db" in script and "plus-api" in script
    assert "plus-worker" in script and "plus-web" in script
    assert "pg_dump" in script
    assert "plus_archive_data" in script
    assert "plus_media_data" in script
    assert "manifest.json" in script
    assert "database_sha256" in script
    assert "archives_sha256" in script
    assert "media_sha256" in script
    assert "sha256sum" in script
    assert "LOCK TABLE" in script
    assert "IN SHARE ROW EXCLUSIVE MODE" in script
    assert "ARTFLOW_PLUS_BACKUP_LOCKED" in script
    assert "coproc ARTFLOW_BACKUP_BARRIER" in script
    assert "barrier_exec_pid" in script
    assert "pg_sleep" not in script
    assert "docker exec -d" not in script
    assert "mkfifo" not in script
    assert "c.relkind IN ('r', 'p')" in script
    assert "database_table_counts" in script
    assert "database_image_id" in script
    assert "api_image_id" in script
    assert "worker_image_id" in script
    assert "web_image_id" in script
    assert "sys.version_info >= (3, 12)" in script


def test_restore_isolated_and_never_resets_source() -> None:
    script = read("scripts/restore_plus_verify.sh")

    assert script.startswith("#!/usr/bin/env bash\nset -Eeuo pipefail")
    assert "sys.version_info >= (3, 12)" in script
    assert "MSYS_NO_PATHCONV" in script
    assert "docker_host_path" in script
    assert "cygpath" in script
    assert "python_bin" in script
    assert 'docker_host_path "$manifest"' in script
    assert "manifest_values[$index]" in script
    assert "--profile plus" in script
    assert "pg_restore" in script
    assert "kysely_migration" in script
    assert "tarfile" in script
    assert "symlink" in script
    assert "hardlink" in script
    assert "find_bin" in script
    assert 'filter="data"' in script
    assert "NODE_ENV=production" in script
    assert "APP_ENV=production" in script
    assert "restore_worker_container" in script
    assert "restore_web_container" in script
    assert "database_table_counts" in script
    assert "database_image_id" in script
    assert "worker_image_id" in script
    assert "web_image_id" in script
    assert 'docker network create --internal "$restore_network"' in script
    assert '"$manifest_api_image_id" main.cjs' in script
    assert '"$manifest_worker_image_id" main.cjs' in script
    assert '"$manifest_web_image_id"' in script
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
    assert "真实活动彩排" not in cutover_runbook
    assert "会阻塞写入" in backup_restore_doc
    assert "Python 3.12" in backup_restore_doc


def test_active_plus_entry_docs_do_not_schedule_activity_rehearsal() -> None:
    for relative_path in (
        "docs/artflow-plus/README.md",
        "docs/artflow-plus/roadmap.md",
        "docs/artflow-plus/cutover-runbook.md",
    ):
        assert "真实活动" not in read(relative_path)


def test_scripts_do_not_reset_source_compose_state() -> None:
    for relative_path in ("scripts/backup_plus.sh", "scripts/restore_plus_verify.sh"):
        script = read(relative_path)
        assert "docker compose down" not in script
        assert "docker volume rm" not in script
        assert "docker system prune" not in script


def test_plus_entrypoints_validate_release_before_migration() -> None:
    api = read("plus/apps/api/src/main.ts")
    worker = read("plus/apps/worker/src/main.ts")

    for entrypoint in (api, worker):
        assert entrypoint.index("assertReleaseProvenance();") < entrypoint.index("migrate(db)")
