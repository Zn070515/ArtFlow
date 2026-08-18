import shutil
import subprocess
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = PROJECT_ROOT / "scripts" / "verify_postgres_acceptance.ps1"
PWSH = shutil.which("pwsh")


def test_postgres_acceptance_script_defines_the_required_non_destructive_gate():
    script = SCRIPT_PATH.read_text(encoding="utf-8")

    assert "[switch]$StartCompose" in script
    assert "[switch]$VerifyResetSafety" in script
    assert "docker compose exec -T web" in script
    assert "python manage.py migrate --noinput" in script
    assert "python manage.py doctor" in script
    assert "/healthz/" in script
    assert script.count("python manage.py seed_demo_data") >= 2
    assert "python manage.py seed_demo_data --reset" in script
    assert "if ($VerifyResetSafety)" in script
    assert "python manage.py test" in script
    assert "down --volumes" not in script
    assert "Remove-Item" not in script


@pytest.mark.skipif(PWSH is None, reason="pwsh is required for PowerShell syntax checks")
def test_postgres_acceptance_script_has_valid_powershell_syntax():
    escaped_script_path = str(SCRIPT_PATH).replace("'", "''")
    parser_command = (
        "$parseErrors = $null; "
        "[System.Management.Automation.Language.Parser]::ParseFile("
        f"'{escaped_script_path}', [ref]$null, [ref]$parseErrors) | Out-Null; "
        "if ($parseErrors.Count -gt 0) { exit 1 }"
    )

    result = subprocess.run(
        [PWSH, "-NoProfile", "-Command", parser_command],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    assert result.returncode == 0, result.stderr
