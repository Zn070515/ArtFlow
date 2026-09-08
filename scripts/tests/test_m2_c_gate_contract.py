from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CI_WORKFLOW = (REPOSITORY_ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
INTEGRATION_WORKFLOW = (REPOSITORY_ROOT / ".github/workflows/integration.yml").read_text(
    encoding="utf-8"
)
READINESS_DOC = (REPOSITORY_ROOT / "docs/production-readiness.md").read_text(
    encoding="utf-8"
)


def test_ci_keeps_both_pyright_commands_blocking():
    assert "run: npm run check:pyright\n" in CI_WORKFLOW
    assert "run: npm run check:pyright:entry-access\n" in CI_WORKFLOW
    assert "continue-on-error: true" not in CI_WORKFLOW


def test_postgresql_integration_has_the_m2_c_focused_gate_before_full_suite():
    focused_command = """          uv run python manage.py test
          singer_contest.test_judge_authority
          singer_contest.test_judge_http
          staff_panel.tests.JudgeControlHTTPTests
"""
    assert focused_command in INTEGRATION_WORKFLOW
    assert INTEGRATION_WORKFLOW.index("Run M2-C Judge authority focused gate") < (
        INTEGRATION_WORKFLOW.index("Run full test suite")
    )


def test_readiness_records_m2_c_gate_and_preserves_institutional_holds():
    assert "M2-C-GATE" in READINESS_DOC
    for hold in ("SSO", "MFA", "TLS/WAF/DDoS", "数据责任与保存期限"):
        assert hold in READINESS_DOC
