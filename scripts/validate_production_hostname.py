#!/usr/bin/env python3
"""Validate the hostname-only contract used by the production Caddy site."""

from __future__ import annotations

import re
import sys

_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
_HOSTNAME = re.compile(rf"{_LABEL}(?:\.{_LABEL})+\Z", re.ASCII)


def is_production_hostname(value: str) -> bool:
    return len(value) <= 253 and _HOSTNAME.fullmatch(value) is not None


def main() -> int:
    if len(sys.argv) != 2 or not is_production_hostname(sys.argv[1]):
        print(
            "CADDY_SITE_ADDRESS must be a hostname without a scheme, port, or path.",
            file=sys.stderr,
        )
        return 64
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
