"""Structural gates for the authority invariants (AUTH-01/02/06).

These do not exercise a business scenario. They check the shape of the code:
a guarded queryset must also be the base manager, and every authority scope
used in source must be registered in ``common.authority``. A new model or a
new scope that quietly skips either rule fails here instead of in review.
"""

from __future__ import annotations

import ast
from pathlib import Path

from common import authority
from django.apps import apps

ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIRS = [
    path
    for path in ROOT.iterdir()
    if path.is_dir()
    and (path / "models.py").exists()
    and path.name not in {"migrations", "static", "staticfiles", "media", ".venv", "node_modules"}
]
EXTRA_SOURCE_DIRS = [ROOT / "scripts", ROOT / "tests", ROOT / "config"]
SKIP_IMPORT_DIRS = {
    ".venv",
    ".git",
    "node_modules",
    "media",
    "staticfiles",
    "docs",
    "__pycache__",
}


def _python_files(base: Path):
    for path in base.rglob("*.py"):
        if any(part in SKIP_IMPORT_DIRS for part in path.parts):
            continue
        yield path


# v1 models that predate the base-manager rule. They are explicit debt, not a
# silent exception: removing a model (or fixing its Meta) also removes the entry.
# Any model NOT listed here must point its base manager at the guarded manager.
LEGACY_UNGUARDED_BASE_MANAGERS = {
    "accounts.InstallationState",
    "ruleset.RulesetPlanningDraft",
    "singer_contest.GroupStage",
    "singer_contest.Group",
    "singer_contest.GroupMembership",
}


def test_a_guarded_manager_is_also_the_base_manager() -> None:
    problems: list[str] = []
    seen_labels: set[str] = set()
    for model in apps.get_models():
        label = model._meta.label
        seen_labels.add(label)
        manager = getattr(model, "objects", None)
        queryset_class = getattr(manager, "_queryset_class", None)
        if queryset_class is None:
            continue
        if not issubclass(queryset_class, authority.AuthorityQuerySetMixin):
            continue
        if model._meta.base_manager_name != "objects" and label not in (
            LEGACY_UNGUARDED_BASE_MANAGERS
        ):
            problems.append(
                f"{label}: objects is guarded but "
                f"base_manager_name={model._meta.base_manager_name!r}"
            )
    stale = LEGACY_UNGUARDED_BASE_MANAGERS - seen_labels
    problems.extend(f"stale legacy exception: {label}" for label in sorted(stale))
    assert not problems, "\n".join(problems)


def test_every_authority_scope_used_in_source_is_registered() -> None:
    known_values = {
        value
        for name, value in vars(authority).items()
        if name.isupper() and isinstance(value, str) and "." in value
    }
    problems: list[str] = []
    for base in SOURCE_DIRS + EXTRA_SOURCE_DIRS:
        for path in _python_files(base):
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except (OSError, SyntaxError) as error:
                problems.append(f"{path}: cannot parse ({error})")
                continue
            module_constants: dict[str, str] = {}
            for statement in tree.body:
                value: ast.expr | None
                if isinstance(statement, ast.Assign):
                    targets = statement.targets
                    value = statement.value
                elif isinstance(statement, ast.AnnAssign):
                    targets = [statement.target]
                    value = statement.value
                else:
                    continue
                if value is None or not isinstance(value, ast.Constant):
                    continue
                if not isinstance(value.value, str):
                    continue
                for target in targets:
                    if isinstance(target, ast.Name):
                        module_constants[target.id] = value.value
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                if not isinstance(node.func, ast.Name):
                    continue
                if node.func.id not in {"authority_write", "authority_authorized"}:
                    continue
                if not node.args:
                    continue
                argument = node.args[0]
                if isinstance(argument, ast.Name):
                    # A function parameter (e.g. a shared `_require_authority(scope)`
                    # helper) is dynamic by design; module constants and the
                    # registered constants are resolvable and must be valid.
                    constant = module_constants.get(argument.id) or getattr(
                        authority, argument.id, None
                    )
                    if constant is None:
                        continue
                    if constant not in known_values:
                        problems.append(
                            f"{path}:{node.lineno}: {argument.id}={constant!r} "
                            "is not a registered scope"
                        )
                elif isinstance(argument, ast.Constant) and isinstance(argument.value, str):
                    if argument.value not in known_values:
                        problems.append(
                            f"{path}:{node.lineno}: {argument.value!r} is not a registered scope"
                        )
    assert not problems, "\n".join(sorted(set(problems)))
