import subprocess
import sys
import tempfile
from pathlib import Path
from textwrap import dedent

VERIFIER_PATH = Path(__file__).resolve().parents[1] / "verify_workflows.py"
CHECKOUT_SHA = "11bd71901bbe5b1630ceea73d27597364c9af683"


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
        """
    )


def run_verifier(workflow: str) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as temporary_directory:
        workflow_path = Path(temporary_directory) / "integration.yml"
        workflow_path.write_text(workflow, encoding="utf-8")
        return subprocess.run(
            [sys.executable, str(VERIFIER_PATH), str(workflow_path)],
            check=False,
            capture_output=True,
            text=True,
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
