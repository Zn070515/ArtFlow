from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
REHEARSAL_SCRIPT = REPOSITORY_ROOT / "scripts/media_download_load_rehearsal.mjs"
PREPARE_COMMAND = REPOSITORY_ROOT / "common/management/commands/prepare_media_download_rehearsal.py"
CLEANUP_COMMAND = REPOSITORY_ROOT / "common/management/commands/cleanup_media_download_rehearsal.py"
READINESS = (REPOSITORY_ROOT / "docs/production-readiness.md").read_text(encoding="utf-8")
DEPLOYMENT = (REPOSITORY_ROOT / "docs/deployment-production.md").read_text(encoding="utf-8")


def test_media_download_rehearsal_measures_starvation_and_rechecks_authorization():
    script = REHEARSAL_SCRIPT.read_text(encoding="utf-8")
    for marker in (
        "ARTFLOW_MEDIA_LOAD_FIXTURE_PATH",
        "ARTFLOW_MEDIA_LOAD_CLIENTS",
        "ARTFLOW_MEDIA_LOAD_DURATION_MS",
        "ARTFLOW_MEDIA_LOAD_REPORT_PATH",
        "/livez/",
        "workers_starved",
        "authorization_while_starved",
        "unauthenticated download was served",
        "source_volumes_reset: false",
        "localhost/127.0.0.1/::1",
        "capped at 120000",
    ):
        assert marker in script


def test_media_download_fixture_commands_are_non_production_and_bounded():
    prepare = PREPARE_COMMAND.read_text(encoding="utf-8")
    cleanup = CLEANUP_COMMAND.read_text(encoding="utf-8")
    assert 'settings.APP_ENV == "production"' in prepare
    assert 'settings.APP_ENV == "production"' in cleanup
    assert "os.chmod" in prepare
    assert "Refusing to overwrite fixture file" in prepare
    assert "MEDIA_ROOT" in cleanup
    assert "transaction.atomic" in cleanup
    assert "Refusing to remove media outside MEDIA_ROOT" in cleanup


def test_media_download_rehearsal_is_referenced_from_the_production_docs():
    assert "media_download_load_rehearsal" in DEPLOYMENT
    assert "media_download_load_rehearsal" in READINESS
