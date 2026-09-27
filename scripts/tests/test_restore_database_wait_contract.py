from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
HELPER = REPOSITORY_ROOT / "scripts/restore_database_wait.ps1"
RESTORE_SCRIPTS = (
    REPOSITORY_ROOT / "scripts/verify_app_backup_restore.ps1",
    REPOSITORY_ROOT / "scripts/verify_postgres_backup_restore.ps1",
)


def test_restore_scripts_use_shared_stable_database_wait():
    for script_path in RESTORE_SCRIPTS:
        script = script_path.read_text(encoding="utf-8")

        assert "restore_database_wait.ps1" in script
        assert "Wait-ForStableRestoreDatabase" in script
        assert "-TimeoutSeconds 90" in script
        assert "pg_isready" not in script


def test_application_restore_uses_the_running_database_image_instead_of_a_drifted_tag():
    script = (REPOSITORY_ROOT / "scripts/verify_app_backup_restore.ps1").read_text(
        encoding="utf-8"
    )

    assert "compose -p $ComposeProjectName ps -q db" in script
    assert "inspect -f '{{.Config.Image}}' $dbContainer" in script
    assert "postgres:17-alpine" not in script


def test_backup_wrapper_targets_the_persistent_backup_mount_by_default():
    script = (REPOSITORY_ROOT / "scripts/backup_artflow.ps1").read_text(encoding="utf-8")

    assert "[string]$ContainerBackupBase = '/app/backups'" in script


def test_application_restore_verifies_backup_hashes_before_extracting_or_restoring():
    script = (REPOSITORY_ROOT / "scripts/verify_app_backup_restore.ps1").read_text(
        encoding="utf-8"
    )

    assert "ConvertFrom-Json" in script
    assert "database_sha256" in script
    assert "media_sha256" in script
    assert "Get-FileHash" in script
    assert script.index("Assert-BackupHash -Path") < script.index("$mediaExtractDir =")
    assert script.index("Assert-BackupHash -Path") < script.index(
        "Invoke-Docker -Arguments @('exec', $restoreContainer, 'pg_restore'"
    )


def test_application_restore_requires_the_running_web_image_to_match_manifest_sha():
    script = (REPOSITORY_ROOT / "scripts/verify_app_backup_restore.ps1").read_text(
        encoding="utf-8"
    )

    assert "$manifest.git_sha" in script
    assert "org.opencontainers.image.revision" in script
    assert "webImageRevision" in script
    assert "does not match the backup manifest" in script


def test_restore_wait_helper_requires_stable_final_postgres_server():
    helper = HELPER.read_text(encoding="utf-8")

    assert "PostgreSQL init process complete; ready for start up." in helper
    assert "docker logs" in helper
    assert "psql" in helper
    assert "SELECT 1;" in helper
    assert "Start-Sleep -Seconds 1" in helper
    assert "Write-RestoreContainerDiagnostics" in helper
    assert "$TimeoutSeconds" in helper


def test_restore_wait_failure_path_keeps_diagnostics_explicit():
    helper = HELPER.read_text(encoding="utf-8")

    diagnostics_call = "Write-RestoreContainerDiagnostics"
    assert helper.count(diagnostics_call) >= 2
    assert "inspect --format" in helper
    assert "--tail 80" in helper
