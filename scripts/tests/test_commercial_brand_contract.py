from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
INSTITUTIONAL_MARKERS = ("浙江工业大学", "浙江工业", "信息工程学院", "zjut.edu.cn")


def test_runtime_brand_surfaces_do_not_contain_institution_specific_identity():
    runtime_files = (
        REPOSITORY_ROOT / "templates/base.html",
        REPOSITORY_ROOT / "templates/public_portal/home.html",
        REPOSITORY_ROOT / "exports/services.py",
    )
    for path in runtime_files:
        content = path.read_text(encoding="utf-8")
        for marker in INSTITUTIONAL_MARKERS:
            assert marker not in content, f"{path} still contains {marker!r}"


def test_reusable_yuan_shijia_fixture_remains_available():
    goal = (REPOSITORY_ROOT / "GOAL.md").read_text(encoding="utf-8")
    templates = (REPOSITORY_ROOT / "ruleset/templates.py").read_text(encoding="utf-8")
    assert "院十佳" in goal
    assert "院十佳" in templates
