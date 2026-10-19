"""Structural gate for AUTH-04: private media has one controlled gateway.

The gate fails if any URL module mounts a static/media handler, or if the
``controlled_media`` route disappears. It intentionally does not inspect the
authorization logic itself — the media-gateway tests do that with requests.
"""

from __future__ import annotations

from pathlib import Path

from django.conf import settings

ROOT = Path(__file__).resolve().parents[2]
URL_MODULES = list(ROOT.rglob("urls.py"))
SKIP_PARTS = {".venv", "node_modules", "media", "staticfiles", "docs", "__pycache__"}


def test_no_url_module_mounts_static_media() -> None:
    offenders: list[str] = []
    for path in URL_MODULES:
        if any(part in SKIP_PARTS for part in path.parts):
            continue
        text = path.read_text(encoding="utf-8")
        for marker in ("static(settings.MEDIA_URL", "serve(", "django.views.static"):
            if marker in text:
                offenders.append(f"{path.relative_to(ROOT)}: {marker}")
    assert not offenders, "private media must never be mounted statically:\n" + "\n".join(offenders)


def test_controlled_media_is_the_only_media_route() -> None:
    config = (ROOT / "config" / "urls.py").read_text(encoding="utf-8")
    assert config.count('path("media/<path:path>", controlled_media') == 1
    assert 'name="controlled_media"' in config
    assert settings.MEDIA_URL == "/media/"
