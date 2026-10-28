from __future__ import annotations

import json
from pathlib import Path

from scripts.artflow_comparison import analyze_repository, render_json, render_markdown


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_comparison_uses_explicit_v1_v2_exclusions_and_extracts_contract_metrics(
    tmp_path: Path,
) -> None:
    write(
        tmp_path / "core" / "models.py",
        "class Activity(models.Model):\n    pass\n\n"
        "class NotARecord: pass\n",
    )
    write(
        tmp_path / "core" / "urls.py",
        "urlpatterns = [path(\"health/\", view), re_path(r\"^x/\", view)]\n",
    )
    write(
        tmp_path / "core" / "tests.py",
        "def test_activity_is_visible():\n    assert True\n\n"
        "class ActivityTests(TestCase):\n    def test_lifecycle(self):\n        pass\n",
    )
    write(tmp_path / "core" / "migrations" / "0001_initial.py", "# migration\n" * 4)
    write(tmp_path / "staticfiles" / "generated.py", "not source\n" * 50)

    write(
        tmp_path / "plus" / "apps" / "api" / "src" / "app.ts",
        'app.get("/healthz", handler);\napp.post("/api/x", handler);\n',
    )
    write(
        tmp_path / "plus" / "packages" / "db" / "src" / "types.ts",
        "export interface ActivityRow { id: string; }\n"
        "export interface RegistrationRow { id: string; }\n",
    )
    write(
        tmp_path / "plus" / "packages" / "db" / "src" / "migrations.ts",
        'db.schema.createTable("activity");\n'
        'db.schema.createTable("registration");\n',
    )
    write(
        tmp_path / "plus" / "packages" / "domain" / "test" / "domain.test.ts",
        'it("accepts a valid activity", () => {});\n'
        'test("rejects an invalid activity", () => {});\n',
    )
    write(tmp_path / "plus" / "node_modules" / "ignored.ts", "x\n" * 100)

    report = analyze_repository(tmp_path)

    assert report.schema_version == 1
    assert report.v1.source_files == 2
    assert report.v1.source_lines == 4
    assert report.v1.test_files == 1
    assert report.v1.test_declarations == 3
    assert report.v1.route_declarations == 2
    assert report.v1.model_declarations == 1
    assert report.v1.migration_files == 1
    assert report.v1.migration_lines == 4

    assert report.v2.source_files == 2
    assert report.v2.source_lines == 4
    assert report.v2.test_files == 1
    assert report.v2.test_declarations == 2
    assert report.v2.route_declarations == 2
    assert report.v2.model_declarations == 2
    assert report.v2.table_declarations == 2
    assert report.v2.migration_files == 1
    assert report.v2.migration_lines == 2


def test_renderers_are_machine_readable_and_explain_ratios(tmp_path: Path) -> None:
    write(tmp_path / "plus" / "apps" / "api" / "src" / "app.ts", "app.get('/healthz', handler);\n")
    report = analyze_repository(tmp_path)

    payload = json.loads(render_json(report))
    markdown = render_markdown(report)

    assert payload["schema_version"] == 1
    assert payload["v2"]["source_files"] == 1
    assert "## Measurement contract" in markdown
    assert "test declarations per 1,000 source lines" in markdown
    assert "source files" in markdown
