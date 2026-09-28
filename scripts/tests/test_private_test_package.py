from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import pytest

from scripts.verify_private_test_package import PackageValidationError, verify_manifest


def _write_manifest(root: Path, files: dict[str, bytes]) -> None:
    entries = []
    for relative_path, content in files.items():
        target = root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        entries.append(
            {
                "path": relative_path,
                "bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        )
    (root / "ADDENDUM_MANIFEST.json").write_text(
        json.dumps({"file_count": len(entries), "files": entries}), encoding="utf-8"
    )


def test_verify_manifest_accepts_exact_file_set(tmp_path: Path):
    files = {"README.md": b"SYNTHETIC_TEST_ONLY\n", "media/sample.txt": b"fixture"}
    _write_manifest(tmp_path, files)

    result = verify_manifest(tmp_path / "ADDENDUM_MANIFEST.json")

    assert result.file_count == 2
    assert result.checked_paths == tuple(sorted(files))


def test_verify_manifest_rejects_path_escape(tmp_path: Path):
    manifest = {
        "file_count": 1,
        "files": [{"path": "../secret.txt", "bytes": 0, "sha256": ""}],
    }
    manifest_path = tmp_path / "ADDENDUM_MANIFEST.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(PackageValidationError, match="outside package root"):
        verify_manifest(manifest_path)


def test_verify_manifest_rejects_unlisted_file(tmp_path: Path):
    _write_manifest(tmp_path, {"README.md": b"fixture"})
    (tmp_path / "unexpected.bin").write_bytes(b"not in manifest")

    with pytest.raises(PackageValidationError, match="not listed"):
        verify_manifest(tmp_path / "ADDENDUM_MANIFEST.json")


def test_sanitized_vote_csv_rejects_raw_identity_columns(tmp_path: Path):
    vote_path = tmp_path / "p1r2_ballots_sanitized.csv"
    with vote_path.open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle).writerow(["sequence", "voter_name", "selected_option"])

    from scripts.verify_private_test_package import validate_sanitized_vote_csv

    with pytest.raises(PackageValidationError, match="identity field"):
        validate_sanitized_vote_csv(vote_path)
