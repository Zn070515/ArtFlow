"""The load simulation's guards, pinned where they cannot drift.

Two of these are safety properties rather than conveniences: the runner must refuse a base URL
that is not loopback (it drives a real service and a real database), and the fixture must refuse
an access key inside the manifest (a file holding both a username and its key is a ready-to-use
credential bundle).
"""

from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
RUNNER = REPOSITORY_ROOT / "scripts/site_load_rehearsal.mjs"
PREPARE_COMMAND = REPOSITORY_ROOT / "common/management/commands/prepare_site_load_rehearsal.py"
PLAN = (REPOSITORY_ROOT / "docs/local-load-simulation-plan.md").read_text(encoding="utf-8")


def test_runner_drives_real_pages_and_keeps_measurements_apart_from_hard_checks():
    runner = RUNNER.read_text(encoding="utf-8")
    for marker in (
        "ARTFLOW_LOAD_MANIFEST_PATH",
        "ARTFLOW_LOAD_STAFF_ACCESS_KEY",
        "ARTFLOW_LOAD_ADMIN_ACCESS_KEY",
        "ARTFLOW_LOAD_SPEED",
        "ARTFLOW_LOAD_PHASES",
        "ARTFLOW_LOAD_AUDIENCE_LIMIT",
        "localhost/127.0.0.1/::1",
        # The actors have to walk the pages the show walks, not call services behind them.
        "/login/staff/",
        "/tickets/scan/",
        "提交投票",
        "确认检票",
        "暂停评委组",
        "judge-entry/toggle",
        "judge-entry/rotate",
        # Measurements are numbers; a Django 500 is a defect and exits non-zero.
        "django_500_count",
        "proxy_502_504_count",
        "process.exitCode = 1",
    ):
        assert marker in runner


def test_runner_refuses_a_non_loopback_target():
    runner = RUNNER.read_text(encoding="utf-8")

    assert 'if (base.protocol !== "http:"' in runner
    assert "This rehearsal only accepts an HTTP service on localhost" in runner


def test_fixture_is_non_production_bounded_and_keeps_keys_out_of_the_manifest():
    prepare = PREPARE_COMMAND.read_text(encoding="utf-8")

    assert 'settings.APP_ENV == "production"' in prepare
    assert "Refusing to overwrite fixture file" in prepare
    assert "os.chmod" in prepare
    assert "transaction.atomic" in prepare
    # The capability the QR carries has to reach the actors, and no access key may.
    assert '"judge_entry_token": judge_entry_credential(activity)' in prepare
    assert "staff_access_key" not in prepare
    assert "admin_access_key" not in prepare


def test_the_plan_records_the_decisions_the_run_depends_on():
    for marker in (
        "bebcb949",
        "compose.event.yml",
        "基数 150",
        "268",
        "12 分钟",
        "本轮不改代码",
        "git diff --stat bebcb949",
    ):
        assert marker in PLAN
