from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
OFFSITE_SCRIPTS = (
    REPOSITORY_ROOT / "scripts" / "offsite_backup.ps1",
    REPOSITORY_ROOT / "scripts" / "offsite_backup.sh",
)


def test_offsite_backup_adapters_require_a_complete_backup_set_and_verify_hashes():
    for script_path in OFFSITE_SCRIPTS:
        script = script_path.read_text(encoding="utf-8")

        assert script_path.is_file()
        assert "manifest.json" in script
        assert "database.dump" in script
        assert "media.tar.gz" in script
        assert "sha256" in script.lower()
        assert "ARTFLOW_OFFSITE_BUCKET" in script
        assert "oss://" in script
        assert "ARTFLOW_OFFSITE_PREFIX" in script
        assert "ARTFLOW_OFFSITE_TOOL" in script
        assert "down --volumes" not in script
        assert "POSTGRES_PASSWORD" not in script


def test_offsite_backup_adapters_do_not_put_credentials_in_the_command_line_contract():
    for script_path in OFFSITE_SCRIPTS:
        script = script_path.read_text(encoding="utf-8").lower()

        assert "accesskey" not in script
        assert "secretkey" not in script
        assert "password=" not in script


def test_backup_wrappers_can_upload_a_verified_copy_when_offsite_is_configured():
    powershell = (REPOSITORY_ROOT / "scripts" / "backup_artflow.ps1").read_text(encoding="utf-8")
    posix = (REPOSITORY_ROOT / "scripts" / "backup.sh").read_text(encoding="utf-8")

    assert "offsite_backup.ps1" in powershell
    assert "ARTFLOW_OFFSITE_BUCKET" in powershell
    assert "offsite_backup.sh" in posix
    assert "ARTFLOW_OFFSITE_BUCKET" in posix
