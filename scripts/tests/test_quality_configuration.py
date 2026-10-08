import json
import tomllib
from pathlib import Path

PYPROJECT_PATH = Path(__file__).resolve().parents[2] / "pyproject.toml"
REPOSITORY_ROOT = PYPROJECT_PATH.parent
PYRIGHTCONFIG_PATH = REPOSITORY_ROOT / "pyrightconfig.json"
MYPY_FILES = [
    "accounts",
    "archive",
    "common",
    "config",
    "core",
    "entry_access",
    "exports",
    "farewell_show",
    "files",
    "incidents",
    "public_portal",
    "questionnaire",
    "ruleset",
    "realtime",
    "singer_contest",
    "staff_panel",
    "scripts",
    "tests",
    "tickets",
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
    "common.private_test_fixture",
    "common.private_test_loader",
    "common.private_test_questionnaire",
    "common.management.commands.prepare_layout_e2e",
    "common.test_private_test_fixture",
    "common.test_private_test_loader",
    "common.test_private_test_questionnaire",
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
    project = load_pyproject()["project"]
    tools = load_pyproject()["tool"]
    coverage = tools["coverage"]
    mypy = tools["mypy"]
    dev_dependencies = project["optional-dependencies"]["dev"]
    pytest_options = tools["pytest"]["ini_options"]

    assert any(dependency.startswith("pytest-xdist") for dependency in dev_dependencies)
    assert any(marker.startswith("postgresql:") for marker in pytest_options["markers"])
    assert coverage["run"]["branch"] is True
    assert coverage["report"]["fail_under"] >= 75
    # Compare the coverage list against the tree, not against another hand-written
    # list: `realtime` and `tickets` were each absent here for a while, so the
    # fail-under threshold was silently not measured over the websocket authorization
    # boundary and the whole ticket app. An app directory is one that ships an
    # `apps.py`; `config` is the project package and is measured explicitly.
    measured_directories = sorted(
        path.name
        for path in REPOSITORY_ROOT.iterdir()
        if path.is_dir() and ((path / "apps.py").exists() or path.name == "config")
    )
    assert coverage["run"]["source"] == measured_directories
    assert set(measured_directories) <= set(mypy["files"])
    assert mypy["files"] == MYPY_FILES
    # `scripts` is a directory of standalone tools rather than a package, so mypy needs
    # this to resolve `scripts/verify_private_test_package.py` as one module instead of
    # two and check the directory at all.
    assert mypy["explicit_package_bases"] is True
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


def test_the_three_checkers_cover_the_same_tree():
    """Three hand-written lists describe one tree, and they have to agree.

    `scripts/` appeared in none of them, so `scripts/verify_workflows.py` and the
    operational validators `deploy.sh` calls were type-checked by nothing — the same
    silent-omission shape as the coverage `source` list. Comparing the lists to each
    other is what keeps a fourth one from going missing.
    """
    tools = load_pyproject()["tool"]
    mypy_files = set(tools["mypy"]["files"])
    ruff_src = set(tools["ruff"]["src"])
    pyright = json.loads(PYRIGHTCONFIG_PATH.read_text(encoding="utf-8"))
    pyright_include = set(pyright["include"])

    # ruff and mypy sweep every Python tree; pyright is the production baseline and drops
    # `tests` on purpose — its `exclude` already drops `**/test_*.py` app-wide, so the
    # only tree it deliberately leaves to the other two is the one that is all tests.
    assert mypy_files == ruff_src
    assert "scripts" in pyright_include
    assert "tests" in pyright["exclude"]
    assert pyright_include == (mypy_files - {"tests"}) | {
        # File-level entries whose directories are already listed; kept because a
        # narrowed baseline is easier to loosen than to tighten.
        "common/authority.py",
        "common/private_test_questionnaire.py",
        "files/services.py",
        "singer_contest/services.py",
    }


def test_toolchain_baseline_is_pinned_and_documented():
    assert (REPOSITORY_ROOT / ".python-version").read_text(encoding="utf-8").strip() == "3.12"
    assert "uv==0.11.29" in (REPOSITORY_ROOT / "Dockerfile").read_text(encoding="utf-8")

    for documentation_path in (
        REPOSITORY_ROOT / "README.md",
        REPOSITORY_ROOT / "CLAUDE.md",
        REPOSITORY_ROOT / "docs" / "development-baseline.md",
    ):
        assert "uv 0.11.29" in documentation_path.read_text(encoding="utf-8")
