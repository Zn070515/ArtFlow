import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, cast
from urllib.request import urlopen

import pytest
import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PRODUCTION_COMPOSE_PATH = PROJECT_ROOT / "deploy" / "compose.production.yml"
EVENT_COMPOSE_PATH = PROJECT_ROOT / "deploy" / "compose.event.yml"
LOCAL_COMPOSE_PATH = PROJECT_ROOT / "docker-compose.yml"
REHEARSAL_RUNBOOK_PATH = PROJECT_ROOT / "docs" / "production-rehearsal-runbook.md"
PRODUCTION_ENV_EXAMPLE_PATH = PROJECT_ROOT / ".env.production.example"
EVENT_ENV_EXAMPLE_PATH = PROJECT_ROOT / ".env.event.example"
DOCKER = shutil.which("docker")
DOCKERFILE_PATH = PROJECT_ROOT / "Dockerfile"
CADDY_RUNTIME_TEST_IMAGE = os.environ.get(
    "ARTFLOW_CADDY_TEST_IMAGE",
    "caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648",
)
REQUIRE_CADDY_RUNTIME = os.environ.get("ARTFLOW_REQUIRE_CADDY_RUNTIME") == "true"
REQUIRE_EVENT_RUNTIME = os.environ.get("ARTFLOW_REQUIRE_EVENT_RUNTIME") == "true"
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


def test_dockerfile_uses_the_postgresql_16_client_for_backup_compatibility():
    dockerfile = DOCKERFILE_PATH.read_text(encoding="utf-8")

    assert "apt.postgresql.org/pub/repos/apt" in dockerfile
    assert "postgresql-client-16" in dockerfile
    assert "postgresql-client\\n" not in dockerfile


def test_event_compose_defaults_to_loopback_and_keeps_database_private():
    compose = load_compose(EVENT_COMPOSE_PATH)
    services = compose["services"]
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
    assert set(services["web"]["networks"]) == {
        "artflow_event_frontend",
        "artflow_internal",
    }
    assert set(services["db"]["networks"]) == {"artflow_internal"}
    assert compose["networks"]["artflow_event_frontend"]["internal"] is False
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


def test_local_compose_forwards_release_sha_to_the_built_web_image():
    web = load_compose(LOCAL_COMPOSE_PATH)["services"]["web"]

    assert web["build"]["args"]["ARTFLOW_BUILD_SHA"] == "${ARTFLOW_RELEASE_SHA:-}"
    assert web["environment"]["ARTFLOW_RELEASE_SHA"] == "${ARTFLOW_RELEASE_SHA:-}"


def test_production_web_healthcheck_uses_internal_exempt_health_route():
    compose = load_compose(PRODUCTION_COMPOSE_PATH)
    healthcheck = compose["services"]["web"]["healthcheck"]["test"]

    assert "http://127.0.0.1:8000/healthz/" in healthcheck[-1]


def test_production_proxy_healthcheck_uses_the_internal_http_listener():
    compose = load_compose(PRODUCTION_COMPOSE_PATH)
    healthcheck = compose["services"]["proxy"]["healthcheck"]["test"]

    assert "http://127.0.0.1:8081/healthz/" in healthcheck[-1]
    assert "https://127.0.0.1" not in healthcheck[-1]
    assert "no-check-certificate" not in healthcheck[-1]


