from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from common.private_test_fixture import PrivateFixtureError, PrivateTestFixture
from common.private_test_loader import PrivateTestLoadError, apply_private_fixture


class Command(BaseCommand):
    help = "Validate or load the isolated ArtFlow private-test fixture."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--root", type=Path, required=True)
        parser.add_argument("--activity-key")
        parser.add_argument("--operator-username")
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--apply", action="store_true")
        parser.add_argument("--reset-test-runtime", action="store_true")
        parser.add_argument("--json-report", type=Path)

    def handle(self, *args: Any, **options: Any) -> None:
        if options["dry_run"] == options["apply"]:
            raise CommandError("must choose exactly one of --dry-run or --apply")
        try:
            fixture = PrivateTestFixture.from_root(options["root"])
        except PrivateFixtureError as error:
            raise CommandError(str(error)) from error
        if options["apply"]:
            if not options.get("activity_key") or not options.get("operator_username"):
                raise CommandError("--apply requires --activity-key and --operator-username")
            try:
                loaded = apply_private_fixture(
                    fixture,
                    activity_key=options["activity_key"],
                    operator_username=options["operator_username"],
                    reset_test_runtime=options["reset_test_runtime"],
                )
            except (PrivateTestLoadError, PrivateFixtureError, ValidationError) as error:
                raise CommandError(str(error)) from error
            report = loaded.report
        else:
            if options.get("reset_test_runtime"):
                raise CommandError("--reset-test-runtime is only valid with --apply")
            report = fixture.dry_run_report()
        serialized = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
        self.stdout.write(serialized)
        report_path = options.get("json_report")
        if report_path:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(serialized + "\n", encoding="utf-8")
