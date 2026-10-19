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


def test_production_manifest_has_one_origin_and_pinned_images() -> None:
    compose = _yaml(ROOT / "deploy" / "compose.production.yml")
    services = compose["services"]
    publishers = [name for name, service in services.items() if service.get("ports")]
    assert publishers == ["proxy"], f"only the proxy may publish a port, got {publishers}"
    text = (ROOT / "deploy" / "compose.production.yml").read_text(encoding="utf-8")
    assert ":latest" not in text
    assert "${ARTFLOW_WEB_IMAGE:?" in text


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
