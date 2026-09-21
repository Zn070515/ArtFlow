"""Prepare a bounded, non-production M2-D2 result-release rehearsal fixture."""

from __future__ import annotations

import hashlib
import json
import os
from argparse import ArgumentParser
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

from accounts.models import User
from accounts.services import mark_admin_verified
from core.models import Activity
from django.conf import settings
from django.contrib.sessions.backends.db import SessionStore
from django.core.management.base import BaseCommand, CommandError
from django.middleware.csrf import _get_new_csrf_string
from django.utils import timezone
from public_portal.models import PublicMedia, PublicPost
from ruleset.models import ContestRuleset, RulesetVersion
from singer_contest.models import StageResult
from singer_contest.services import _current_input_fingerprint

from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, RULESET_FREEZE, authority_write


class Command(BaseCommand):
    help = "Prepare a private development-only M2-D2 result release rehearsal fixture."

    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument("--output-file", required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        if settings.APP_ENV == "production":
            raise CommandError("Result release rehearsal fixtures are disabled in production.")

        output_path = Path(options["output_file"]).expanduser()
        if output_path.exists():
            raise CommandError(f"Refusing to overwrite fixture file: {output_path}")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        operator = self._create_operator()
        fixture = self._create_fixture(operator, output_path)
        fixture["session_cookie"], fixture["csrf_token"] = self._create_session(operator)
        output_path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            os.chmod(output_path, 0o600)
        except OSError:
            pass
        self.stdout.write(self.style.SUCCESS("Result release rehearsal fixture prepared."))

    @staticmethod
    def _create_operator() -> User:
        suffix = uuid4().hex
        operator = User(
            username=f"m2-d2-release-{suffix}",
            role=User.Role.ADMIN,
            is_staff=True,
            is_superuser=True,
        )
        operator.set_unusable_password()
        with authority_write(ACCOUNT_AUTHORITY):
            operator.save()  # type: ignore[no-untyped-call]
        return operator

    @classmethod
    def _create_fixture(cls, operator: User, output_path: Path) -> dict[str, Any]:
        suffix = uuid4().hex[:12]
        activity = cls._create_activity(f"M2-D2 release activity {suffix}")
        foreign_activity = cls._create_activity(f"M2-D2 foreign activity {suffix}")
        version = cls._create_version(activity, operator, suffix)
        foreign_version = cls._create_version(foreign_activity, operator, f"foreign-{suffix}")
        stage = cls._create_stage(activity, version, operator)
        foreign_stage = cls._create_stage(foreign_activity, foreign_version, operator)
        post = PublicPost.objects.create(
            title=f"M2-D2 result {suffix}",
            post_type=PublicPost.PostType.RESULT_PUBLICATION,
            status=PublicPost.Status.PUBLISHED,
            related_activity=activity,
            created_by=operator,
            updated_by=operator,
            published_at=timezone.now(),
        )
        media_path = f"public/gallery/m2-d2-{suffix}.jpg"
        media_file = Path(settings.MEDIA_ROOT) / media_path
        media_file.parent.mkdir(parents=True, exist_ok=True)
        media_file.write_bytes(b"M2-D2 rehearsal media")
        PublicMedia.objects.create(
            post=post,
            related_activity=activity,
            image=media_path,
            caption=f"M2-D2 rehearsal media {suffix}",
        )
        return {
            "operator_id": operator.pk,
            "operator_username": operator.username,
            "activity_id": activity.pk,
            "activity_title": activity.title,
            "foreign_activity_id": foreign_activity.pk,
            "foreign_activity_title": foreign_activity.title,
            "ruleset_id": version.ruleset_id,
            "ruleset_name": version.ruleset.name,
            "ruleset_version_id": version.pk,
            "foreign_ruleset_id": foreign_version.ruleset_id,
            "foreign_ruleset_name": foreign_version.ruleset.name,
            "foreign_ruleset_version_id": foreign_version.pk,
            "stage_id": stage.pk,
            "foreign_stage_id": foreign_stage.pk,
            "post_id": post.pk,
            "public_title": post.title,
            "media_path": media_path,
            "media_file_path": str(media_file),
            "container_fixture_path": str(output_path),
            "confirm_path": f"/staff/stage-results/{stage.pk}/confirm/",
            "release_path": f"/staff/posts/{post.pk}/result-release/",
            "revoke_path": f"/staff/posts/{post.pk}/result-release/revoke/",
            "edit_path": f"/staff/posts/{post.pk}/edit/",
            "unlock_path": f"/staff/stage-results/{stage.pk}/unlock/",
            "public_post_path": f"/post/{post.pk}/",
            "public_results_path": "/results/",
            "media_url_path": f"/media/{media_path}",
            "cleanup_activity_ids": [activity.pk, foreign_activity.pk],
        }

    @staticmethod
    def _create_activity(title: str) -> Activity:
        with authority_write(ACTIVITY_STATE):
            return Activity.objects.create(
                title=title,
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.RESULTS_PENDING,
                is_test_mode=False,
            )

    @staticmethod
    def _create_version(activity: Activity, operator: User, label: str) -> RulesetVersion:
        definition = json.dumps(
            {
                "schema_version": 1,
                "nodes": [{"key": "result", "type": "ROSTER"}],
            },
            sort_keys=True,
        )
        ruleset = ContestRuleset.objects.create(
            activity=activity,
            name=f"M2-D2 rehearsal ruleset {label}",
            stage_key="final",
            created_by=operator,
        )
        with authority_write(RULESET_FREEZE):
            return cast(
                RulesetVersion,
                RulesetVersion.objects.create(  # type: ignore[no-untyped-call]
                    ruleset=ruleset,
                    definition=definition,
                    binding={"stage_key": "final"},
                    authority_hash=hashlib.sha256(definition.encode()).hexdigest(),
                    status=RulesetVersion.Status.FROZEN,
                    is_current=True,
                    created_by=operator,
                    frozen_by=operator,
                ),
            )

    @staticmethod
    def _create_stage(activity: Activity, version: RulesetVersion, operator: User) -> StageResult:
        return cast(
            StageResult,
            StageResult.objects.create(  # type: ignore[no-untyped-call]
                activity=activity,
                ruleset_version=version,
                created_by=operator,
                stage_key="final",
                status=StageResult.Status.READY_TO_CONFIRM,
                ruleset_hash=version.authority_hash,
                input_fingerprint=_current_input_fingerprint(version, activity, "final"),
                result_version=1,
                is_test_data=False,
            ),
        )

    @staticmethod
    def _create_session(operator: User) -> tuple[str, str]:
        session = SessionStore()
        session["_auth_user_id"] = str(operator.pk)
        session["_auth_user_backend"] = "django.contrib.auth.backends.ModelBackend"
        session["_auth_user_hash"] = operator.get_session_auth_hash()
        mark_admin_verified(session)
        session.save()
        csrf_secret = _get_new_csrf_string()
        session_cookie = (
            f"{settings.SESSION_COOKIE_NAME}={session.session_key}; "
            f"{settings.CSRF_COOKIE_NAME}={csrf_secret}"
        )
        return session_cookie, csrf_secret
