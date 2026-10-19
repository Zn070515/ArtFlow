"""GATE-PLUS-BOUNDARY-01: capabilities never share persistence or internals.

A capability is a module boundary (ADR-0009/0010). This gate fails when a
capability imports another capability's file, when the domain package imports
persistence, when the engine assembly modules hard-code a concrete capability,
or when the application layer reaches into a capability implementation instead
of using the registry. The synthetic test proves the gate can actually fail;
the real-tree test keeps the current boundary clean.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

IMPORT_PATTERN = re.compile(r"""(?:from\s+|import\s*)["']([^"']+)["']""")
ENGINE_IMPORTS = {
    "../model.js",
    "../compiler.js",
    "../errors.js",
    "../registry.js",
}
PERSISTENCE_MODULES = ("@artflow-plus/db", "kysely", "pg")
ENGINE_ASSEMBLY_FILES = ("registry.ts", "packs.ts")
NAMED_IMPORT_PATTERN = re.compile(
    r"""import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']@artflow-plus/db["']""",
    re.DOTALL,
)
# Application processes may only use lifecycle helpers; every fact goes through
# the runtime command service (AUTH-01 / the M3 review's single write path).
FORBIDDEN_APP_MUTATORS = {
    "insertActivity",
    "updateActivity",
    "insertSession",
    "updateSession",
    "appendEvent",
    "claimCommand",
    "completeCommand",
    "insertAudit",
    "insertDraft",
    "updateDraft",
    "insertCompiled",
    "insertRelease",
    "upsertExecutionProjection",
    "blockExecutionProjection",
    "retryEvent",
}


def _imports(path: Path) -> list[str]:
    return IMPORT_PATTERN.findall(path.read_text(encoding="utf-8"))


def _relative(path: Path, domain_src: Path) -> str:
    return path.relative_to(domain_src).as_posix()


def capability_violations(domain_src: Path) -> list[str]:
    """Capabilities may import the engine and themselves, nothing else."""
    violations: list[str] = []
    capability_dir = domain_src / "capabilities"
    if not capability_dir.exists():
        return [f"{_relative(capability_dir, domain_src)} is missing"]
    for path in sorted(capability_dir.glob("*.ts")):
        stem = path.stem
        for specifier in _imports(path):
            if specifier.startswith("node:"):
                continue
            if specifier in ENGINE_IMPORTS:
                continue
            if specifier in {f"./{stem}.js", f"./{stem}/"} or specifier.startswith(
                f"./{stem}/"
            ):
                continue
            violations.append(
                f"{_relative(path, domain_src)}: capability {stem} imports {specifier}"
            )
    return violations


def persistence_violations(domain_src: Path) -> list[str]:
    """The domain is pure: no capability owns or reads a database handle."""
    violations: list[str] = []
    for path in sorted(domain_src.rglob("*.ts")):
        for specifier in _imports(path):
            module = specifier.split("/")[0]
            if specifier in PERSISTENCE_MODULES or module in PERSISTENCE_MODULES:
                violations.append(
                    f"{_relative(path, domain_src)}: domain imports persistence {specifier}"
                )
    return violations


def engine_assembly_violations(domain_src: Path) -> list[str]:
    """The engine must not name a concrete capability; defaults assemble it."""
    violations: list[str] = []
    for name in ENGINE_ASSEMBLY_FILES:
        path = domain_src / name
        if not path.exists():
            violations.append(f"{name}: engine assembly module is missing")
            continue
        for specifier in _imports(path):
            if "capabilities" in specifier:
                violations.append(
                    f"{name}: engine assembly imports concrete capability {specifier}"
                )
    return violations


def app_layer_violations(plus_root: Path) -> list[str]:
    """Runtime/API/worker use the registry, never a concrete capability file."""
    violations: list[str] = []
    bases = (
        plus_root / "packages" / "runtime" / "src",
        plus_root / "apps" / "api" / "src",
        plus_root / "apps" / "worker" / "src",
    )
    for base in bases:
        if not base.exists():
            violations.append(f"{base.relative_to(plus_root).as_posix()}: missing")
            continue
        for path in sorted(base.rglob("*.ts")):
            for specifier in _imports(path):
                if "capabilities/" in specifier or specifier.endswith(
                    "/capabilities.js"
                ):
                    violations.append(
                        f"{path.relative_to(plus_root).as_posix()}: "
                        f"application imports concrete capability {specifier}"
                    )
    return violations


def app_persistence_violations(plus_root: Path) -> list[str]:
    """API/worker must not import DB mutators; writes go through the runtime."""
    violations: list[str] = []
    bases = (
        plus_root / "apps" / "api" / "src",
        plus_root / "apps" / "worker" / "src",
    )
    for base in bases:
        for path in sorted(base.rglob("*.ts")):
            text = path.read_text(encoding="utf-8")
            for match in NAMED_IMPORT_PATTERN.finditer(text):
                names = {
                    item.strip().removeprefix("type ").split(" as ")[0].strip()
                    for item in match.group(1).split(",")
                    if item.strip()
                }
                forbidden = sorted(names & FORBIDDEN_APP_MUTATORS)
                if forbidden:
                    violations.append(
                        f"{path.relative_to(plus_root).as_posix()}: "
                        f"application imports DB mutator(s) {', '.join(forbidden)}"
                    )
    return violations


def test_capabilities_do_not_import_each_other() -> None:
    violations = capability_violations(
        ROOT / "plus" / "packages" / "domain" / "src"
    )
    assert not violations, "capability modules must stay independent:\n" + "\n".join(
        violations
    )


def test_domain_does_not_import_persistence() -> None:
    violations = persistence_violations(
        ROOT / "plus" / "packages" / "domain" / "src"
    )
    assert not violations, "the domain package must not import persistence:\n" + "\n".join(
        violations
    )


def test_engine_assembly_does_not_hard_code_capabilities() -> None:
    violations = engine_assembly_violations(
        ROOT / "plus" / "packages" / "domain" / "src"
    )
    assert not violations, "the engine must not hard-code capabilities:\n" + "\n".join(
        violations
    )


def test_application_does_not_import_db_mutators() -> None:
    violations = app_persistence_violations(ROOT / "plus")
    assert not violations, "application writes must go through the runtime:\n" + "\n".join(
        violations
    )


def test_application_layers_use_the_registry() -> None:
    violations = app_layer_violations(ROOT / "plus")
    assert not violations, "the application layer must not name capabilities:\n" + "\n".join(
        violations
    )


def test_gate_detects_synthetic_violations(tmp_path: Path) -> None:
    domain_src = tmp_path / "src"
    capabilities = domain_src / "capabilities"
    capabilities.mkdir(parents=True)
    (capabilities / "alpha.ts").write_text(
        'import { thing } from "./beta.js";\n', encoding="utf-8"
    )
    (capabilities / "beta.ts").write_text('import pg from "pg";\n', encoding="utf-8")
    (domain_src / "registry.ts").write_text(
        'import { alpha } from "./capabilities/alpha.js";\n', encoding="utf-8"
    )
    (domain_src / "packs.ts").write_text("export {};\n", encoding="utf-8")

    capability_failures = capability_violations(domain_src)
    assert any("alpha.ts" in item and "./beta.js" in item for item in capability_failures)
    assert any("beta.ts" in item and "pg" in item for item in capability_failures)

    persistence_failures = persistence_violations(domain_src)
    assert any("beta.ts" in item and "pg" in item for item in persistence_failures)

    assembly_failures = engine_assembly_violations(domain_src)
    assert any(
        "registry.ts" in item and "capabilities/alpha.js" in item
        for item in assembly_failures
    )

    plus_root = tmp_path / "plus"
    api_src = plus_root / "apps" / "api" / "src"
    runtime_src = plus_root / "packages" / "runtime" / "src"
    worker_src = plus_root / "apps" / "worker" / "src"
    for path in (api_src, runtime_src, worker_src):
        path.mkdir(parents=True, exist_ok=True)
    (api_src / "app.ts").write_text(
        'import { alpha } from "../../../packages/domain/src/capabilities/alpha.js";\n',
        encoding="utf-8",
    )
    (runtime_src / "service.ts").write_text("export {};\n", encoding="utf-8")
    (worker_src / "main.ts").write_text("export {};\n", encoding="utf-8")
    app_failures = app_layer_violations(plus_root)
    assert any(
        "apps/api/src/app.ts" in item and "capabilities/alpha.js" in item
        for item in app_failures
    )

    (api_src / "writer.ts").write_text(
        'import { insertActivity, getActivity } from "@artflow-plus/db";\n',
        encoding="utf-8",
    )
    persistence_failures = app_persistence_violations(plus_root)
    assert any(
        "apps/api/src/writer.ts" in item and "insertActivity" in item
        for item in persistence_failures
    )
