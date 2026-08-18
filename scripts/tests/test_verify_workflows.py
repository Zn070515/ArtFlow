import subprocess
import sys
import tempfile
from pathlib import Path
from textwrap import dedent

VERIFIER_PATH = Path(__file__).resolve().parents[1] / "verify_workflows.py"
CHECKOUT_SHA = "11bd71901bbe5b1630ceea73d27597364c9af683"
CODEQL_SHA = "bb16b9baa2ec4010b29f5c606d57d01190139edd"
GITLEAKS_SHA = "ff98106e4c7b2bc287b24eaf42907196329070c7"
SETUP_UV_SHA = "c771a70e6277c0a99b617c7a806ffedaca235ff9"


def valid_workflow() -> str:
    return dedent(
        f"""\
        name: PostgreSQL integration
        on: push
        permissions:
          contents: read
        concurrency:
          group: integration-${{{{ github.ref }}}}
          cancel-in-progress: true
        jobs:
          postgresql:
            runs-on: ubuntu-latest
            timeout-minutes: 25
            services:
              postgres:
                image: postgres:16-alpine
                ports:
                  - "127.0.0.1:5432:5432"
            env:
              POSTGRES_HOST: 127.0.0.1
            steps:
              - name: Check out source
                uses: actions/checkout@{CHECKOUT_SHA} # v4.2.2
          compose-smoke:
            runs-on: ubuntu-latest
            timeout-minutes: 25
            steps:
              - name: Start Compose stack
                run: docker compose up --build --wait
              - name: Verify running container health
                run: |
                  docker compose ps --status running --services
                  web_container="$(docker compose ps -q web)"
                  health="$(docker inspect "$web_container" --format '{{{{.State.Health.Status}}}}')"
                  test "$health" = healthy
              - name: Apply migrations in web
                run: docker compose exec -T web python manage.py migrate --noinput
              - name: Run diagnostics in web
                run: docker compose exec -T web python manage.py doctor
              - name: Check health endpoint in web
                run: >-
                  docker compose exec -T web python -c
                  "from urllib.request import urlopen; response = urlopen('http://127.0.0.1:8000/healthz/', timeout=3);
                  raise SystemExit(0 if response.status == 200 else response.status)"
              - name: Seed demo data twice in web
                run: |
                  docker compose exec -T web python manage.py seed_demo_data
                  docker compose exec -T web python manage.py seed_demo_data
              - name: Preserve Compose volumes
                if: ${{{{ always() }}}}
                run: docker compose down
        """
    )


def run_verifier(
    workflow: str, workflow_name: str = "integration.yml"
) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as temporary_directory:
        workflow_path = Path(temporary_directory) / workflow_name
        workflow_path.write_text(workflow, encoding="utf-8")
        return subprocess.run(
            [sys.executable, str(VERIFIER_PATH), str(workflow_path)],
            check=False,
            capture_output=True,
            text=True,
        )


def insecure_security_workflow() -> str:
    return dedent(
        f"""\
        name: Security
        on: push
        permissions:
          contents: read
        concurrency:
          group: security-${{{{ github.ref }}}}
          cancel-in-progress: true
        jobs:
          codeql:
            runs-on: ubuntu-latest
            timeout-minutes: 25
            permissions:
              contents: read
            steps:
              - name: Initialize CodeQL
                uses: github/codeql-action/init@{CODEQL_SHA} # v4.37.1
                with:
                  languages: python
              - name: Analyze with CodeQL
                uses: github/codeql-action/analyze@{CODEQL_SHA} # v4.37.1
                with:
                  upload: never
          gitleaks:
            runs-on: ubuntu-latest
            timeout-minutes: 15
            permissions:
              contents: read
            steps:
              - name: Check out complete history
                uses: actions/checkout@{CHECKOUT_SHA} # v4.2.2
                with:
                  fetch-depth: 1
              - name: Scan Git history with Gitleaks
                uses: gitleaks/gitleaks-action@{GITLEAKS_SHA} # v2.3.9
                with:
                  args: detect --source . --log-opts=--all --redact
        """
    )


