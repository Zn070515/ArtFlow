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
    assert "@('up', '--build', '--wait')" in launcher
    assert "'manage.py', 'doctor'" in launcher
    assert "/healthz/" in launcher
    assert "Test-UsableIpv4" in launcher
    assert "Get-LocalIpv4" in launcher
    assert "$HostAddress.Trim()" in launcher


def test_event_launcher_does_not_add_unsafe_network_or_data_operations():
    launcher = read_if_present(EVENT_LAUNCHER_PATH)

    assert "down --volumes" not in launcher
    assert "New-NetFirewallRule" not in launcher
    assert "cloudflared" not in launcher.lower()
    assert "docker run" not in launcher
    assert "DROP DATABASE" not in launcher.upper()
    assert "seed_demo_data --reset" not in launcher


def test_event_environment_example_is_non_secret_and_loopback_neutral():
    environment = read_if_present(EVENT_ENV_EXAMPLE_PATH)

    assert EVENT_ENV_EXAMPLE_PATH.is_file()
    assert "SECRET_KEY=change-me" in environment
    assert "ADMIN_LOGIN_KEY=change-me" in environment
    assert "POSTGRES_PASSWORD=change-me" in environment
    assert "ARTFLOW_ORGANIZATION_NAME=" in environment
    assert "ARTFLOW_EVENT_BIND_ADDRESS=0.0.0.0" not in environment
    assert "ARTFLOW_EVENT_ALLOWED_HOSTS=" not in environment
    assert "浙江工业大学" not in environment
