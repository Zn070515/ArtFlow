"""Prepare a bounded, non-production media-download load rehearsal fixture.

``controlled_media`` authorizes a private path and then streams the bytes through the
Gunicorn worker that is handling the request — there is no separate file service, and
``deploy/Caddyfile`` does not take the bytes off the worker either. That is why the
production doc requires a load rehearsal before the first live event: with a small sync
worker pool, concurrent large downloads are a capacity failure mode, not a code defect.

This command creates exactly what that rehearsal needs and nothing else:

* one TEST singer-contest activity holding a single registration,
* one submission file of the requested size, owned by that registration's user,
* a session cookie for the owner, so the download takes the real ``owner``
  authorization branch rather than an unauthenticated rejection.

The payload is written as a sparse file. The rehearsal measures worker occupancy under
client back-pressure, not disk throughput, and a sparse payload keeps the fixture cheap
to create. Everything here is disposable and named for the rehearsal;
``cleanup_media_download_rehearsal`` removes exactly these rows and their media.
"""

from __future__ import annotations

import json
import os
from argparse import ArgumentParser
from pathlib import Path
from typing import Any
from uuid import uuid4

from accounts.models import User
from core.models import Activity
from django.conf import settings
from django.contrib.sessions.backends.db import SessionStore
from django.core.management.base import BaseCommand, CommandError
from files.models import SubmissionFile
from singer_contest.models import SingerRegistration

from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write

# The largest payload a FORMAL activity accepts today is the performance video, capped by
# ARTFLOW_VIDEO_UPLOAD_MAX_MB (100 by default) through ``video_upload_cap_bytes``. The
# rehearsal is specified as "最大文件尺寸", so that is the default.
DEFAULT_SIZE_MB = 100
MAX_SIZE_MB = 1024
# ``submissions/%Y/%m/`` is the model's upload_to; this rehearsal writes below its own
# directory so cleanup can name the exact file it created.
REHEARSAL_MEDIA_DIRECTORY = "submissions/rehearsal"


class Command(BaseCommand):
    help = "Prepare a private development-only media download load rehearsal fixture."

    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument("--output-file", required=True)
        parser.add_argument(
            "--size-mb",
            type=int,
            default=DEFAULT_SIZE_MB,
            help=f"Payload size in MiB (default {DEFAULT_SIZE_MB}, the formal video cap).",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        if settings.APP_ENV == "production":
            raise CommandError("Media download rehearsal fixtures are disabled in production.")
        size_mb = int(options["size_mb"])
        if size_mb <= 0 or size_mb > MAX_SIZE_MB:
            raise CommandError(f"--size-mb must be between 1 and {MAX_SIZE_MB}.")

        output_path = Path(options["output_file"]).expanduser()
        if output_path.exists():
            raise CommandError(f"Refusing to overwrite fixture file: {output_path}")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        suffix = uuid4().hex[:12]
        with authority_write(ACCOUNT_AUTHORITY):
            owner = User(username=f"media-load-owner-{suffix}", role=User.Role.PARTICIPANT)
            owner.set_unusable_password()
            owner.save()  # type: ignore[no-untyped-call]
        with authority_write(ACTIVITY_STATE):
            activity = Activity.objects.create(
                title=f"Media download rehearsal {suffix}",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.LIVE,
                is_test_mode=True,
            )
        registration = SingerRegistration.objects.create(
            activity=activity,
            user=owner,
            name=f"Media load owner {suffix}",
            student_id=f"LOAD{suffix[:6].upper()}",
            college="Test College",
            class_name="Test Class",
            phone="13800000000",
            song_name="Media download rehearsal",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )

        media_path = f"{REHEARSAL_MEDIA_DIRECTORY}/load-{suffix}.bin"
        media_file = Path(settings.MEDIA_ROOT) / media_path
        media_file.parent.mkdir(parents=True, exist_ok=True)
        with open(media_file, "wb") as handle:
            handle.truncate(size_mb * 1024 * 1024)
        size_bytes = size_mb * 1024 * 1024

        submission_file = SubmissionFile.objects.create(
            singer_registration=registration,
            file=media_path,
            original_name=f"load-{suffix}.bin",
            file_size=size_bytes,
            file_purpose=SubmissionFile.Purpose.PERFORMANCE_VIDEO,
            is_test_data=True,
        )

        session = SessionStore()
        session["_auth_user_id"] = str(owner.pk)
        session["_auth_user_backend"] = "django.contrib.auth.backends.ModelBackend"
        session["_auth_user_hash"] = owner.get_session_auth_hash()
        session.save()

        fixture = {
            "owner_id": owner.pk,
            "owner_username": owner.username,
            "activity_id": activity.pk,
            "activity_title": activity.title,
            "registration_id": registration.pk,
            "submission_file_id": submission_file.pk,
            "media_path": media_path,
            "media_url_path": f"/media/{media_path}",
            "media_file_path": str(media_file),
            "size_bytes": size_bytes,
            "session_key": session.session_key,
            "session_cookie": f"{settings.SESSION_COOKIE_NAME}={session.session_key}",
            "container_fixture_path": str(output_path),
            "cleanup_activity_ids": [activity.pk],
        }
        output_path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            os.chmod(output_path, 0o600)
        except OSError:
            pass
        self.stdout.write(self.style.SUCCESS("Media download rehearsal fixture prepared."))
