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
SETUP_UV_VERSION = "0.11.29"
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

    compose_smoke_job = as_mapping(jobs.get("compose-smoke")) if jobs is not None else None
    if compose_smoke_job is None:
        issues.append(f"{workflow_path.name}: missing compose-smoke job")
        return issues

    compose_steps = steps_for_job(compose_smoke_job)
    compose_commands = "\n".join(
        str(step.get("run", "")) for step in compose_steps if isinstance(step.get("run"), str)
    )
    if "docker compose up --build --wait" not in compose_commands:
        issues.append(
            f"{workflow_path.name}: Compose smoke must run docker compose up --build --wait"
        )
    if (
        "docker compose ps --status running" not in compose_commands
        or "State.Health.Status" not in compose_commands
    ):
        issues.append(
            f"{workflow_path.name}: Compose smoke must verify the running container health"
        )
    if (
        "docker compose exec -T web python manage.py migrate --noinput" not in compose_commands
        or "docker compose exec -T web python manage.py doctor" not in compose_commands
        or "docker compose exec -T web python" not in compose_commands
        or "/healthz/" not in compose_commands
        or compose_commands.count("docker compose exec -T web python manage.py seed_demo_data") < 2
    ):
        issues.append(
            f"{workflow_path.name}: Compose smoke must run migrate, doctor, health, and "
            "seed twice in web"
        )

    cleanup_steps = [
        step
        for step in compose_steps
        if "always()" in str(step.get("if", ""))
        and "docker compose down" in str(step.get("run", ""))
    ]
    if not cleanup_steps or any(
        "--volumes" in str(step.get("run", "")) or " -v" in str(step.get("run", ""))
        for step in cleanup_steps
    ):
        issues.append(
            f"{workflow_path.name}: Compose smoke must clean up with docker compose down "
            "in an always step"
        )
    return issues


def steps_for_job(job: Mapping[str, Any] | None) -> list[Mapping[str, Any]]:
    if job is None:
        return []
    steps = job.get("steps")
    if not isinstance(steps, Sequence) or isinstance(steps, str):
        return []
    return [step for value in steps if (step := as_mapping(value)) is not None]


def uses_action(step: Mapping[str, Any], action: str) -> bool:
    uses = step.get("uses")
    return isinstance(uses, str) and uses.startswith(f"{action}@")


def setup_uv_issues(workflow_path: Path, workflow: Mapping[str, Any]) -> list[str]:
    jobs = as_mapping(workflow.get("jobs"))
    if jobs is None:
        return []

    issues: list[str] = []
    for job_name, job in jobs.items():
        for step in steps_for_job(as_mapping(job)):
            if not uses_action(step, "astral-sh/setup-uv"):
                continue
            setup_inputs = as_mapping(step.get("with"))
            if setup_inputs is None or setup_inputs.get("version") != SETUP_UV_VERSION:
                issues.append(
                    f"{workflow_path.name}: job {job_name} setup-uv must set version to "
                    f"{SETUP_UV_VERSION}"
                )
    return issues


def security_issues(workflow_path: Path, workflow: Mapping[str, Any]) -> list[str]:
    if workflow_path.name != "security.yml":
        return []

    issues: list[str] = []
    jobs = as_mapping(workflow.get("jobs"))
    codeql_job = as_mapping(jobs.get("codeql")) if jobs is not None else None
    if codeql_job is None:
        issues.append(f"{workflow_path.name}: missing codeql job")
    else:
        permissions = as_mapping(codeql_job.get("permissions"))
        if permissions is None or permissions.get("actions") != "read":
            issues.append(f"{workflow_path.name}: CodeQL must grant actions: read")
        if permissions is None or permissions.get("security-events") != "write":
            issues.append(f"{workflow_path.name}: CodeQL must grant security-events: write")
        codeql_steps = steps_for_job(codeql_job)
        analyze_step = next(
            (step for step in codeql_steps if uses_action(step, "github/codeql-action/analyze")),
            None,
        )
        if analyze_step is None:
            issues.append(f"{workflow_path.name}: missing CodeQL analyze step")
        else:
            analyze_inputs = as_mapping(analyze_step.get("with"))
            if analyze_inputs is not None and analyze_inputs.get("upload") != "always":
                issues.append(f"{workflow_path.name}: CodeQL must upload SARIF results")
            evaluator_commands = "\n".join(
                str(step.get("run", ""))
                for step in codeql_steps
                if isinstance(step.get("run"), str)
            )
            codeql_step_configuration = "\n".join(str(step) for step in codeql_steps)
            has_sarif_evaluator = (
                analyze_step.get("continue-on-error") is True
                and analyze_inputs is not None
                and analyze_inputs.get("output") == "codeql-results"
                and "CODEQL_ANALYSIS_OUTCOME" in codeql_step_configuration
                and "codeql-results" in codeql_step_configuration
                and "sarif" in evaluator_commands.lower()
                and "raise SystemExit(1)" in evaluator_commands
            )
            if not has_sarif_evaluator:
                issues.append(
                    f"{workflow_path.name}: CodeQL must evaluate SARIF findings when "
                    "upload cannot complete"
                )

    gitleaks_job = as_mapping(jobs.get("gitleaks")) if jobs is not None else None
    if gitleaks_job is None:
        issues.append(f"{workflow_path.name}: missing gitleaks job")
        return issues

    gitleaks_steps = steps_for_job(gitleaks_job)
    checkout_step = next(
        (step for step in gitleaks_steps if uses_action(step, "actions/checkout")),
        None,
    )
    checkout_inputs = as_mapping(checkout_step.get("with")) if checkout_step is not None else None
    if checkout_inputs is None or str(checkout_inputs.get("fetch-depth")) != "0":
        issues.append(f"{workflow_path.name}: Gitleaks checkout must use fetch-depth: 0")

    gitleaks_step = next(
        (step for step in gitleaks_steps if uses_action(step, "gitleaks/gitleaks-action")),
        None,
    )
    if gitleaks_step is None:
        issues.append(f"{workflow_path.name}: missing Gitleaks action step")
    else:
        gitleaks_inputs = as_mapping(gitleaks_step.get("with"))
        if gitleaks_inputs is not None and "args" in gitleaks_inputs:
            issues.append(f"{workflow_path.name}: Gitleaks action v2 does not support with.args")
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
    issues.extend(security_issues(workflow_path, workflow))
    issues.extend(setup_uv_issues(workflow_path, workflow))
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
