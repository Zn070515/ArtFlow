from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
REHEARSAL_SCRIPT = REPOSITORY_ROOT / "scripts/m2_d1_result_closure_mutation_rehearsal.mjs"
FIXTURE_COMMAND = REPOSITORY_ROOT / "common/management/commands/prepare_result_closure_rehearsal.py"


def test_m2_d1_mutation_rehearsal_exercises_all_gate_boundaries():
    script = REHEARSAL_SCRIPT.read_text(encoding="utf-8")

    for marker in (
        "fixture.confirm_path",
        "fixture.unlock_path",
        "fixture.archive_path",
        "duplicate_confirm_count",
        "stale_rejection_count",
        "official_source_leakage_count",
        "foreign_award_marker",
        "docker",
        "inspect_result_closure_rehearsal",
        "BytesIO",
        "ZipFile",
    ):
        assert marker in script

    assert "duplicate_confirm_count: inspection.duplicate_confirm_count" in script
    assert "stale_rejection_count: inspection.stale_rejection_count" in script


def test_m2_d1_fixture_command_is_non_production_and_private():
    command = FIXTURE_COMMAND.read_text(encoding="utf-8")

    assert 'settings.APP_ENV == "production"' in command
    assert "is_test_mode=True" in command
    assert "SESSION_COOKIE_NAME" in command
    assert "csrf_token" in command
    assert "chmod" in command
