"""Gate for DEPL-01/02/03/07.

These rules are durable deployment invariants, not release-day patches:
a version tag is the only publish authority, the image bakes the tagged SHA,
static assets are replaced rather than layered, the optional workers can
render error pages, and every documented knob is actually forwarded.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER_VARS = {
    "ARTFLOW_EVENT_ALLOWED_HOSTS",
    "ARTFLOW_EVENT_BIND_ADDRESS",
    "ARTFLOW_EVENT_PORT",
}


def _yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _trigger(data: dict) -> dict:
    # PyYAML resolves the bare key `on` to the boolean True under YAML 1.1.
    return data.get("on") or data.get(True) or {}


def test_publish_is_tag_only_and_bakes_the_tagged_commit() -> None:
    data = _yaml(ROOT / ".github" / "workflows" / "publish.yml")
    trigger = _trigger(data)
    assert "branches" not in trigger.get("push", {})
    assert trigger["push"]["tags"] == ["v*"]
    permissions = data["permissions"]
    for scope in ("packages", "attestations", "id-token"):
        assert permissions[scope] == "write"
    text = (ROOT / ".github" / "workflows" / "publish.yml").read_text(encoding="utf-8")
    assert "ARTFLOW_BUILD_SHA=${{ github.sha }}" in text
    assert "provenance: mode=max" in text
    assert "type=sha,prefix=sha-,format=short" in text


def test_plus_publish_builds_all_targets_from_the_tagged_commit() -> None:
    data = _yaml(ROOT / ".github" / "workflows" / "publish.yml")
    job = data["jobs"].get("publish-plus")
    assert job is not None, "publish.yml must publish the Plus images"
    builds = [
        step
        for step in job["steps"]
        if step.get("uses", "").startswith("docker/build-push-action@")
    ]
    assert len(builds) == 3
    targets = {step["with"].get("target") for step in builds}
    assert targets == {"api", "worker", "web"}
    for step in builds:
        inputs = step["with"]
        assert inputs.get("file") == "deploy/plus/Dockerfile"
        assert "ARTFLOW_BUILD_SHA=${{ github.sha }}" in inputs.get("build-args", "")
        assert inputs.get("provenance") == "mode=max"


def test_plus_dockerfile_bakes_a_release_marker_in_every_target() -> None:
    dockerfile = (ROOT / "deploy" / "plus" / "Dockerfile").read_text(encoding="utf-8")
    assert "ARG ARTFLOW_BUILD_SHA" in dockerfile
    assert 'org.opencontainers.image.revision="${ARTFLOW_BUILD_SHA}"' in dockerfile
    assert "/app/ARTFLOW_RELEASE_SHA" in dockerfile
    assert "/usr/share/nginx/html/ARTFLOW_RELEASE_SHA" in dockerfile


def test_production_manifest_has_one_origin_and_pinned_images() -> None:
    compose = _yaml(ROOT / "deploy" / "compose.production.yml")
    services = compose["services"]
    publishers = [name for name, service in services.items() if service.get("ports")]
    assert publishers == ["proxy"], f"only the proxy may publish a port, got {publishers}"
    text = (ROOT / "deploy" / "compose.production.yml").read_text(encoding="utf-8")
    assert ":latest" not in text
    assert "${ARTFLOW_WEB_IMAGE:?" in text


def test_plus_profile_passes_the_release_sha_to_runtime_services() -> None:
    compose = _yaml(ROOT / "deploy" / "compose.production.yml")
    services = compose["services"]
    expected = "${ARTFLOW_RELEASE_SHA:?Set ARTFLOW_RELEASE_SHA}"
    assert services["plus-api"]["environment"]["ARTFLOW_RELEASE_SHA"] == expected
    assert services["plus-worker"]["environment"]["ARTFLOW_RELEASE_SHA"] == expected


def test_plus_profile_runs_the_outbox_relay_as_a_production_worker() -> None:
    compose = _yaml(ROOT / "deploy" / "compose.production.yml")
    services = compose["services"]
    assert services["plus-api"]["environment"].get("ARTFLOW_PLUS_INLINE_RELAY") in (None, "0")
    worker = services["plus-worker"]
    assert worker["profiles"] == ["plus"]
    assert worker["depends_on"]["plus-db"]["condition"] == "service_healthy"
    assert "ARTFLOW_PLUS_DATABASE_URL" in worker["environment"]
    assert worker["environment"].get("ARTFLOW_PLUS_INLINE_RELAY") in (None, "0")
    dockerfile = (ROOT / "deploy" / "plus" / "Dockerfile").read_text(encoding="utf-8")
    assert "FROM ${NODE_IMAGE} AS worker" in dockerfile
    assert "apps/worker/dist/main.cjs" in dockerfile


def test_plus_proxy_trust_and_body_limits_are_explicit() -> None:
    compose_text = (ROOT / "deploy" / "compose.production.yml").read_text(encoding="utf-8")
    assert "ARTFLOW_PLUS_TRUST_PROXY" in compose_text
    nginx = (ROOT / "deploy" / "plus" / "nginx.conf").read_text(encoding="utf-8")
    caddy = (ROOT / "deploy" / "caddy" / "sites" / "v2.caddy").read_text(encoding="utf-8")
    assert "client_max_body_size 128m" in nginx
    assert "max_size 128MB" in caddy


def test_every_django_worker_has_the_static_manifest() -> None:
    for manifest in ("compose.production.yml", "compose.event.yml"):
        compose = _yaml(ROOT / "deploy" / manifest)
        for name in ("media", "realtime"):
            volumes = compose["services"][name].get("volumes", [])
            assert "static_data:/app/staticfiles:ro" in volumes, f"{manifest}:{name}"


def test_static_collection_replaces_the_persistent_volume() -> None:
    entrypoint = (ROOT / "scripts" / "docker-entrypoint.sh").read_text(encoding="utf-8")
    assert "collectstatic --noinput --clear" in entrypoint


def test_every_manifest_variable_is_documented() -> None:
    pairs = [
        ("compose.production.yml", ".env.production.example"),
        ("compose.event.yml", ".env.event.example"),
        ("../docker-compose.yml", ".env.example"),
    ]
    missing: list[str] = []
    for manifest_name, example_name in pairs:
        manifest = (ROOT / "deploy" / manifest_name).resolve()
        example = ROOT / example_name
        referenced = set(
            re.findall(r"\$\{([A-Z][A-Z0-9_]*)(?::[-?])", manifest.read_text(encoding="utf-8"))
        )
        documented = {
            line.split("=", 1)[0].strip()
            for line in example.read_text(encoding="utf-8").splitlines()
            if line and not line.startswith("#") and "=" in line
        }
        for variable in sorted(referenced - documented - LAUNCHER_VARS):
            missing.append(f"{example_name} does not document {variable} used by {manifest.name}")
    assert not missing, "\n".join(missing)
