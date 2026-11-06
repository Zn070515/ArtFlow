"""Gate for AUTH-04/DEPL-06: secrets and runtime data never enter Git.

This is intentionally a tracked-file check, not a .gitignore check: a file is
only truly absent when ``git ls-files`` does not contain it.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ALLOWED_ENV_EXAMPLES = {
    ".env.example",
    ".env.production.example",
    ".env.event.example",
}


def _tracked_files() -> list[str]:
    output = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-z"],
        check=True,
        capture_output=True,
    ).stdout
    return [item for item in output.decode("utf-8").split("\0") if item]


def test_no_secrets_or_runtime_data_are_tracked() -> None:
    offenders: list[str] = []
    for path in _tracked_files():
        name = Path(path).name
        if name.startswith(".env") and path not in ALLOWED_ENV_EXAMPLES:
            offenders.append(path)
        elif name.endswith((".sqlite3", ".db", ".pem", ".key")):
            offenders.append(path)
        elif path.startswith(("media/", "staticfiles/", "backups/", "logs/", "test-results/")):
            if not path.endswith(".gitkeep"):
                offenders.append(path)
        elif name.endswith((".zip", ".log")):
            offenders.append(path)
    assert not offenders, "tracked runtime/secret artifacts:\n" + "\n".join(offenders)


def test_gitignore_still_covers_the_runtime_roots() -> None:
    patterns = {
        line.strip()
        for line in (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    }
    for required in (".env", "*.sqlite3", "media/", "staticfiles/", "backups/", "logs/**"):
        assert required in patterns, f".gitignore lost {required!r}"
