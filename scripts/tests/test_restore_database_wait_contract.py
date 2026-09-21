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
