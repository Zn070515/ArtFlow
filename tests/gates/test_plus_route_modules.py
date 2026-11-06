"""Gate for the HTTP route-module boundary.

`app.ts` is the composition root: construction, hooks, CSRF, error mapping and
the realtime server. Route registration lives in `src/routes/<surface>.ts`, each
exporting a `registerXRoutes(ctx: ApiContext)` function. This gate fails when:

- a route is registered directly in `app.ts`;
- a route module is not called from `app.ts`;
- a module registers no routes;
- a literal method + URL pair is duplicated across modules;
- `app.ts` or a single module grows back past its reviewed size.
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "plus" / "apps" / "api" / "src" / "app.ts"
ROUTES = ROOT / "plus" / "apps" / "api" / "src" / "routes"

ROUTE_CALL = re.compile(r"\bapp\.(get|post|patch|put|delete)\(")
REGISTER = re.compile(r"export function register(\w+)Routes\(ctx: ApiContext\): void")
URL_LITERAL = re.compile(r'"(/(?:api|healthz|readyz|openapi)[^"]*)"')

# One surface per file; the number is a review aid, not a target.
MAX_APP_LINES = 800
MAX_MODULE_LINES = 900


def _modules() -> dict[str, str]:
    return {
        path.stem: path.read_text(encoding="utf-8")
        for path in sorted(ROUTES.glob("*.ts"))
    }


def test_app_is_the_composition_root() -> None:
    text = APP.read_text(encoding="utf-8")
    assert not ROUTE_CALL.search(text), (
        "app.ts must not register routes directly; add a registerXRoutes module "
        "under plus/apps/api/src/routes/."
    )
    assert len(text.splitlines()) <= MAX_APP_LINES, (
        f"app.ts grew past {MAX_APP_LINES} lines; keep it to composition and hooks."
    )


def test_every_route_module_is_registered() -> None:
    app = APP.read_text(encoding="utf-8")
    modules = _modules()
    assert len(modules) >= 8, f"expected the surface split, found {sorted(modules)}"
    for name, text in modules.items():
        match = REGISTER.search(text)
        assert match, f"routes/{name}.ts does not export registerXRoutes(ctx)."
        function = match.group(0).split("(")[0].split()[-1]
        assert f"{function}(routeContext)" in app or f"{function}(" in app, (
            f"app.ts does not call {function}."
        )
        assert ROUTE_CALL.search(text), f"routes/{name}.ts registers no routes."
        assert len(text.splitlines()) <= MAX_MODULE_LINES, (
            f"routes/{name}.ts grew past {MAX_MODULE_LINES} lines; split the surface."
        )


def test_route_pairs_are_unique() -> None:
    seen: Counter[tuple[str, str]] = Counter()
    for name, text in _modules().items():
        # Pair each route call with its first literal URL. Template URLs (the
        # task action loop) are covered by the runtime API tests.
        for match in ROUTE_CALL.finditer(text):
            tail = text[match.end():]
            url = URL_LITERAL.search(tail)
            if url is None or "${" in url.group(1):
                continue
            seen[(match.group(1).upper(), url.group(1))] += 1
    duplicates = {pair: count for pair, count in seen.items() if count > 1}
    assert not duplicates, f"duplicate method+URL registrations: {duplicates}"
    assert sum(seen.values()) >= 100, (
        f"expected the full API surface, found {sum(seen.values())} literal routes"
    )
