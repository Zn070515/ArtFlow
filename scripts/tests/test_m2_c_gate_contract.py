from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CI_WORKFLOW = (REPOSITORY_ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
INTEGRATION_WORKFLOW = (REPOSITORY_ROOT / ".github/workflows/integration.yml").read_text(
    encoding="utf-8"
)
READINESS_DOC = (REPOSITORY_ROOT / "docs/production-readiness.md").read_text(encoding="utf-8")


def test_ci_keeps_the_pyright_command_blocking():
    assert "run: npm run check:pyright\n" in CI_WORKFLOW
    assert "continue-on-error: true" not in CI_WORKFLOW


def test_windows_ci_uses_and_verifies_each_matrix_python_interpreter():
    assert (
        'run: uv sync --locked --all-extras --python "${{ matrix.python-version }}"' in CI_WORKFLOW
    )
    assert "UV_PYTHON: ${{ matrix.python-version }}" in CI_WORKFLOW
    assert "- name: Verify matrix Python interpreter" in CI_WORKFLOW
    assert '$expected = "${{ matrix.python-version }}"' in CI_WORKFLOW
    assert "uv run python -c" in CI_WORKFLOW
    assert "uv selected Python $actual instead of matrix target $expected" in CI_WORKFLOW


def test_full_sqlite_and_windows_suites_use_bounded_xdist_and_duration_reporting():
    assert CI_WORKFLOW.count("--maxprocesses=4") == 2
    assert CI_WORKFLOW.count("--dist=loadscope") == 2
    assert CI_WORKFLOW.count("--durations=30") == 2
    assert "fail-fast: true" in CI_WORKFLOW


def test_postgresql_integration_runs_only_the_explicit_marker_gate():
    marker_command = """      - name: Run PostgreSQL-specific tests
        run: uv run pytest -q -m postgresql --durations=30
"""
    assert marker_command in INTEGRATION_WORKFLOW
    assert "Run focused Ticket and entitlement tests" not in INTEGRATION_WORKFLOW
    assert "Run M2-C Judge authority focused gate" not in INTEGRATION_WORKFLOW
    assert "Run full test suite" not in INTEGRATION_WORKFLOW


def test_published_static_probe_uses_configured_django_entrypoint():
    assert "docker compose exec -T web python manage.py shell -c" in INTEGRATION_WORKFLOW
    assert "import django; django.setup();" not in INTEGRATION_WORKFLOW


def test_readiness_records_m2_c_gate_and_preserves_institutional_holds():
    assert "M2-C-GATE" in READINESS_DOC
    for hold in ("SSO", "MFA", "TLS/WAF/DDoS", "数据责任与保存期限"):
        assert hold in READINESS_DOC