def workflow_with_unpinned_uv_tool() -> str:
    return dedent(
        f"""\
        name: CI
        on: push
        permissions:
          contents: read
        concurrency:
          group: ci-${{{{ github.ref }}}}
          cancel-in-progress: true
        jobs:
          lint:
            runs-on: ubuntu-latest
            timeout-minutes: 15
            steps:
              - name: Set up uv
                uses: astral-sh/setup-uv@{SETUP_UV_SHA} # v9.0.0
                with:
                  enable-cache: true
        """
    )


def test_verifier_accepts_loopback_only_postgresql_workflow():
    result = run_verifier(valid_workflow())

    assert result.returncode == 0, result.stderr


def test_verifier_rejects_workflow_contract_violations():
    cases = {
        "public_postgresql_port": (
            valid_workflow().replace("127.0.0.1:5432:5432", "0.0.0.0:5432:5432"),
            "must bind to 127.0.0.1",
        ),
        "write_all_permissions": (
            valid_workflow().replace("permissions:\n  contents: read", "permissions: write-all"),
            "must not use write-all permissions",
        ),
        "missing_concurrency_cancellation": (
            valid_workflow().replace("  cancel-in-progress: true\n", ""),
            "must enable cancel-in-progress",
        ),
        "missing_job_timeout": (
            valid_workflow().replace("    timeout-minutes: 25\n", ""),
            "must set timeout-minutes",
        ),
        "unpinned_action": (
            valid_workflow().replace(
                f"actions/checkout@{CHECKOUT_SHA} # v4.2.2", "actions/checkout@v4"
            ),
            "must use a 40-character SHA with a version comment",
        ),
        "literal_credential": (
            valid_workflow().replace(
                "POSTGRES_HOST: 127.0.0.1",
                "POSTGRES_HOST: 127.0.0.1\n      POSTGRES_PASSWORD: unsafe-literal",
            ),
            "must not contain a literal credential",
        ),
    }

    for name, (workflow, expected_message) in cases.items():
        result = run_verifier(workflow)

        assert result.returncode == 1, name
        assert expected_message in result.stderr, name


def test_verifier_rejects_unenforceable_codeql_and_partial_gitleaks_contracts():
    result = run_verifier(insecure_security_workflow(), "security.yml")

    assert result.returncode == 1
    assert "CodeQL must grant security-events: write" in result.stderr
    assert "CodeQL must upload SARIF results" in result.stderr
    assert "Gitleaks checkout must use fetch-depth: 0" in result.stderr
    assert "Gitleaks action v2 does not support with.args" in result.stderr


def test_verifier_requires_an_exact_setup_uv_tool_version():
    result = run_verifier(workflow_with_unpinned_uv_tool(), "ci.yml")

    assert result.returncode == 1
    assert "setup-uv must set version to 0.11.29" in result.stderr


def test_verifier_requires_compose_container_acceptance_job():
    workflow = valid_workflow().split("  compose-smoke:")[0]

    result = run_verifier(workflow)

    assert result.returncode == 1
    assert "missing compose-smoke job" in result.stderr


def test_verifier_rejects_incomplete_compose_container_acceptance_job():
    workflow = (
        valid_workflow()
        .replace("docker compose up --build --wait", "docker compose up --build")
        .replace("docker compose ps --status running --services", "true")
        .replace("State.Health.Status", "State.Status")
        .replace("docker compose exec -T web python manage.py doctor", "true")
        .replace("docker compose exec -T web python manage.py seed_demo_data", "true")
        .replace("docker compose down", "docker compose down --volumes")
    )

    result = run_verifier(workflow)

    assert result.returncode == 1
    assert "Compose smoke must run docker compose up --build --wait" in result.stderr
    assert "Compose smoke must verify the running container health" in result.stderr
    assert "Compose smoke must run migrate, doctor, health, and seed twice in web" in result.stderr
    assert "Compose smoke must clean up with docker compose down in an always step" in result.stderr
