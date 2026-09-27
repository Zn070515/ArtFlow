from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
POSIX_SCRIPTS = (
    REPOSITORY_ROOT / "scripts" / "deploy.sh",
    REPOSITORY_ROOT / "scripts" / "backup.sh",
    REPOSITORY_ROOT / "scripts" / "restore-verify.sh",
)


def test_posix_operations_scripts_are_present_and_non_destructive():
    for script_path in POSIX_SCRIPTS:
        script = script_path.read_text(encoding="utf-8")

        assert script.startswith("#!/usr/bin/env bash")
        assert "set -Eeuo pipefail" in script
        assert "docker compose" in script or "docker" in script
        assert "docker compose down --volumes" not in script
        assert "DROP DATABASE" not in script.upper()


def test_posix_deploy_and_restore_scripts_keep_release_and_backup_boundaries():
    deploy = (REPOSITORY_ROOT / "scripts" / "deploy.sh").read_text(encoding="utf-8")
    backup = (REPOSITORY_ROOT / "scripts" / "backup.sh").read_text(encoding="utf-8")
    restore = (REPOSITORY_ROOT / "scripts" / "restore-verify.sh").read_text(encoding="utf-8")
    build = (REPOSITORY_ROOT / "scripts" / "build_release.sh").read_text(encoding="utf-8")

    assert "ARTFLOW_RELEASE_SHA" in deploy
    assert "ARTFLOW_POSTGRES_IMAGE" in deploy
    assert "ARTFLOW_CADDY_IMAGE" in deploy
    assert "@sha256:" in deploy
    assert "ARTFLOW_PYTHON_IMAGE" in build
    assert "ARTFLOW_BUILD_SHA" in build
    assert "docker save" in build
    assert "--wait" in deploy
    assert "/healthz/" in deploy
    assert "backup_artflow" in backup
    assert "/app/backups" in backup
    assert "pg_restore" in restore
    assert "verify_app_backup" in restore
    assert "org.opencontainers.image.revision" in restore
