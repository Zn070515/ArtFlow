from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
INTEGRATION_WORKFLOW = (REPOSITORY_ROOT / ".github/workflows/integration.yml").read_text(
    encoding="utf-8"
)
QUESTIONNAIRE_FLOW = (REPOSITORY_ROOT / "tests/e2e/questionnaire-flow.spec.ts").read_text(
    encoding="utf-8"
)
FIXTURE_COMMAND = (
    REPOSITORY_ROOT / "questionnaire/management/commands/prepare_questionnaire_e2e.py"
).read_text(encoding="utf-8")


def test_postgresql_compose_gate_runs_the_private_questionnaire_browser_fixture():
    for marker in (
        "prepare_questionnaire_e2e",
        "--formal-fixture",
        "docker compose cp web:/tmp/artflow-questionnaire-e2e.json",
        "PLAYWRIGHT_QUESTIONNAIRE_FIXTURE_PATH",
        "Remove questionnaire browser fixture",
    ):
        assert marker in INTEGRATION_WORKFLOW


def test_questionnaire_browser_flow_exercises_submit_upload_and_open_edit():
    for marker in (
        "toHaveURL(new RegExp(`/questionnaire/${fixture.activity_id}/$`))",
        'data-file-answer="r1.accompaniment"',
        'name: "browser-fixture.wav"',
        'name: "提交报名"',
        "浏览器修订曲目",
    ):
        assert marker in QUESTIONNAIRE_FLOW


def test_questionnaire_browser_fixture_is_test_only_and_does_not_print_credentials():
    assert 'settings.APP_ENV == "production"' in FIXTURE_COMMAND
    assert 'options["formal_fixture"]' in FIXTURE_COMMAND
    assert "is_test_mode=False" in FIXTURE_COMMAND
    assert (
        'self.stdout.write(self.style.SUCCESS("Questionnaire browser fixture prepared."))'
        in FIXTURE_COMMAND
    )
    assert '"password": password' in FIXTURE_COMMAND
    assert "self.stdout.write(password)" not in FIXTURE_COMMAND
