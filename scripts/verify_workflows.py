#!/usr/bin/env python3
"""Validate GitHub Actions workflow security and reliability contracts."""

from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

import yaml

SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
VERSION_COMMENT_PATTERN = re.compile(r"v\d+(?:\.\d+){0,3}(?:[-+][\w.-]+)?")
CREDENTIAL_KEY_PARTS = ("password", "secret", "token", "api_key", "apikey")
CREDENTIAL_EXPRESSION_PATTERN = re.compile(
    r"\$\{\{\s*(?:github\.token|secrets\.[A-Za-z_][A-Za-z0-9_]*)\s*}}"
)


def workflow_paths(target: Path) -> list[Path]:
    if target.is_file():
        return [target]
    if not target.is_dir():
        return []
    return sorted(
        path
        for path in target.iterdir()
        if path.is_file() and path.suffix.lower() in {".yaml", ".yml"}
    )


def as_mapping(value: object) -> Mapping[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    return {str(key): item for key, item in value.items()}


def action_reference_issues(workflow_path: Path, raw_content: str) -> list[str]:
    issues: list[str] = []
    for line_number, line in enumerate(raw_content.splitlines(), start=1):
        if not re.match(r"^\s*uses:\s*", line):
            continue
        match = re.match(
            r"^\s*uses:\s*(?P<reference>\S+)(?:\s+#\s*(?P<version>\S+))?\s*$",
            line,
        )
        if match is None:
            issues.append(f"{workflow_path.name}:{line_number}: invalid uses declaration")
            continue
        reference = match.group("reference")
        version_comment = match.group("version")
        _, separator, revision = reference.rpartition("@")
        if (
            not separator
            or SHA_PATTERN.fullmatch(revision) is None
            or version_comment is None
            or VERSION_COMMENT_PATTERN.fullmatch(version_comment) is None
        ):
            issues.append(
                f"{workflow_path.name}:{line_number}: {reference} must use a 40-character SHA "
                "with a version comment"
            )
    return issues


def literal_credential_issues(workflow_path: Path, value: object, location: str = "") -> list[str]:
    issues: list[str] = []
    mapping = as_mapping(value)
    if mapping is not None:
        for key, item in mapping.items():
            child_location = f"{location}.{key}" if location else key
            normalized_key = key.lower()
            if (
                any(part in normalized_key for part in CREDENTIAL_KEY_PARTS)
                and isinstance(item, str)
                and item
                and CREDENTIAL_EXPRESSION_PATTERN.fullmatch(item) is None
            ):
                issues.append(
                    f"{workflow_path.name}: {child_location} must not contain a literal credential"
                )
            issues.extend(literal_credential_issues(workflow_path, item, child_location))
    elif isinstance(value, Sequence) and not isinstance(value, str):
        for index, item in enumerate(value):
            issues.extend(literal_credential_issues(workflow_path, item, f"{location}[{index}]"))
    return issues


def integration_issues(workflow_path: Path, workflow: Mapping[str, Any]) -> list[str]:
    if workflow_path.name != "integration.yml":
        return []

    issues: list[str] = []
    jobs = as_mapping(workflow.get("jobs"))
    postgresql_job = as_mapping(jobs.get("postgresql")) if jobs is not None else None
    if postgresql_job is None:
        return [f"{workflow_path.name}: missing postgresql job"]

    job_environment = as_mapping(postgresql_job.get("env"))
    if job_environment is None or job_environment.get("POSTGRES_HOST") != "127.0.0.1":
        issues.append(f"{workflow_path.name}: POSTGRES_HOST must be 127.0.0.1")

    services = as_mapping(postgresql_job.get("services"))
    postgres_service = as_mapping(services.get("postgres")) if services is not None else None
    ports = postgres_service.get("ports") if postgres_service is not None else None
    if not isinstance(ports, list) or not ports:
        return [*issues, f"{workflow_path.name}: PostgreSQL must map a loopback port"]
    for port in ports:
        if port != "127.0.0.1:5432:5432":
            issues.append(f"{workflow_path.name}: PostgreSQL port {port!s} must bind to 127.0.0.1")
    return issues


def workflow_issues(workflow_path: Path) -> list[str]:
    raw_content = workflow_path.read_text(encoding="utf-8")
    try:
        document = yaml.safe_load(raw_content)
    except yaml.YAMLError as error:
        return [f"{workflow_path.name}: invalid YAML: {error}"]

    workflow = as_mapping(document)
    if workflow is None:
        return [f"{workflow_path.name}: workflow document must be a mapping"]

    issues: list[str] = []
    permissions = workflow.get("permissions")
    if permissions is None:
        issues.append(f"{workflow_path.name}: missing top-level permissions")
    elif permissions == "write-all":
        issues.append(f"{workflow_path.name}: must not use write-all permissions")

    concurrency = as_mapping(workflow.get("concurrency"))
    if concurrency is None or not concurrency.get("group"):
        issues.append(f"{workflow_path.name}: missing top-level concurrency group")
    elif concurrency.get("cancel-in-progress") is not True:
        issues.append(f"{workflow_path.name}: must enable cancel-in-progress")

    jobs = as_mapping(workflow.get("jobs"))
    if not jobs:
        issues.append(f"{workflow_path.name}: missing jobs")
    else:
        for job_name, job in jobs.items():
            job_mapping = as_mapping(job)
            timeout = job_mapping.get("timeout-minutes") if job_mapping is not None else None
            if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0:
                issues.append(f"{workflow_path.name}: job {job_name} must set timeout-minutes")

    issues.extend(action_reference_issues(workflow_path, raw_content))
    issues.extend(literal_credential_issues(workflow_path, workflow))
    issues.extend(integration_issues(workflow_path, workflow))
    return issues


def validation_issues(target: Path, required_names: Iterable[str] = ()) -> list[str]:
    paths = workflow_paths(target)
    if not paths:
        return [f"{target}: no workflow files found"]

    found_names = {path.name for path in paths}
    issues = [
        f"{target}: missing required workflow {name}"
        for name in required_names
        if name not in found_names
    ]
    for workflow_path in paths:
        issues.extend(workflow_issues(workflow_path))
    return issues


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path, help="A workflow file or workflows directory")
    parser.add_argument(
        "--require",
        action="append",
        default=[],
        metavar="WORKFLOW",
        help="Require a workflow file name when the target is a directory",
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    issues = validation_issues(arguments.target, arguments.require)
    if issues:
        print("\n".join(issues), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
