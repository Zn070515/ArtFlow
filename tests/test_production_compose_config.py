import shutil
import subprocess
from pathlib import Path
from typing import Any, cast

import pytest
import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PRODUCTION_COMPOSE_PATH = PROJECT_ROOT / "deploy" / "compose.production.yml"
EVENT_COMPOSE_PATH = PROJECT_ROOT / "deploy" / "compose.event.yml"
REHEARSAL_RUNBOOK_PATH = PROJECT_ROOT / "docs" / "production-rehearsal-runbook.md"
PRODUCTION_ENV_EXAMPLE_PATH = PROJECT_ROOT / ".env.production.example"
DOCKER = shutil.which("docker")
CONFIG_ENVIRONMENT = {
    "SECRET_KEY": "artflow-compose-config-test-secret-key-not-for-deployment-2026",
    "ADMIN_LOGIN_KEY": "artflow-compose-config-test-admin-key-not-for-deployment-2026",
    "ALLOWED_HOSTS": "artflow.internal",
    "CSRF_TRUSTED_ORIGINS": "https://artflow.internal",
    "POSTGRES_DB": "artflow",
    "POSTGRES_USER": "artflow",
    "POSTGRES_PASSWORD": "artflow-compose-config-test-database-password",
    "CADDY_SITE_ADDRESS": "artflow.internal",
}


def load_compose(path: Path) -> dict[str, Any]:
    return cast(dict[str, Any], yaml.safe_load(path.read_text(encoding="utf-8")))


def docker_command() -> str:
    assert DOCKER is not None
    return DOCKER


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
    assert compose["configs"]["caddyfile"]["file"] == "./Caddyfile"
    assert "reverse_proxy web:8000" in (PRODUCTION_COMPOSE_PATH.parent / "Caddyfile").read_text(
        encoding="utf-8"
    )


def test_event_compose_exposes_web_only_on_localhost():
    compose = load_compose(EVENT_COMPOSE_PATH)
    web_environment = compose["services"]["web"]["environment"]

    assert compose["services"]["web"]["ports"] == ["127.0.0.1:8000:8000"]
    assert "ports" not in compose["services"]["db"]
    assert web_environment["DATABASE_ENGINE"] == "postgresql"
    assert web_environment["RATE_LIMIT_BACKEND"] == "database"
    assert web_environment["ALLOWED_HOSTS"] == "localhost,127.0.0.1"
    assert web_environment["CSRF_TRUSTED_ORIGINS"] == ""
    assert compose["networks"]["artflow_internal"]["internal"] is True
    assert "postgres_data" in compose["volumes"]
    assert "media_data" in compose["volumes"]
    event_manifest = EVENT_COMPOSE_PATH.read_text(encoding="utf-8").lower()
    assert "tunnel" not in event_manifest
    assert "ipv6" not in event_manifest


def test_production_web_healthcheck_uses_internal_exempt_health_route():
    compose = load_compose(PRODUCTION_COMPOSE_PATH)
    healthcheck = compose["services"]["web"]["healthcheck"]["test"]

    assert "http://127.0.0.1:8000/healthz/" in healthcheck[-1]


def test_production_rehearsal_runbook_names_the_explicit_production_manifest():
    runbook = REHEARSAL_RUNBOOK_PATH.read_text(encoding="utf-8")

    assert "deploy/compose.production.yml" in runbook
    assert "docker compose -f deploy/compose.production.yml" in runbook


def test_production_env_example_documents_manifest_fixed_values():
    values = {}
    for line in PRODUCTION_ENV_EXAMPLE_PATH.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            name, value = line.split("=", 1)
            values[name] = value

    assert values["TRUST_X_FORWARDED_FOR"] == "true"
    assert values["POSTGRES_HOST"] == "db"
    assert "manifest fixes" in PRODUCTION_ENV_EXAMPLE_PATH.read_text(encoding="utf-8")


@pytest.mark.skipif(DOCKER is None, reason="Docker is required for Compose config validation")
def test_production_compose_config_renders_without_starting_services(
    monkeypatch: pytest.MonkeyPatch,
):
    for name, value in CONFIG_ENVIRONMENT.items():
        monkeypatch.setenv(name, value)
    docker = docker_command()

    result = subprocess.run(
        [docker, "compose", "-f", str(PRODUCTION_COMPOSE_PATH), "config", "--quiet"],
        cwd=PROJECT_ROOT,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(DOCKER is None, reason="Docker is required for rendered Caddy validation")
def test_rendered_production_compose_preserves_caddy_environment_placeholder(
    monkeypatch: pytest.MonkeyPatch,
):
    for name, value in CONFIG_ENVIRONMENT.items():
        monkeypatch.setenv(name, value)
    docker = docker_command()

    result = subprocess.run(
        [docker, "compose", "-f", str(PRODUCTION_COMPOSE_PATH), "config"],
        cwd=PROJECT_ROOT,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    assert result.returncode == 0, result.stderr
    rendered = cast(dict[str, Any], yaml.safe_load(result.stdout))
    caddyfile_path = PRODUCTION_COMPOSE_PATH.parent / rendered["configs"]["caddyfile"]["file"]
    caddyfile = caddyfile_path.read_text(encoding="utf-8")
    assert caddyfile.startswith("{$CADDY_SITE_ADDRESS} {")
    assert "{artflow.internal}" not in caddyfile


@pytest.mark.skipif(DOCKER is None, reason="Docker is required for Caddy adaptation validation")
def test_rendered_caddyfile_adapts_when_caddy_image_is_available(
    monkeypatch: pytest.MonkeyPatch,
):
    for name, value in CONFIG_ENVIRONMENT.items():
        monkeypatch.setenv(name, value)
    docker = docker_command()

    image_check = subprocess.run(
        [docker, "image", "inspect", "caddy:2-alpine"],
        check=False,
        capture_output=True,
        text=True,
    )
    if image_check.returncode != 0:
        pytest.skip("caddy:2-alpine image is not available locally")

    compose_result = subprocess.run(
        [docker, "compose", "-f", str(PRODUCTION_COMPOSE_PATH), "config"],
        cwd=PROJECT_ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    rendered = cast(dict[str, Any], yaml.safe_load(compose_result.stdout))
    caddyfile_path = PRODUCTION_COMPOSE_PATH.parent / rendered["configs"]["caddyfile"]["file"]
    result = subprocess.run(
        [
            docker,
            "run",
            "--rm",
            "-i",
            "--network",
            "none",
            "-e",
            "CADDY_SITE_ADDRESS=artflow.internal",
            "caddy:2-alpine",
            "caddy",
            "adapt",
            "--config",
            "/dev/stdin",
            "--adapter",
            "caddyfile",
        ],
        input=caddyfile_path.read_text(encoding="utf-8"),
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    assert result.returncode == 0, result.stderr
    assert '"artflow.internal"' in result.stdout
