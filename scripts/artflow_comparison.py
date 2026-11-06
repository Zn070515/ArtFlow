"""Reproducible, dependency-free comparison metrics for the two ArtFlow eras."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Iterable, Literal

MetricFormat = Literal["markdown", "json"]

V1_APP_NAMES = (
    "accounts",
    "archive",
    "common",
    "config",
    "core",
    "entry_access",
    "exports",
    "farewell_show",
    "files",
    "incidents",
    "public_portal",
    "questionnaire",
    "realtime",
    "ruleset",
    "singer_contest",
    "staff_panel",
    "tickets",
    "voting",
)
V1_SOURCE_SUFFIXES = {".html", ".js", ".py", ".css", ".ts", ".tsx"}
V2_SOURCE_SUFFIXES = {".css", ".ts", ".tsx"}
V1_TEST_NAMES = {"tests.py"}
V2_TEST_SUFFIXES = (".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")
SKIPPED_PARTS = {"__pycache__", ".git", "node_modules", "dist", "build", "coverage", "staticfiles"}

V1_ROUTE_RE = re.compile(r"\b(?:path|re_path|url)\s*\(")
V1_MODEL_RE = re.compile(r"^\s*class\s+\w+\s*\([^\n)]*models\.Model")
V2_ROUTE_RE = re.compile(r"\bapp\.(?:get|post|put|patch|delete|options|head|route)\s*\(")
V2_MODEL_RE = re.compile(r"^\s*export\s+interface\s+\w+Row\s*\{")
V2_TABLE_RE = re.compile(r"\.createTable\(\s*['\"]([^'\"]+)['\"]\s*\)")
V1_TEST_DECLARATION_RE = re.compile(r"^\s*(?:def\s+test\w*|class\s+\w*Tests\b)")
V2_TEST_DECLARATION_RE = re.compile(r"\b(?:it|test)\s*\(")
V2_ROUTE_METHOD_RE = re.compile(r"\bapp\.(get|post|put|patch|delete|options|head|route)\s*\(")


@dataclass(frozen=True)
class LargestFile:
    path: str
    lines: int


@dataclass(frozen=True)
class AreaMetrics:
    name: str
    source_files: int
    source_lines: int
    test_files: int
    test_lines: int
    test_declarations: int


@dataclass(frozen=True)
class EraMetrics:
    source_files: int
    source_lines: int
    test_files: int
    test_lines: int
    test_declarations: int
    route_declarations: int
    model_declarations: int
    table_declarations: int
    migration_files: int
    migration_lines: int
    largest_files: tuple[LargestFile, ...]
    areas: tuple[AreaMetrics, ...]
    route_by_method: tuple[tuple[str, int], ...]

    @property
    def test_declarations_per_1000_source_lines(self) -> float:
        if self.source_lines == 0:
            return 0.0
        return self.test_declarations * 1000 / self.source_lines

    @property
    def test_lines_per_source_line(self) -> float:
        if self.source_lines == 0:
            return 0.0
        return self.test_lines / self.source_lines


@dataclass(frozen=True)
class ComparisonReport:
    schema_version: int
    v1: EraMetrics
    v2: EraMetrics


def _files_under(paths: Iterable[Path], suffixes: set[str]) -> list[Path]:
    files: list[Path] = []
    for base in paths:
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in suffixes:
                continue
            if any(part in SKIPPED_PARTS for part in path.parts):
                continue
            files.append(path)
    return sorted(files)


def _line_count(path: Path) -> int:
    return sum(
        1
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    )


def _is_v1_test(path: Path) -> bool:
    return (
        path.name in V1_TEST_NAMES
        or path.name.startswith("test_")
        or path.name.endswith("_tests.py")
    )


def _is_v2_test(path: Path) -> bool:
    return path.name.endswith(V2_TEST_SUFFIXES) or "test" in path.parts


def _count_matches(path: Path, pattern: re.Pattern[str]) -> int:
    return sum(len(pattern.findall(line)) for line in path.read_text(encoding="utf-8").splitlines())


def _count_named_matches(path: Path, pattern: re.Pattern[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        for match in pattern.findall(line):
            method = str(match)
            counts[method] = counts.get(method, 0) + 1
    return counts


def _largest(root: Path, files: Iterable[Path]) -> tuple[LargestFile, ...]:
    ranked = sorted(
        ((path, _line_count(path)) for path in files),
        key=lambda item: (-item[1], item[0].as_posix()),
    )[:10]
    return tuple(
        LargestFile(path=path.relative_to(root).as_posix(), lines=lines)
        for path, lines in ranked
    )


def _v1_files(root: Path) -> tuple[list[Path], list[Path]]:
    bases = [root / name for name in V1_APP_NAMES]
    all_files = _files_under(bases + [root / "frontend", root / "templates"], V1_SOURCE_SUFFIXES)
    return [path for path in all_files if _is_v1_test(path)], [
        path
        for path in all_files
        if not _is_v1_test(path) and "migrations" not in path.parts
    ]


def _v2_files(root: Path) -> tuple[list[Path], list[Path]]:
    all_files = _files_under(
        [root / "plus" / "apps", root / "plus" / "packages"],
        V2_SOURCE_SUFFIXES,
    )
    return [path for path in all_files if _is_v2_test(path)], [
        path for path in all_files
        if not _is_v2_test(path) and path.name != "migrations.ts" and "migrations" not in path.parts
    ]


def _v1_migrations(root: Path) -> list[Path]:
    return _files_under([root / name / "migrations" for name in V1_APP_NAMES], {".py"})


def _v2_migrations(root: Path) -> list[Path]:
    path = root / "plus" / "packages" / "db" / "src" / "migrations.ts"
    return [path] if path.exists() else []


def _area_metrics(
    root: Path,
    areas: Iterable[tuple[str, Path]],
    *,
    suffixes: set[str],
    is_test: Callable[[Path], bool],
) -> tuple[AreaMetrics, ...]:
    result: list[AreaMetrics] = []
    for name, base in areas:
        files = _files_under([base], suffixes)
        tests = [path for path in files if is_test(path)]
        source = [
            path
            for path in files
            if not is_test(path)
            and path.name != "migrations.ts"
            and "migrations" not in path.parts
        ]
        if not files:
            continue
        pattern = (
            V1_TEST_DECLARATION_RE
            if suffixes == V1_SOURCE_SUFFIXES
            else V2_TEST_DECLARATION_RE
        )
        result.append(AreaMetrics(
            name=name,
            source_files=len(source),
            source_lines=sum(_line_count(path) for path in source),
            test_files=len(tests),
            test_lines=sum(_line_count(path) for path in tests),
            test_declarations=sum(_count_matches(path, pattern) for path in tests),
        ))
    return tuple(result)


def _metrics(
    root: Path,
    *,
    test_files: list[Path],
    source_files: list[Path],
    migration_files: list[Path],
    route_pattern: re.Pattern[str],
    model_pattern: re.Pattern[str],
    table_pattern: re.Pattern[str] | None,
    test_pattern: re.Pattern[str],
    areas: tuple[AreaMetrics, ...],
    route_by_method: tuple[tuple[str, int], ...],
) -> EraMetrics:
    route_files = [
        path for path in source_files if path.name == "urls.py" or path.name == "app.ts"
    ]
    model_files = [
        path for path in source_files if path.name == "models.py" or path.name == "types.ts"
    ]
    table_sources = migration_files if table_pattern is not None else []
    return EraMetrics(
        source_files=len(source_files),
        source_lines=sum(_line_count(path) for path in source_files),
        test_files=len(test_files),
        test_lines=sum(_line_count(path) for path in test_files),
        test_declarations=sum(_count_matches(path, test_pattern) for path in test_files),
        route_declarations=sum(_count_matches(path, route_pattern) for path in route_files),
        model_declarations=sum(_count_matches(path, model_pattern) for path in model_files),
        table_declarations=(
            sum(
                len(table_pattern.findall(path.read_text(encoding="utf-8")))
                for path in table_sources
            )
            if table_pattern is not None
            else 0
        ),
        migration_files=len(migration_files),
        migration_lines=sum(_line_count(path) for path in migration_files),
        largest_files=_largest(root, source_files),
        areas=areas,
        route_by_method=route_by_method,
    )


def analyze_repository(root: Path) -> ComparisonReport:
    """Measure the checked-in source tree at *root* using the report contract."""
    v1_tests, v1_source = _v1_files(root)
    v2_tests, v2_source = _v2_files(root)
    v1_route_counts: dict[str, int] = {}
    for path in v1_source:
        if path.name == "urls.py":
            v1_route_counts["path/re_path/url"] = (
                v1_route_counts.get("path/re_path/url", 0)
                + _count_matches(path, V1_ROUTE_RE)
            )
    v2_route_counts: dict[str, int] = {}
    for path in v2_source:
        if path.name == "app.ts":
            for method, count in _count_named_matches(path, V2_ROUTE_METHOD_RE).items():
                v2_route_counts[method] = v2_route_counts.get(method, 0) + count
    return ComparisonReport(
        schema_version=1,
        v1=_metrics(
            root,
            test_files=v1_tests,
            source_files=v1_source,
            migration_files=_v1_migrations(root),
            route_pattern=V1_ROUTE_RE,
            model_pattern=V1_MODEL_RE,
            table_pattern=None,
            test_pattern=V1_TEST_DECLARATION_RE,
            areas=_area_metrics(
                root,
                tuple((name, root / name) for name in V1_APP_NAMES)
                + (("frontend", root / "frontend"), ("templates", root / "templates")),
                suffixes=V1_SOURCE_SUFFIXES,
                is_test=_is_v1_test,
            ),
            route_by_method=tuple(sorted(v1_route_counts.items())),
        ),
        v2=_metrics(
            root,
            test_files=v2_tests,
            source_files=v2_source,
            migration_files=_v2_migrations(root),
            route_pattern=V2_ROUTE_RE,
            model_pattern=V2_MODEL_RE,
            table_pattern=V2_TABLE_RE,
            test_pattern=V2_TEST_DECLARATION_RE,
            areas=_area_metrics(
                root,
                tuple(
                    (f"apps/{path.name}", path)
                    for path in sorted((root / "plus" / "apps").glob("*"))
                    if path.is_dir()
                )
                + tuple(
                    (f"packages/{path.name}", path)
                    for path in sorted((root / "plus" / "packages").glob("*"))
                    if path.is_dir()
                ),
                suffixes=V2_SOURCE_SUFFIXES,
                is_test=_is_v2_test,
            ),
            route_by_method=tuple(sorted(v2_route_counts.items())),
        ),
    )


def _as_dict(report: ComparisonReport) -> dict[str, object]:
    payload = asdict(report)
    for era in ("v1", "v2"):
        metrics = getattr(report, era)
        payload[era]["test_declarations_per_1000_source_lines"] = (
            metrics.test_declarations_per_1000_source_lines
        )
        payload[era]["test_lines_per_source_line"] = metrics.test_lines_per_source_line
    return payload


def render_json(report: ComparisonReport) -> str:
    return json.dumps(_as_dict(report), ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def _metric_row(label: str, v1: object, v2: object) -> str:
    return f"| {label} | {v1} | {v2} |\n"


def render_markdown(report: ComparisonReport) -> str:
    lines = [
        "# ArtFlow v1 / v2 measured snapshot",
        "",
        "## Measurement contract",
        "",
        (
            "The analyzer excludes generated/vendor directories, excludes test and "
            "migration files from source LOC, and reports test/migration LOC "
            "separately. A test declaration is a named Django test method/class in "
            "v1 or an `it`/`test` call in v2; it is a comparable proxy, not a claim "
            "that the two frameworks execute identical cases."
        ),
        "",
        "| Metric | v1 | v2 |",
        "| --- | ---: | ---: |",
    ]
    v1 = report.v1
    v2 = report.v2
    rows = (
        ("source files", v1.source_files, v2.source_files),
        ("source lines", v1.source_lines, v2.source_lines),
        ("test files", v1.test_files, v2.test_files),
        ("test lines", v1.test_lines, v2.test_lines),
        ("test declarations", v1.test_declarations, v2.test_declarations),
        (
            "test declarations per 1,000 source lines",
            f"{v1.test_declarations_per_1000_source_lines:.2f}",
            f"{v2.test_declarations_per_1000_source_lines:.2f}",
        ),
        (
            "test/source line ratio",
            f"{v1.test_lines_per_source_line:.2%}",
            f"{v2.test_lines_per_source_line:.2%}",
        ),
        ("route declarations", v1.route_declarations, v2.route_declarations),
        ("model/row declarations", v1.model_declarations, v2.model_declarations),
        ("table declarations", v1.table_declarations, v2.table_declarations),
        ("migration files", v1.migration_files, v2.migration_files),
        ("migration lines", v1.migration_lines, v2.migration_lines),
    )
    lines.extend(_metric_row(*row).rstrip("\n") for row in rows)
    lines.extend([
        "",
        "## Area breakdown",
        "",
        "| Era / area | Source files | Source lines | Test files | Test lines | "
        "Test declarations |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ])
    lines.extend(
        f"| {era} / `{area.name}` | {area.source_files} | {area.source_lines} | "
        f"{area.test_files} | {area.test_lines} | {area.test_declarations} |"
        for era, metrics in (("v1", v1), ("v2", v2))
        for area in metrics.areas
    )
    lines.extend([
        "",
        "## Route method shape",
        "",
        "| Era | Method family | Count |",
        "| --- | --- | ---: |",
    ])
    lines.extend(
        f"| {era} | `{method}` | {count} |"
        for era, metrics in (("v1", v1), ("v2", v2))
        for method, count in metrics.route_by_method
    )
    lines.extend([
        "",
        "## Largest production files",
        "",
        "| Era | Path | Lines |",
        "| --- | --- | ---: |",
    ])
    lines.extend(
        f"| {era} | `{entry.path}` | {entry.lines} |"
        for era, metrics in (("v1", v1), ("v2", v2))
        for entry in metrics.largest_files[:5]
    )
    return "\n".join(lines) + "\n"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    report = analyze_repository(args.root.resolve())
    rendered = render_json(report) if args.format == "json" else render_markdown(report)
    if args.output is None:
        print(rendered, end="")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
