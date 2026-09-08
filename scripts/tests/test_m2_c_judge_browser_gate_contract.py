from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
INTEGRATION_WORKFLOW = (REPOSITORY_ROOT / ".github/workflows/integration.yml").read_text(
    encoding="utf-8"
)
JUDGE_FLOW = (REPOSITORY_ROOT / "tests/e2e/judge-flow.spec.ts").read_text(encoding="utf-8")
FIXTURE_COMMAND = (
    REPOSITORY_ROOT / "singer_contest/management/commands/prepare_judge_e2e.py"
).read_text(encoding="utf-8")


def test_postgresql_compose_gate_prepares_and_passes_a_private_judge_fixture():
    assert "prepare_judge_e2e" in INTEGRATION_WORKFLOW
    assert "docker compose cp web:/tmp/artflow-judge-e2e.json" in INTEGRATION_WORKFLOW
    assert "PLAYWRIGHT_JUDGE_FIXTURE_PATH" in INTEGRATION_WORKFLOW
    assert "Remove Judge browser fixture" in INTEGRATION_WORKFLOW


def test_judge_browser_gate_covers_positive_redeem_context_and_retry_flow():
    for marker in (
        "judge browser completes redeem, context, ACK-loss retry, and idempotent receipt",
        "judge/terminal/#",
        "网络暂时不可用",
        "评分已确认。",
        "expect(scoreRequests).toBe(2)",
    ):
        assert marker in JUDGE_FLOW


def test_judge_browser_fixture_cannot_run_in_production_or_print_grant():
    assert 'settings.APP_ENV == "production"' in FIXTURE_COMMAND
    assert (
        'self.stdout.write(self.style.SUCCESS("Judge browser fixture prepared."))'
        in FIXTURE_COMMAND
    )
    assert '"grant_token": issued.token' in FIXTURE_COMMAND
    assert "self.stdout.write(issued.token)" not in FIXTURE_COMMAND
