"""Gate for DEPL-03 and the "config list drift" lesson.

A file that exists but appears in no checker list is checked by nothing. This
gate derives the first-party application set from the filesystem and compares
it with every hand-written list: ruff, mypy, pyright, coverage, Tailwind,
TypeScript, Docker and Dependabot.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PYPROJECT = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
SKIP_DIRS = {
    ".venv",
    ".git",
    "node_modules",
    "media",
    "staticfiles",
    "docs",
    "deploy",
    "logs",
    "tests",
    "scripts",
    "config",
    "frontend",
    "static",
    "__pycache__",
}
APP_DIRS = sorted(
    path.name
    for path in ROOT.iterdir()
    if path.is_dir() and (path / "models.py").exists() and path.name not in SKIP_DIRS
)


def _pyright_include() -> set[str]:
    data = json.loads((ROOT / "pyrightconfig.json").read_text(encoding="utf-8"))
    return set(data["include"])


def _tailwind_app_dirs() -> set[str]:
    text = (ROOT / "tailwind.config.js").read_text(encoding="utf-8")
    match = re.search(r"const appDirs = \[(.*?)\];", text, re.DOTALL)
    assert match, "tailwind.config.js no longer declares appDirs"
    return set(re.findall(r'"([A-Za-z0-9_]+)"', match.group(1)))


def test_every_app_is_in_every_checker_list() -> None:
    ruff_src = set(PYPROJECT["tool"]["ruff"]["src"])
    mypy_files = set(PYPROJECT["tool"]["mypy"]["files"])
    coverage_source = set(PYPROJECT["tool"]["coverage"]["run"]["source"])
    pyright_include = _pyright_include()
    tailwind_dirs = _tailwind_app_dirs()

    missing: list[str] = []
    for app in APP_DIRS:
        for name, values in (
            ("ruff src", ruff_src),
            ("mypy files", mypy_files),
            ("coverage source", coverage_source),
            ("pyright include", pyright_include),
            ("tailwind appDirs", tailwind_dirs),
        ):
            if app not in values:
                missing.append(f"{app} missing from {name}")
    for extra in ("config", "scripts"):
        if extra not in ruff_src or extra not in mypy_files or extra not in pyright_include:
            missing.append(f"{extra} missing from a Python checker list")
    # Pyright deliberately excludes the test suites; ruff and mypy still cover them.
    for extra in ("tests",):
        if extra not in ruff_src or extra not in mypy_files:
            missing.append(f"{extra} missing from ruff/mypy")
    assert not missing, "\n".join(missing)


def test_typescript_build_covers_the_frontend() -> None:
    config = json.loads((ROOT / "tsconfig.client.json").read_text(encoding="utf-8"))
    assert config["include"] == ["frontend/**/*.ts"]
    assert config["compilerOptions"]["outDir"] == "static/dist"
    assert config["compilerOptions"]["strict"] is True


def test_docker_context_excludes_runtime_artifacts() -> None:
    lines = {
        line.strip()
        for line in (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    }
    for required in (".env", ".env.*", "media/", "staticfiles/", "backups/", "logs/"):
        assert required in lines, f".dockerignore lost {required!r}"


def test_dependabot_covers_every_manifest_family() -> None:
    import yaml

    data = yaml.safe_load((ROOT / ".github" / "dependabot.yml").read_text(encoding="utf-8"))
    ecosystems = {update["package-ecosystem"] for update in data["updates"]}
    assert {"uv", "pip", "npm", "github-actions", "docker"} <= ecosystems


def test_environment_templates_exist_for_every_profile() -> None:
    for name in (".env.example", ".env.production.example", ".env.event.example"):
        assert (ROOT / name).is_file(), f"missing {name}"
