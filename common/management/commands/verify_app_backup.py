from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from .backup_artflow import EXCLUDED_FILE_FIELDS, collect_counts, file_fields, media_content_digest


def validate_counts(manifest: dict[str, Any], counts: dict[str, int]) -> list[str]:
    problems: list[str] = []
    expected = manifest.get("counts") or {}
    for label, actual in counts.items():
        wanted = expected.get(label)
        if wanted != actual:
            problems.append(f"{label}: expected {wanted}, restored {actual}")
    return problems


def verify_media_files() -> tuple[list[str], dict[str, str]]:
    """Check that every file the restored database references exists and is readable.

    The media tree's own digest proves the tree matches the backup; it says nothing about
    whether the backup ever contained what the rows name. A row pointing at a file that
    was already missing on the source host digests identically on both sides, so the
    per-field walk is what turns "the archive is self-consistent" into "the archive is
    complete".
    """
    problems: list[str] = []
    verified: dict[str, str] = {}
    excluded = set(EXCLUDED_FILE_FIELDS)
    for model, field_name in file_fields():
        if (model, field_name) in excluded:
            continue
        for obj in model.objects.exclude(**{field_name: ""}).iterator():
            file = getattr(obj, field_name)
            if not file:
                continue
            name = file.name
            storage = file.storage
            if not storage.exists(name):
                problems.append(f"{model.__name__} pk={obj.pk}: missing physical file {name}")
                continue
            try:
                with storage.open(name, "rb") as stream:
                    stream.read()
            except Exception as error:  # noqa: BLE001 - surface any read failure
                problems.append(f"{model.__name__} pk={obj.pk}: unreadable file {name}: {error}")
                continue
            verified[f"{model.__name__}:{obj.pk}"] = name
    return problems, verified


class Command(BaseCommand):
    help = "Verify a restored database and media tree against a backup manifest."
    requires_system_checks = []
    requires_migrations_checks = False

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--manifest", required=True, help="Path to the backup manifest.json.")

    def handle(self, *args: Any, **options: Any) -> None:
        manifest_path = Path(options["manifest"]).resolve()
        if not manifest_path.is_file():
            raise CommandError(f"Manifest not found: {manifest_path}")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        problems = validate_counts(manifest, collect_counts())
        media_root = Path(settings.MEDIA_ROOT)
        if manifest.get("media_content_sha256") != media_content_digest(media_root):
            problems.append("media content digest does not match the backup manifest")

        media_problems, verified = verify_media_files()
        problems.extend(media_problems)

        if problems:
            detail = "\n  ".join(problems)
            raise CommandError(f"App backup restore verification failed:\n  {detail}")

        self.stdout.write("App backup restore verification passed.")
        self.stdout.write(f"Media files verified: {len(verified)}")
        for label, name in sorted(verified.items()):
            self.stdout.write(f"  {label}: {name}")
