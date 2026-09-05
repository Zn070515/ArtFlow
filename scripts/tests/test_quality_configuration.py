import tomllib
from pathlib import Path

PYPROJECT_PATH = Path(__file__).resolve().parents[2] / "pyproject.toml"
REPOSITORY_ROOT = PYPROJECT_PATH.parent
MYPY_FILES = [
    "accounts",
    "archive",
    "common",
    "config",
    "core",
    "exports",
    "farewell_show",
    "files",
    "incidents",
    "public_portal",
    "ruleset",
    "singer_contest",
    "staff_panel",
    "voting",
]
STRICT_MODULES = {
    "config",
    "config.*",
    "common",
    "common.*",
    "accounts.management",
    "accounts.management.*",
    "public_portal.management",
    "public_portal.management.*",
}
STRICT_CHECKS = {
    "disallow_any_generics": True,
    "disallow_subclassing_any": True,
    "disallow_incomplete_defs": True,
    "disallow_untyped_calls": True,
    "disallow_untyped_defs": True,
    "disallow_untyped_decorators": True,
    "warn_unused_ignores": True,
    "warn_return_any": True,
    "no_implicit_reexport": True,
    "strict_equality": True,
    "extra_checks": True,
}
GRADUAL_MODULES = {
    "common.views",
    "common.tests",
    # Legacy black-box characterization suites (mirrors the documented relaxation in
    # pyproject.toml): they introspect runtime behaviour, so strict untyped-call/def
    # enforcement churns them without adding safety.
    "common.test_characterization",
    "common.test_contest_domain_characterization",
    "common.test_authority_matrix",
    "config.tests",
}
GRADUAL_CHECKS = {
    "disallow_incomplete_defs": False,
    "disallow_untyped_calls": False,
    "disallow_untyped_defs": False,
}


def load_pyproject() -> dict:
    with PYPROJECT_PATH.open("rb") as pyproject_file:
        return tomllib.load(pyproject_file)


def test_quality_configuration_enforces_the_engineering_baseline():
    tools = load_pyproject()["tool"]
    coverage = tools["coverage"]
    mypy = tools["mypy"]

    assert coverage["run"]["branch"] is True
    assert coverage["report"]["fail_under"] >= 75
    assert mypy["files"] == MYPY_FILES
    assert mypy["check_untyped_defs"] is True
    assert mypy["disallow_untyped_defs"] is False
    assert "ignore_errors" not in mypy
    strict_override = next(
        override for override in mypy["overrides"] if set(override["module"]) == STRICT_MODULES
    )
    for setting, expected_value in STRICT_CHECKS.items():
        assert strict_override[setting] is expected_value

    gradual_override = next(
        override for override in mypy["overrides"] if set(override["module"]) == GRADUAL_MODULES
    )
    for setting, expected_value in GRADUAL_CHECKS.items():
        assert gradual_override[setting] is expected_value


def test_toolchain_baseline_is_pinned_and_documented():
    assert (REPOSITORY_ROOT / ".python-version").read_text(encoding="utf-8").strip() == "3.12"
    assert "uv==0.11.29" in (REPOSITORY_ROOT / "Dockerfile").read_text(encoding="utf-8")

    for documentation_path in (
        REPOSITORY_ROOT / "README.md",
        REPOSITORY_ROOT / "CLAUDE.md",
        REPOSITORY_ROOT / "docs" / "development-baseline.md",
    ):
        assert "uv 0.11.29" in documentation_path.read_text(encoding="utf-8")
