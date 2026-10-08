from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
INTEGRATION_WORKFLOW = (REPOSITORY_ROOT / ".github/workflows/integration.yml").read_text(
    encoding="utf-8"
)
JUDGE_FLOW = (REPOSITORY_ROOT / "tests/e2e/judge-flow.spec.ts").read_text(encoding="utf-8")
SHARED_JUDGE_FLOW = (REPOSITORY_ROOT / "tests/e2e/judge-shared-entry-flow.spec.ts").read_text(
    encoding="utf-8"
)
LIVE_TICKET_FLOW = (REPOSITORY_ROOT / "tests/e2e/live-ticket-flow.spec.ts").read_text(
    encoding="utf-8"
)
FIXTURE_COMMAND = (
    REPOSITORY_ROOT / "singer_contest/management/commands/prepare_judge_e2e.py"
).read_text(encoding="utf-8")
LIVE_TICKET_FIXTURE_COMMAND = (
    REPOSITORY_ROOT / "voting/management/commands/prepare_live_ticket_e2e.py"
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
        "评分已确认：",
        "等待现场切换下一位选手",
        "expect(scoreRequests).toBe(2)",
    ):
        assert marker in JUDGE_FLOW


def test_judge_browser_fixture_cannot_run_in_production_or_print_grant():
    assert 'settings.APP_ENV == "production"' in FIXTURE_COMMAND
    assert (
        'self.stdout.write(self.style.SUCCESS("Judge browser fixture prepared."))'
        in FIXTURE_COMMAND
    )
    assert 'fixture["grant_token"] = issued.token' in FIXTURE_COMMAND
    assert '"public_code": activity.public_code' in FIXTURE_COMMAND
    assert "judge_entry_open=True" in FIXTURE_COMMAND
    assert '"--shared-entry"' in FIXTURE_COMMAND
    assert "self.stdout.write(issued.token)" not in FIXTURE_COMMAND


def test_shared_judge_browser_gate_covers_fixed_capacity_and_stable_entry():
    # The refusal marker is the §12.3 wording ("reject *and* tell them to contact staff").
    # It used to be the generic "scan the QR again" line, which every refusal produced
    # before the terminal learned to name its reason.
    for marker in (
        "shared judge entry assigns five terminals, survives HOLD, and rejects the sixth",
        "`/e/${fixture.public_code}/judge/`",
        "评委终端已就绪。",
        "评委席已满，请联系现场工作人员处理。",
    ):
        assert marker in SHARED_JUDGE_FLOW


def test_live_ticket_browser_gate_covers_open_poll_check_in_and_ballot():
    for marker in (
        "prepare_live_ticket_e2e",
        "PLAYWRIGHT_LIVE_TICKET_FIXTURE_PATH",
        "one live URL updates, checks in a ticket, and admits a ballot",
        "开启投票",
        "检票成功",
        "投票成功",
    ):
        assert marker in INTEGRATION_WORKFLOW or marker in LIVE_TICKET_FLOW
    assert '"credential": ticket_credential(issued.ticket)' in LIVE_TICKET_FIXTURE_COMMAND
