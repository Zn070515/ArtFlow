from __future__ import annotations

import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PLUS_ROOT = PROJECT_ROOT / "plus"
REALTIME_ROOT = PLUS_ROOT / "packages" / "realtime"
CLIENT_ROOT = REALTIME_ROOT / "src" / "client"
CONSTRUCTOR_ROOTS = (CLIENT_ROOT, REALTIME_ROOT / "test")

TRANSPORT_IMPORT = re.compile(r'from\s+"(ws|@fastify/websocket)"')
WEBSOCKET_CONSTRUCTOR = re.compile(r"\bnew\s+WebSocket\s*\(")
FORBIDDEN_CORE_IMPORT = re.compile(
    r'from\s+"@artflow-plus/(domain|db|runtime)(?:/[^"]*)?"'
)


def _ts_files(root: Path) -> list[Path]:
    return [
        path
        for path in root.rglob("*.ts")
        if "node_modules" not in path.parts and "dist" not in path.parts
    ]


def _transport_violations(root: Path) -> list[str]:
    violations: list[str] = []
    for path in _ts_files(root):
        if REALTIME_ROOT in path.parents:
            continue
        text = path.read_text(encoding="utf-8")
        if TRANSPORT_IMPORT.search(text):
            violations.append(path.relative_to(root).as_posix())
    return violations


def _constructor_violations(root: Path) -> list[str]:
    violations: list[str] = []
    for path in _ts_files(root):
        if any(allowed in path.parents for allowed in CONSTRUCTOR_ROOTS):
            continue
        text = path.read_text(encoding="utf-8")
        if WEBSOCKET_CONSTRUCTOR.search(text):
            violations.append(path.relative_to(root).as_posix())
    return violations


def _core_import_violations(root: Path) -> list[str]:
    violations: list[str] = []
    for path in _ts_files(root / "packages" / "realtime"):
        text = path.read_text(encoding="utf-8")
        if FORBIDDEN_CORE_IMPORT.search(text):
            violations.append(path.relative_to(root).as_posix())
    return violations


def test_transport_imports_are_confined_to_the_realtime_package() -> None:
    assert _transport_violations(PLUS_ROOT) == []


def test_websocket_constructor_is_confined_to_the_client_module() -> None:
    assert _constructor_violations(PLUS_ROOT) == []


def test_realtime_core_does_not_import_business_packages() -> None:
    assert _core_import_violations(PLUS_ROOT) == []


def test_gate_detects_synthetic_violations(tmp_path: Path) -> None:
    package = tmp_path / "packages" / "realtime"
    package.mkdir(parents=True)
    outside = tmp_path / "apps" / "api"
    outside.mkdir(parents=True)
    (outside / "bad.ts").write_text(
        'import ws from "ws";\nconst socket = new WebSocket("ws://x");\n',
        encoding="utf-8",
    )
    assert _transport_violations(tmp_path) == ["apps/api/bad.ts"]
    assert _constructor_violations(tmp_path) == ["apps/api/bad.ts"]

    (package / "bad-core.ts").write_text(
        'import { DomainError } from "@artflow-plus/domain";\n',
        encoding="utf-8",
    )
    assert _core_import_violations(tmp_path) == ["packages/realtime/bad-core.ts"]
