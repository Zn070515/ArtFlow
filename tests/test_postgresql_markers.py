"""Contract tests for explicit PostgreSQL-only test selection."""

import ast
from collections.abc import Iterable
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_FILES = {
    Path(__file__).resolve(),
    PROJECT_ROOT / "tests" / "helpers.py",
}


def _test_python_files() -> Iterable[Path]:
    patterns = ("tests.py", "test_*.py", "*_tests.py")
    for path in PROJECT_ROOT.rglob("*.py"):
        if path in EXCLUDED_FILES or any(
            part in {".venv", "migrations", "__pycache__"} for part in path.parts
        ):
            continue
        if path.name in patterns or path.name.startswith("test_"):
            yield path


def _parent_map(tree: ast.AST) -> dict[ast.AST, ast.AST]:
    parents: dict[ast.AST, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[child] = parent
    return parents


def _decorator_name(decorator: ast.expr) -> str | None:
    if isinstance(decorator, ast.Call):
        decorator = decorator.func
    if isinstance(decorator, ast.Name):
        return decorator.id
    if isinstance(decorator, ast.Attribute):
        return decorator.attr
    return None


def _uses_postgresql_semantics(node: ast.AST) -> bool:
    source = ast.unparse(node)
    return (
        "connection.vendor" in source and "postgresql" in source
    ) or "connection.features.has_select_for_update" in source


def _has_postgresql_marker(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> bool:
    current: ast.AST | None = node
    while current is not None:
        if isinstance(current, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if any(
                _decorator_name(decorator) == "postgresql_only"
                for decorator in current.decorator_list
            ):
                return True
        current = parents.get(current)
    return False


def test_postgresql_semantics_are_explicitly_marked():
    violations: list[str] = []
    for path in _test_python_files():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        parents = _parent_map(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and _uses_postgresql_semantics(node):
                if not _has_postgresql_marker(node, parents):
                    violations.append(f"{path.relative_to(PROJECT_ROOT)}:{node.lineno}")

    assert not violations, "PostgreSQL-specific tests must use @postgresql_only: " + ", ".join(
        violations
    )
