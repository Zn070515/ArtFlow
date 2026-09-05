import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PRODUCTION_COMPOSE_PATH = PROJECT_ROOT / "deploy" / "compose.production.yml"
EVENT_COMPOSE_PATH = PROJECT_ROOT / "deploy" / "compose.event.yml"
REHEARSAL_RUNBOOK_PATH = PROJECT_ROOT / "docs" / "production-rehearsal-runbook.md"
DOCKER = shutil.which("docker")


def load_compose(path: Path) -> dict[str, object]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def test_production_compose_keeps_the_authoritative_stack_private_except_for_proxy():
    compose = load_compose(PRODUCTION_COMPOSE_PATH)
    services = compose["services"]
    web = services["web"]
    db = services["db"]
    proxy = services["proxy"]

    assert web["environment"]["APP_ENV"] == "production"
    assert web["environment"]["DATABASE_ENGINE"] == "postgresql"
    assert "ports" not in web
    assert "ports" not in db
    assert set(web["networks"]) == {"artflow_internal"}
    assert set(db["networks"]) == {"artflow_internal"}
    assert set(proxy["networks"]) == {"artflow_frontend", "artflow_internal"}
    assert proxy["ports"] == ["80:80", "443:443"]
    assert "healthcheck" in db
    assert "healthcheck" in web
    assert compose["networks"]["artflow_internal"]["internal"] is True
    assert "postgres_data" in compose["volumes"]
    assert "media_data" in compose["volumes"]
    assert "artflow-local-container-password" not in PRODUCTION_COMPOSE_PATH.read_text(
        encoding="utf-8"
    )
    assert "reverse_proxy web:8000" in compose["configs"]["caddyfile"]["content"]


def test_event_compose_exposes_web_only_on_localhost():
    compose = load_compose(EVENT_COMPOSE_PATH)

    assert compose["services"]["web"]["ports"] == ["127.0.0.1:8000:8000"]
    assert "ports" not in compose["services"]["db"]
    assert compose["networks"]["artflow_internal"]["internal"] is True
    assert "postgres_data" in compose["volumes"]
    assert "media_data" in compose["volumes"]


def test_production_rehearsal_runbook_names_the_explicit_production_manifest():
    runbook = REHEARSAL_RUNBOOK_PATH.read_text(encoding="utf-8")

    assert "deploy/compose.production.yml" in runbook
    assert "docker compose -f deploy/compose.production.yml" in runbook


@pytest.mark.skipif(DOCKER is None, reason="Docker is required for Compose config validation")
def test_production_compose_config_renders_without_starting_services(
    monkeypatch: pytest.MonkeyPatch,
):
    required_environment = {
        "SECRET_KEY": "artflow-compose-config-test-secret-key-not-for-deployment-2026",
        "ADMIN_LOGIN_KEY": "artflow-compose-config-test-admin-key-not-for-deployment-2026",
        "ALLOWED_HOSTS": "artflow.internal",
        "CSRF_TRUSTED_ORIGINS": "https://artflow.internal",
        "POSTGRES_DB": "artflow",
        "POSTGRES_USER": "artflow",
        "POSTGRES_PASSWORD": "artflow-compose-config-test-database-password",
        "CADDY_SITE_ADDRESS": "artflow.internal",
    }
    for name, value in required_environment.items():
        monkeypatch.setenv(name, value)

    result = subprocess.run(
        [DOCKER, "compose", "-f", str(PRODUCTION_COMPOSE_PATH), "config", "--quiet"],
        cwd=PROJECT_ROOT,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    assert result.returncode == 0, result.stderr
