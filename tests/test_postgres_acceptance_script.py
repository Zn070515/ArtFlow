import os
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
    assert "Get-Command docker -CommandType Application" in script
    assert "Select-Object -First 1" in script
    assert "@('exec', '-T', 'web', 'sh', '-lc', $Command)" in script
    assert "Push-Location $repositoryRoot" in script
    assert "finally" in script
    assert "Pop-Location" in script
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


def create_fake_docker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    fake_docker_directory = tmp_path / "fake-docker"
    fake_docker_directory.mkdir()
    log_path = tmp_path / "docker.log"

    if os.name == "nt":
        docker_path = fake_docker_directory / "docker.cmd"
        docker_path.write_text(
            '@echo off\npwsh -NoProfile -File "%~dp0docker-fake.ps1" %*\nexit /b %ERRORLEVEL%\n',
            encoding="utf-8",
        )
        (fake_docker_directory / "docker-fake.ps1").write_text(
            "$argumentsText = [string]::Join(' ', $args)\n"
            '"$((Get-Location).Path)|$argumentsText" | '
            "Add-Content -LiteralPath $env:FAKE_DOCKER_LOG\n"
            "if ($env:FAKE_DOCKER_FAIL_TEXT -and "
            "$argumentsText.Contains($env:FAKE_DOCKER_FAIL_TEXT)) { exit 23 }\n",
            encoding="utf-8",
        )
    else:
        docker_path = fake_docker_directory / "docker"
        docker_path.write_text(
            "#!/bin/sh\n"
            'printf \'%s|%s\\n\' "$PWD" "$*" >> "$FAKE_DOCKER_LOG"\n'
            'if [ -n "$FAKE_DOCKER_FAIL_TEXT" ]; then\n'
            '  case "$*" in *"$FAKE_DOCKER_FAIL_TEXT"*) exit 23;; esac\n'
            "fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        docker_path.chmod(0o755)

    monkeypatch.setenv("FAKE_DOCKER_LOG", str(log_path))
    monkeypatch.setenv("FAKE_DOCKER_FAIL_TEXT", "")
    monkeypatch.setenv("PATH", f"{fake_docker_directory}{os.pathsep}{os.environ['PATH']}")
    return log_path


def run_acceptance_script(
    tmp_path: Path,
    *arguments: str,
) -> subprocess.CompletedProcess[str]:
    caller_directory = tmp_path / "caller"
    caller_directory.mkdir()
    return subprocess.run(
        [PWSH, "-NoProfile", "-File", str(SCRIPT_PATH), *arguments],
        cwd=caller_directory,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def normalize_docker_command(command: str) -> str:
    if ' sh -lc "' in command:
        return command.replace(' sh -lc "', " sh -lc ", 1).removesuffix('"')
    return command


def read_docker_log(log_path: Path) -> list[tuple[Path, str]]:
    return [
        (Path(cwd), normalize_docker_command(command))
        for line in log_path.read_text(encoding="utf-8").splitlines()
        for cwd, command in [line.split("|", maxsplit=1)]
    ]


@pytest.mark.skipif(PWSH is None, reason="pwsh is required for fake-Docker runtime tests")
def test_postgres_acceptance_default_order_uses_repository_root_and_has_no_teardown(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    log_path = create_fake_docker(tmp_path, monkeypatch)

    result = run_acceptance_script(tmp_path)

    assert result.returncode == 0, result.stderr
    commands = read_docker_log(log_path)
    assert [cwd.resolve() for cwd, _ in commands] == [PROJECT_ROOT] * len(commands)
    command_text = [command for _, command in commands]
    assert command_text[:2] == [
        "compose exec -T web sh -lc python manage.py migrate --noinput",
        "compose exec -T web sh -lc python manage.py doctor",
    ]
    assert command_text[2].startswith("compose exec -T web sh -lc python -c ")
    assert "urlopen('http://127.0.0.1:8000/healthz/', timeout=3)" in command_text[2]
    assert command_text[3:] == [
        "compose exec -T web sh -lc python manage.py seed_demo_data",
        "compose exec -T web sh -lc python manage.py seed_demo_data",
        "compose exec -T web sh -lc python manage.py test",
    ]
    assert not any(" down" in command for _, command in commands)


@pytest.mark.skipif(PWSH is None, reason="pwsh is required for fake-Docker runtime tests")
def test_postgres_acceptance_starts_compose_and_runs_reset_only_when_requested(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    log_path = create_fake_docker(tmp_path, monkeypatch)

    result = run_acceptance_script(tmp_path, "-StartCompose", "-VerifyResetSafety")

    assert result.returncode == 0, result.stderr
    commands = [command for _, command in read_docker_log(log_path)]
    assert commands[0] == "compose up --build --wait"
    assert commands[6:8] == [
        "compose exec -T web sh -lc python manage.py seed_demo_data --reset",
        "compose exec -T web sh -lc python manage.py seed_demo_data",
    ]
    assert commands[-1] == "compose exec -T web sh -lc python manage.py test"


@pytest.mark.skipif(PWSH is None, reason="pwsh is required for fake-Docker runtime tests")
def test_postgres_acceptance_stops_after_a_failed_docker_command(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    log_path = create_fake_docker(tmp_path, monkeypatch)
    monkeypatch.setenv("FAKE_DOCKER_FAIL_TEXT", "python manage.py doctor")

    result = run_acceptance_script(tmp_path)

    assert result.returncode != 0
    assert [command for _, command in read_docker_log(log_path)] == [
        "compose exec -T web sh -lc python manage.py migrate --noinput",
        "compose exec -T web sh -lc python manage.py doctor",
    ]
