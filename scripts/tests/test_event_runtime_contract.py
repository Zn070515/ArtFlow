from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
EVENT_LAUNCHER_PATH = PROJECT_ROOT / "scripts" / "start-event.ps1"
EVENT_ENV_EXAMPLE_PATH = PROJECT_ROOT / ".env.event.example"


def read_if_present(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def test_event_launcher_declares_safe_runtime_contract():
    launcher = read_if_present(EVENT_LAUNCHER_PATH)

    assert EVENT_LAUNCHER_PATH.is_file()
    assert "[switch]$Lan" in launcher
    assert "[ValidateRange(1024, 65535)]" in launcher
    assert "[int]$Port = 8000" in launcher
    assert "[string]$HostAddress" in launcher
    assert "ARTFLOW_EVENT_BIND_ADDRESS" in launcher
    assert "ARTFLOW_EVENT_PORT" in launcher
    assert "ARTFLOW_EVENT_ALLOWED_HOSTS" in launcher
    assert "docker compose" in launcher
    assert "@('up', '--build', '--detach')" in launcher
    assert "'manage.py', 'doctor', '--require-access-keys'" in launcher
    assert "/healthz/" in launcher
    assert "Test-UsableIpv4" in launcher
    assert "Get-LocalIpv4" in launcher
    assert "$HostAddress.Trim()" in launcher
    assert "Admin registration URL:" in launcher
    assert "Invoke-ComposeDiagnostics" in launcher
    assert "logs --tail 80 web db" in launcher
    assert "POSTGRES_PASSWORD" in launcher


def test_event_launcher_waits_on_the_mandatory_set_not_on_every_container():
    """The launcher's success criterion is the site, not every container's health.

    `docker compose up --wait` exits non-zero when any container with a healthcheck is
    unhealthy — verified against Compose 2.x with a dependency graph of exactly this
    shape. An unhealthy Redis therefore aborted the launcher even though `proxy` and the
    HTTP origin were already serving, and even though the event manifest no longer gates
    anything on Redis's health. The launcher now starts detached and waits on the
    mandatory services by name, the same set scripts/monitor.sh enforces at runtime.
    """
    launcher = read_if_present(EVENT_LAUNCHER_PATH)
    monitor = read_if_present(PROJECT_ROOT / "scripts" / "monitor.sh")

    assert "--wait'" not in launcher
    assert "$mandatoryServices = @('db', 'web', 'media', 'proxy')" in launcher
    assert "Wait-ForMandatoryServices -Services $mandatoryServices" in launcher
    # The same split in both places, or the launcher and the monitor disagree about
    # whether the show is running.
    assert "for service in db web media proxy; do" in monitor


def test_event_launcher_does_not_add_unsafe_network_or_data_operations():
    launcher = read_if_present(EVENT_LAUNCHER_PATH)

    assert "down --volumes" not in launcher
    assert "New-NetFirewallRule" not in launcher
    assert "cloudflared" not in launcher.lower()
    assert "docker run" not in launcher
    assert "DROP DATABASE" not in launcher.upper()
    assert "seed_demo_data --reset" not in launcher
    assert "Write-Host $env:" not in launcher


def test_event_environment_example_is_non_secret_and_loopback_neutral():
    environment = read_if_present(EVENT_ENV_EXAMPLE_PATH)

    assert EVENT_ENV_EXAMPLE_PATH.is_file()
    assert "SECRET_KEY=change-me" in environment
    assert "STAFF_ACCESS_KEY=change-me" in environment
    assert "ADMIN_ACCESS_KEY=change-me" in environment
    assert "POSTGRES_PASSWORD=change-me" in environment
    assert "ARTFLOW_ORGANIZATION_NAME=" in environment
    assert "ARTFLOW_EVENT_BIND_ADDRESS=0.0.0.0" not in environment
    assert "ARTFLOW_EVENT_ALLOWED_HOSTS=" not in environment
    assert "浙江工业大学" not in environment