def test_production_proxy_healthcheck_succeeds_against_a_running_caddy_proxy(
    tmp_path: Path,
):
    if DOCKER is None:
        if REQUIRE_CADDY_RUNTIME:
            pytest.fail("Docker is required for the mandatory Caddy runtime validation")
        pytest.skip("Docker is required for Caddy runtime validation")

    docker = docker_command()
    image_check = subprocess.run(
        [docker, "image", "inspect", CADDY_RUNTIME_TEST_IMAGE],
        check=False,
        capture_output=True,
        text=True,
    )
    if image_check.returncode != 0:
        if REQUIRE_CADDY_RUNTIME:
            pytest.fail(f"Pinned Caddy runtime image is not available: {CADDY_RUNTIME_TEST_IMAGE}")
        pytest.skip("pinned Caddy runtime image is not available locally")

    network = f"artflow-caddy-health-{uuid.uuid4().hex[:12]}"
    backend = f"{network}-web"
    proxy = f"{network}-proxy"
    backend_caddyfile = tmp_path / "backend.Caddyfile"
    backend_caddyfile.write_text(":8000 {\n\trespond /healthz/ 200\n}\n", encoding="utf-8")
    caddyfile = (PRODUCTION_COMPOSE_PATH.parent / "Caddyfile").resolve()

    def run(*arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [docker, *arguments],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    try:
        assert run("network", "create", network).returncode == 0
        backend_result = run(
            "run",
            "-d",
            "--name",
            backend,
            "--network",
            network,
            "--network-alias",
            "web",
            "--mount",
            f"type=bind,source={backend_caddyfile},target=/etc/caddy/Caddyfile,readonly",
            CADDY_RUNTIME_TEST_IMAGE,
            "caddy",
            "run",
            "--config",
            "/etc/caddy/Caddyfile",
            "--adapter",
            "caddyfile",
        )
        assert backend_result.returncode == 0, backend_result.stderr
        proxy_result = run(
            "run",
            "-d",
            "--name",
            proxy,
            "--network",
            network,
            "-e",
            "CADDY_SITE_ADDRESS=localhost",
            "--mount",
            f"type=bind,source={caddyfile},target=/etc/caddy/Caddyfile,readonly",
            CADDY_RUNTIME_TEST_IMAGE,
            "caddy",
            "run",
            "--config",
            "/etc/caddy/Caddyfile",
            "--adapter",
            "caddyfile",
        )
        assert proxy_result.returncode == 0, proxy_result.stderr

        healthcheck = "wget --no-verbose --tries=1 --spider http://127.0.0.1:8081/healthz/"
        last_result = ""
        for _ in range(20):
            health_result = run("exec", proxy, "sh", "-ec", healthcheck)
            if health_result.returncode == 0:
                break
            last_result = health_result.stderr or health_result.stdout
            time.sleep(1)
        else:
            logs = run("logs", "--tail", "80", proxy)
            pytest.fail(f"Caddy healthcheck did not pass: {last_result}\n{logs.stdout}")
    finally:
        run("rm", "-f", proxy, backend)
        run("network", "rm", network)


@pytest.mark.skipif(DOCKER is None, reason="Docker is required for event runtime validation")
def test_event_runtime_publishes_only_the_loopback_web_port():
    if not REQUIRE_EVENT_RUNTIME:
        pytest.skip("event runtime validation is opt-in")

    docker = docker_command()
    image_check = subprocess.run(
        [docker, "image", "inspect", CADDY_RUNTIME_TEST_IMAGE],
        check=False,
        capture_output=True,
        text=True,
    )
    if image_check.returncode != 0:
        pytest.fail(f"Pinned Caddy runtime image is not available: {CADDY_RUNTIME_TEST_IMAGE}")

    project_name = f"artflow-event-runtime-{uuid.uuid4().hex[:12]}"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        event_port = probe.getsockname()[1]

    with tempfile.TemporaryDirectory(prefix="artflow-event-runtime-") as temp_dir:
        env_path = Path(temp_dir) / ".env.event"
        caddyfile_path = Path(temp_dir) / "Caddyfile"
        override_path = Path(temp_dir) / "compose.override.yml"
        env_path.write_text(
            "\n".join(
                [
                    "APP_ENV=development",
                    "DEBUG=False",
                    "SECRET_KEY=event-runtime-test-secret",
                    "ADMIN_LOGIN_KEY=event-runtime-test-admin-key",
                    "POSTGRES_DB=event_runtime",
                    "POSTGRES_USER=event_runtime",
                    "POSTGRES_PASSWORD=event-runtime-test-database-password",
                    f"ARTFLOW_RELEASE_SHA={'a' * 40}",
                    "ARTFLOW_EVENT_BIND_ADDRESS=127.0.0.1",
                    f"ARTFLOW_EVENT_PORT={event_port}",
                    "ARTFLOW_EVENT_ALLOWED_HOSTS=localhost,127.0.0.1",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        caddyfile_path.write_text(":8000 {\n\trespond /healthz/ 200\n}\n", encoding="utf-8")
        override_path.write_text(
            yaml.safe_dump(
                {
                    "services": {
                        "web": {
                            "image": CADDY_RUNTIME_TEST_IMAGE,
                            "entrypoint": ["caddy"],
                            "command": [
                                "run",
                                "--config",
                                "/etc/caddy/Caddyfile",
                                "--adapter",
                                "caddyfile",
                            ],
                            "volumes": [
                                f"{caddyfile_path}:/etc/caddy/Caddyfile:ro",
                            ],
                            "healthcheck": {
                                "test": [
                                    "CMD",
                                    "wget",
                                    "--no-verbose",
                                    "--tries=1",
                                    "--spider",
                                    "http://127.0.0.1:8000/healthz/",
                                ],
                                "interval": "2s",
                                "timeout": "3s",
                                "retries": 12,
                                "start_period": "2s",
                            },
                        }
                    }
                }
            ),
            encoding="utf-8",
        )

        compose = [
            docker,
            "compose",
            "--project-name",
            project_name,
            "--env-file",
            str(env_path),
            "-f",
            str(EVENT_COMPOSE_PATH),
            "-f",
            str(override_path),
        ]

        def run(*arguments: str, timeout: int = 600) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [*compose, *arguments],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
            )

        try:
            up = run("up", "--no-build", "--wait")
            assert up.returncode == 0, "\n".join((up.stdout + up.stderr).splitlines()[-80:])

            web_port = run("port", "web", "8000")
            assert web_port.returncode == 0, web_port.stderr
            assert web_port.stdout.strip() == f"127.0.0.1:{event_port}"

            db_container = run("ps", "-q", "db")
            assert db_container.returncode == 0
            assert db_container.stdout.strip()
            db_ports = subprocess.run(
                [
                    docker,
                    "inspect",
                    db_container.stdout.strip(),
                    "--format",
                    "{{json .NetworkSettings.Ports}}",
                ],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            assert db_ports.returncode == 0, db_ports.stderr
            assert json.loads(db_ports.stdout) == {"5432/tcp": None}

            with urlopen(f"http://127.0.0.1:{event_port}/healthz/", timeout=10) as response:
                assert response.status == 200
        finally:
            run("down", "--remove-orphans", "--volumes", timeout=120)


def test_production_rehearsal_runbook_names_the_explicit_production_manifest():
    runbook = REHEARSAL_RUNBOOK_PATH.read_text(encoding="utf-8")

    assert "deploy/compose.production.yml" in runbook
    assert "bash scripts/deploy.sh .env.production" in runbook


def test_production_documentation_uses_the_canonical_deploy_entrypoint():
    deployment = (PROJECT_ROOT / "docs" / "deployment-production.md").read_text(encoding="utf-8")

    assert "bash scripts/deploy.sh .env.production" in deployment
    assert "canonical production deployment path" in deployment


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
    assert "http://127.0.0.1:8081 {" in caddyfile
    assert "https://{$CADDY_SITE_ADDRESS} {" in caddyfile
    assert "{artflow.internal}" not in caddyfile


@pytest.mark.skipif(DOCKER is None, reason="Docker is required for Caddy adaptation validation")
def test_rendered_caddyfile_adapts_when_caddy_image_is_available(
    monkeypatch: pytest.MonkeyPatch,
):
    for name, value in CONFIG_ENVIRONMENT.items():
        monkeypatch.setenv(name, value)
    docker = docker_command()

    image_check = subprocess.run(
        [docker, "image", "inspect", CADDY_RUNTIME_TEST_IMAGE],
        check=False,
        capture_output=True,
        text=True,
    )
    if image_check.returncode != 0:
        pytest.skip("pinned Caddy runtime image is not available locally")

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
            CADDY_RUNTIME_TEST_IMAGE,
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
