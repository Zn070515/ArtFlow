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
EVENT_ENV_EXAMPLE_PATH = PROJECT_ROOT / ".env.event.example"
DOCKER = shutil.which("docker")
DOCKERFILE_PATH = PROJECT_ROOT / "Dockerfile"
CONFIG_ENVIRONMENT = {
    "SECRET_KEY": "artflow-compose-config-test-secret-key-not-for-deployment-2026",
    "ADMIN_LOGIN_KEY": "artflow-compose-config-test-admin-key-not-for-deployment-2026",
    "ALLOWED_HOSTS": "artflow.internal",
    "CSRF_TRUSTED_ORIGINS": "https://artflow.internal",
    "POSTGRES_DB": "artflow",
    "POSTGRES_USER": "artflow",
    "POSTGRES_PASSWORD": "artflow-compose-config-test-database-password",
    "CADDY_SITE_ADDRESS": "artflow.internal",
    "ARTFLOW_RELEASE_SHA": "a" * 40,
    "ARTFLOW_PYTHON_IMAGE": "python:3.12-slim@sha256:" + "b" * 64,
    "ARTFLOW_POSTGRES_IMAGE": "postgres:16-alpine@sha256:" + "c" * 64,
    "ARTFLOW_CADDY_IMAGE": "caddy:2-alpine@sha256:" + "d" * 64,
    "ARTFLOW_WEB_IMAGE": "artflow-web:" + "a" * 40,
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
    assert web["environment"]["RATE_LIMIT_BACKEND"] == "database"
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
    assert "backup_data" in compose["volumes"]
    assert "backup_data:/app/backups" in web["volumes"]
    assert "artflow-local-container-password" not in PRODUCTION_COMPOSE_PATH.read_text(
        encoding="utf-8"
    )
    assert compose["configs"]["caddyfile"]["file"] == "./Caddyfile"
    caddyfile = (PRODUCTION_COMPOSE_PATH.parent / "Caddyfile").read_text(encoding="utf-8")
    assert "request_body" in caddyfile
    assert "max_size 120MB" in caddyfile
    assert "header -Server" in caddyfile
    assert "reverse_proxy web:8000" in caddyfile
    assert services["web"]["image"] == (
        "${ARTFLOW_WEB_IMAGE:?Set ARTFLOW_WEB_IMAGE to the prebuilt release image}"
    )


def test_production_images_are_digest_pinned_and_python_base_is_explicit():
    compose = load_compose(PRODUCTION_COMPOSE_PATH)
    services = compose["services"]

    assert services["db"]["image"] == "${ARTFLOW_POSTGRES_IMAGE:?Set ARTFLOW_POSTGRES_IMAGE}"
    assert services["proxy"]["image"] == "${ARTFLOW_CADDY_IMAGE:?Set ARTFLOW_CADDY_IMAGE}"
    assert services["web"]["image"] == (
        "${ARTFLOW_WEB_IMAGE:?Set ARTFLOW_WEB_IMAGE to the prebuilt release image}"
    )

    dockerfile = DOCKERFILE_PATH.read_text(encoding="utf-8")
    assert "ARG ARTFLOW_PYTHON_IMAGE=python:3.12-slim" in dockerfile


def test_event_compose_defaults_to_loopback_and_keeps_database_private():
    compose = load_compose(EVENT_COMPOSE_PATH)
    web_environment = compose["services"]["web"]["environment"]

    assert compose["services"]["web"]["ports"] == [
        "${ARTFLOW_EVENT_BIND_ADDRESS:-127.0.0.1}:${ARTFLOW_EVENT_PORT:-8000}:8000"
    ]
    assert "ports" not in compose["services"]["db"]
    assert web_environment["DATABASE_ENGINE"] == "postgresql"
    assert web_environment["RATE_LIMIT_BACKEND"] == "database"
    assert web_environment["ALLOWED_HOSTS"] == (
        "${ARTFLOW_EVENT_ALLOWED_HOSTS:-localhost,127.0.0.1}"
    )
    assert web_environment["CSRF_TRUSTED_ORIGINS"] == ""
    assert compose["networks"]["artflow_internal"]["internal"] is True
    assert "postgres_data" in compose["volumes"]
    assert "media_data" in compose["volumes"]
    assert "backup_data" in compose["volumes"]
    assert "backup_data:/app/backups" in compose["services"]["web"]["volumes"]
    event_manifest = EVENT_COMPOSE_PATH.read_text(encoding="utf-8").lower()
    assert "tunnel" not in event_manifest
    assert "ipv6" not in event_manifest


def test_compose_manifests_forward_optional_branding_to_web():
    for compose_path in (PRODUCTION_COMPOSE_PATH, EVENT_COMPOSE_PATH):
        compose = load_compose(compose_path)
        web_environment = compose["services"]["web"]["environment"]

        assert web_environment["ARTFLOW_ORGANIZATION_NAME"] == "${ARTFLOW_ORGANIZATION_NAME:-}"
        assert web_environment["ARTFLOW_ICP_NUMBER"] == "${ARTFLOW_ICP_NUMBER:-}"
        assert web_environment["ARTFLOW_ICP_URL"] == "${ARTFLOW_ICP_URL:-}"


def test_production_web_healthcheck_uses_internal_exempt_health_route():
    compose = load_compose(PRODUCTION_COMPOSE_PATH)
    healthcheck = compose["services"]["web"]["healthcheck"]["test"]

    assert "http://127.0.0.1:8000/healthz/" in healthcheck[-1]


def test_production_proxy_healthcheck_reaches_the_https_proxy_boundary():
    compose = load_compose(PRODUCTION_COMPOSE_PATH)
    healthcheck = compose["services"]["proxy"]["healthcheck"]["test"]

    assert "https://127.0.0.1/healthz/" in healthcheck[-1]
    assert "CADDY_SITE_ADDRESS" in healthcheck[-1]
    assert "no-check-certificate" in healthcheck[-1]


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
    assert values["ARTFLOW_ORGANIZATION_NAME"] == ""
    assert values["ARTFLOW_RELEASE_SHA"] == "replace-me-with-the-deployed-commit-sha"
    assert values["ARTFLOW_WEB_IMAGE"] == "artflow-web:replace-me-with-the-release-sha"
    assert "ARTFLOW_POSTGRES_IMAGE" in values
    assert "ARTFLOW_CADDY_IMAGE" in values
    assert "ARTFLOW_PYTHON_IMAGE" in values
    assert "manifest fixes" in PRODUCTION_ENV_EXAMPLE_PATH.read_text(encoding="utf-8")


def test_environment_examples_document_optional_public_metadata_and_staged_hsts():
    production = PRODUCTION_ENV_EXAMPLE_PATH.read_text(encoding="utf-8")
    event = EVENT_ENV_EXAMPLE_PATH.read_text(encoding="utf-8")

    for contents in (production, event):
        assert "ARTFLOW_ICP_NUMBER=" in contents
        assert "ARTFLOW_ICP_URL=" in contents
        assert "SECURE_HSTS_SECONDS=" in contents
        assert "SECURE_HSTS_INCLUDE_SUBDOMAINS=" in contents
        assert "SECURE_HSTS_PRELOAD=" in contents


def test_compose_manifests_forward_staged_hsts_configuration():
    production = load_compose(PRODUCTION_COMPOSE_PATH)["services"]["web"]["environment"]
    event = load_compose(EVENT_COMPOSE_PATH)["services"]["web"]["environment"]

    assert production["SECURE_HSTS_SECONDS"] == "${SECURE_HSTS_SECONDS:-300}"
    assert (
        production["SECURE_HSTS_INCLUDE_SUBDOMAINS"] == "${SECURE_HSTS_INCLUDE_SUBDOMAINS:-false}"
    )
    assert production["SECURE_HSTS_PRELOAD"] == "${SECURE_HSTS_PRELOAD:-false}"
    assert event["SECURE_HSTS_SECONDS"] == "${SECURE_HSTS_SECONDS:-0}"
    assert event["SECURE_HSTS_INCLUDE_SUBDOMAINS"] == "${SECURE_HSTS_INCLUDE_SUBDOMAINS:-false}"
    assert event["SECURE_HSTS_PRELOAD"] == "${SECURE_HSTS_PRELOAD:-false}"


def test_dockerfile_copies_every_runtime_local_app():
    dockerfile = DOCKERFILE_PATH.read_text(encoding="utf-8")

    assert "COPY --chown=artflow:artflow tickets ./tickets" in dockerfile


def test_dockerfile_prepares_writable_backup_mountpoint():
    dockerfile = DOCKERFILE_PATH.read_text(encoding="utf-8")

    assert "mkdir --parents /app/media /app/staticfiles /app/backups" in dockerfile
    assert (
        "chown --recursive artflow:artflow /app/media /app/staticfiles /app/backups" in dockerfile
    )


def test_production_image_bakes_and_validates_its_release_revision():
    dockerfile = DOCKERFILE_PATH.read_text(encoding="utf-8")
    entrypoint = (PROJECT_ROOT / "scripts" / "docker-entrypoint.sh").read_text(encoding="utf-8")

    assert "ARG ARTFLOW_BUILD_SHA" in dockerfile
    assert "org.opencontainers.image.revision" in dockerfile
    assert "/app/ARTFLOW_RELEASE_SHA" in dockerfile
    assert "ARTFLOW_RELEASE_SHA" in entrypoint
    assert "APP_ENV" in entrypoint
    assert "must match the baked image revision" in entrypoint


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
