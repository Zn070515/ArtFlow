from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from archive.models import ArchivePackage
from core.models import Activity
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from exports.models import GeneratedDocument
from files.models import SubmissionFile
from singer_contest.models import ScoreRecord, SingerRegistration
from voting.models import VoteBallot

from common.models import AuditLog

COUNT_MODELS: dict[str, Any] = {
    "activities": Activity,
    "registrations": SingerRegistration,
    "score_records": ScoreRecord,
    "vote_ballots": VoteBallot,
    "audit_logs": AuditLog,
}

FILE_MODELS: list[tuple[type[Any], str]] = [
    (SubmissionFile, "file"),
    (GeneratedDocument, "file"),
    (ArchivePackage, "file"),
]


def collect_counts() -> dict[str, int]:
    return {label: model.objects.count() for label, model in COUNT_MODELS.items()}


def apply_migration_heads() -> tuple[str, str, int]:
    executor = MigrationExecutor(connection)
    applied = executor.recorder.applied_migrations()
    applied_labels = sorted(f"{app}.{name}" for app, name in applied)
    if not applied_labels:
        return "", "", 0
    return applied_labels[-1], ",".join(applied_labels), len(applied_labels)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def media_content_digest(media_root: Path) -> str:
    digest = hashlib.sha256()
    if not media_root.is_dir():
        return digest.hexdigest()
    for path in sorted(media_root.rglob("*")):
        if path.is_dir():
            continue
        digest.update(b"\x00")
        digest.update(path.relative_to(media_root).as_posix().encode("utf-8"))
        digest.update(b"\x00")
        digest.update(sha256_file(path).encode("ascii"))
    return digest.hexdigest()


def create_media_archive(media_root: Path, archive_path: Path, exclude: Path) -> None:
    if not media_root.is_dir():
        with tarfile.open(archive_path, "w:gz"):
            pass
        return
    resolved_root = media_root.resolve()
    resolved_exclude = exclude.resolve()
    with tarfile.open(archive_path, "w:gz") as archive:
        for path in sorted(resolved_root.rglob("*")):
            if path == resolved_exclude or resolved_exclude in path.parents:
                continue
            archive.add(path, arcname=path.relative_to(resolved_root).as_posix())


def pg_dump(database: dict[str, Any], dump_path: Path) -> None:
    engine = database.get("ENGINE", "")
    if not engine.endswith("postgresql"):
        raise CommandError("backup_artflow requires a PostgreSQL database.")
    command = ["pg_dump", "--format=custom", "--no-owner", "--file", str(dump_path)]
    host = database.get("HOST")
    port = database.get("PORT")
    user = database.get("USER")
    name = database.get("NAME")
    if host:
        command.extend(["--host", host])
    if port:
        command.extend(["--port", str(port)])
    if user:
        command.extend(["--username", user])
    if name:
        command.extend(["--dbname", name])
    environment = os.environ.copy()
    password = database.get("PASSWORD")
    if password:
        environment["PGPASSWORD"] = str(password)
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )
    except OSError as error:
        raise CommandError(f"pg_dump could not be executed: {error}") from error
    if result.returncode != 0:
        raise CommandError(f"pg_dump failed: {result.stderr.strip()}")


def write_manifest(manifest: dict[str, Any], manifest_path: Path) -> None:
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


class Command(BaseCommand):
    help = "Produce an application-level backup set (database.dump + media.tar.gz + manifest.json)."
    requires_system_checks = []
    requires_migrations_checks = False

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--output",
            default=str(Path(settings.BASE_DIR) / "backups"),
            help="Directory for the backup set; a timestamped subdirectory is created inside it.",
        )
        parser.add_argument("--git-sha", default=None, help="Commit SHA recorded in the manifest.")

    def handle(self, *args: Any, **options: Any) -> None:
        output_base = Path(options["output"]).resolve()
        output_base.mkdir(parents=True, exist_ok=True)
        backup_dir = output_base / f"backup-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}"
        backup_dir.mkdir(parents=True, exist_ok=False)

        dump_path = backup_dir / "database.dump"
        media_archive_path = backup_dir / "media.tar.gz"
        manifest_path = backup_dir / "manifest.json"
        media_root = Path(settings.MEDIA_ROOT)

        pg_dump(connection.settings_dict, dump_path)
        if not dump_path.exists() or dump_path.stat().st_size == 0:
            raise CommandError("The created database dump is missing or empty.")
        create_media_archive(media_root, media_archive_path, backup_dir)

        head, serialized_heads, applied_count = apply_migration_heads()
        manifest: dict[str, Any] = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "git_sha": options.get("git_sha") or _detect_git_sha(),
            "django_migration_head": head,
            "django_migrations_applied": serialized_heads,
            "django_migrations_applied_count": applied_count,
            "database_sha256": sha256_file(dump_path),
            "media_sha256": sha256_file(media_archive_path),
            "media_content_sha256": media_content_digest(media_root),
            "counts": collect_counts(),
        }
        write_manifest(manifest, manifest_path)
        self.stdout.write(str(backup_dir))


def _detect_git_sha() -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return result.stdout.strip()
