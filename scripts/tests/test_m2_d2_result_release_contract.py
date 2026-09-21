from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
REHEARSAL_SCRIPT = REPOSITORY_ROOT / "scripts/m2_d2_result_release_rehearsal.mjs"
MATRIX = (REPOSITORY_ROOT / "docs/m2-d2-result-release-matrix.md").read_text(encoding="utf-8")
READINESS = (REPOSITORY_ROOT / "docs/production-readiness.md").read_text(encoding="utf-8")
SCHOOL = (REPOSITORY_ROOT / "docs/school-onboarding.md").read_text(encoding="utf-8")


def test_m2_d2_rehearsal_exercises_release_authority_boundaries():
    script = REHEARSAL_SCRIPT.read_text(encoding="utf-8")
    for marker in (
        "public_post_path",
        "release_path",
        "revoke_path",
        "unlock_path",
        "foreign_stage_id",
        "active release freezes post editing",
        "duplicate result release is idempotent",
        "request_timeout_ms: timeoutMs",
        "max_requests: 32",
        "inspect_result_release_rehearsal",
        "cleanup_result_release_rehearsal",
        "source_volumes_reset: false",
    ):
        assert marker in script


def test_m2_d2_fixture_commands_are_non_production_and_bounded():
    prepare = (
        REPOSITORY_ROOT / "common/management/commands/prepare_result_release_rehearsal.py"
    ).read_text(encoding="utf-8")
    cleanup = (
        REPOSITORY_ROOT / "common/management/commands/cleanup_result_release_rehearsal.py"
    ).read_text(encoding="utf-8")
    assert 'settings.APP_ENV == "production"' in prepare
    assert 'settings.APP_ENV == "production"' in cleanup
    assert "os.chmod" in prepare
    assert "_delete_exact_activity_rows" in cleanup
    assert "MEDIA_ROOT" in cleanup
    assert "transaction.atomic" in cleanup


def test_m2_d2_matrix_and_readiness_keep_school_boundary_explicit():
    for marker in (
        "RELEASE-01",
        "RELEASE-04",
        "RELEASE-07",
        "volumetric DDoS",
        "最多 32 个请求",
        "重置源数据库",
    ):
        assert marker in MATRIX
    assert "M2-D2 Public Result Release Authority" in READINESS
    assert "M2-D2" in SCHOOL
