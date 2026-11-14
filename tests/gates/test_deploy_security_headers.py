"""Gate for the production edge security headers.

The reverse proxy is the only place that can set transport-level headers for
both the static shell and the API. A missing header here is invisible to the
application tests, so the deploy profile itself is part of the gate.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "deploy" / "caddy" / "sites" / "v2.caddy"

REQUIRED = (
    "X-Content-Type-Options nosniff",
    "X-Frame-Options DENY",
    "Referrer-Policy no-referrer",
    "Strict-Transport-Security",
    'Content-Security-Policy "',
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    # The design tokens and some glyph assets are inlined as data: fonts.
    "font-src 'self' data:",
)


def test_plus_site_sets_security_headers() -> None:
    text = SITE.read_text(encoding="utf-8")
    missing = [needle for needle in REQUIRED if needle not in text]
    assert not missing, f"deploy/caddy/sites/v2.caddy is missing: {missing}"


def test_hsts_stays_on_the_https_site_only() -> None:
    text = SITE.read_text(encoding="utf-8")
    http_block = text.split("https://", 1)[0]
    assert "Strict-Transport-Security" not in http_block, (
        "HSTS must not be sent over the plain-HTTP health listener."
    )
