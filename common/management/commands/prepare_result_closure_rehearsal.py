"""Prepare an isolated, non-production result-closure HTTP rehearsal fixture."""

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
from ruleset.models import ContestRuleset, RulesetVersion
from singer_contest.models import SingerRegistration, StageAwardDecision, StageResult
from singer_contest.services import _current_input_fingerprint, confirm_stage_result

from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, RULESET_FREEZE, authority_write


class Command(BaseCommand):
    help = "Prepare a private development-only M2-D1 result closure rehearsal fixture."

    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument("--output-file", required=True)

    def handle(self, *args: Any, **options: Any) -> None:
        if settings.APP_ENV == "production":
            raise CommandError("Result closure rehearsal fixtures are disabled in production.")

        output_path = Path(options["output_file"]).expanduser()
        if output_path.exists():
            raise CommandError(f"Refusing to overwrite fixture file: {output_path}")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        operator = self._create_operator()
        (
            activity,
            foreign_activity,
            current_stage,
            stale_stage,
            current_marker,
            foreign_marker,
        ) = self._create_fixture(operator)
        session_cookie, csrf_token = self._create_session(operator)
        fixture = {
            "activity_id": activity.pk,
            "foreign_activity_id": foreign_activity.pk,
            "stage_id": current_stage.pk,
            "stale_stage_id": stale_stage.pk,
            "current_award_marker": current_marker,
            "foreign_award_marker": foreign_marker,
            "session_cookie": session_cookie,
            "csrf_token": csrf_token,
            "container_fixture_path": str(output_path),
            "confirm_path": f"/staff/stage-results/{current_stage.pk}/confirm/",
            "stale_confirm_path": f"/staff/stage-results/{stale_stage.pk}/confirm/",
            "unlock_path": f"/staff/stage-results/{current_stage.pk}/unlock/",
            "archive_path": f"/staff/archive-package/{activity.pk}/",
        }
        output_path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            os.chmod(output_path, 0o600)
        except OSError:
            pass
        self.stdout.write(self.style.SUCCESS("Result closure rehearsal fixture prepared."))

    @staticmethod
    def _create_operator() -> User:
        suffix = uuid4().hex
        operator = User(
            username=f"m2-d1-closure-{suffix}",
            role=User.Role.ADMIN,
            is_staff=True,
            is_superuser=True,
        )
        operator.set_unusable_password()
        with authority_write(ACCOUNT_AUTHORITY):
            operator.save()  # type: ignore[no-untyped-call]
        return operator

    @classmethod
    def _create_fixture(
        cls, operator: User
    ) -> tuple[Activity, Activity, StageResult, StageResult, str, str]:
        suffix = uuid4().hex[:12]
        current_marker = f"M2-D1-CURRENT-AWARD-{suffix}"
        foreign_marker = f"M2-D1-FOREIGN-AWARD-{suffix}"
        activity = cls._create_activity(f"M2-D1 closure activity {suffix}")
        foreign_activity = cls._create_activity(f"M2-D1 foreign activity {suffix}")
        current_singer = cls._create_singer(activity, f"Current singer {suffix}")
        foreign_singer = cls._create_singer(foreign_activity, f"Foreign singer {suffix}")
        current_version = cls._create_version(activity, operator, f"current-{suffix}")
        foreign_version = cls._create_version(foreign_activity, operator, f"foreign-{suffix}")
        current_stage = cls._create_ready_stage(
            activity, current_version, current_singer, operator, "current-stage", current_marker
        )
        stale_stage = cast(
            StageResult,
            StageResult.objects.create(  # type: ignore[no-untyped-call]
                activity=activity,
                ruleset_version=current_version,
                created_by=operator,
                stage_key="stale-stage",
                status=StageResult.Status.READY_TO_CONFIRM,
                ruleset_hash=current_version.authority_hash,
                input_fingerprint="0" * 64,
                result_version=1,
                is_test_data=True,
            ),
        )
        foreign_stage = cls._create_ready_stage(
            foreign_activity,
            foreign_version,
            foreign_singer,
            operator,
            "foreign-stage",
            foreign_marker,
        )
        confirm_stage_result(foreign_stage, confirmed_by=operator)
        return (
            activity,
            foreign_activity,
            current_stage,
            stale_stage,
            current_marker,
            foreign_marker,
        )

    @staticmethod
    def _create_activity(title: str) -> Activity:
        with authority_write(ACTIVITY_STATE):
            return Activity.objects.create(
                title=title,
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.RESULTS_PENDING,
                is_test_mode=True,
            )

    @staticmethod
    def _create_singer(activity: Activity, name: str) -> SingerRegistration:
        user = User.objects.create_user(
            username=f"{name.lower().replace(' ', '-')}-{uuid4().hex}",
            password=None,
        )
        return cast(
            SingerRegistration,
            SingerRegistration.objects.create(
                activity=activity,
                user=user,
                name=name,
                student_id=f"M2D1{uuid4().hex[:10].upper()}",
                college="Rehearsal College",
                class_name="Rehearsal Class",
                song_name="Rehearsal Song",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            ),
        )

    @staticmethod
    def _create_version(activity: Activity, operator: User, label: str) -> RulesetVersion:
        definition = json.dumps(
            {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
            sort_keys=True,
        )
        ruleset = ContestRuleset.objects.create(
            activity=activity,
            name=f"M2-D1 rehearsal ruleset {label}",
            is_test_data=True,
        )
        with authority_write(RULESET_FREEZE):
            return cast(
                RulesetVersion,
                RulesetVersion.objects.create(  # type: ignore[no-untyped-call]
                    ruleset=ruleset,
                    definition=definition,
                    authority_hash=hashlib.sha256(definition.encode()).hexdigest(),
                    status=RulesetVersion.Status.FROZEN,
                    is_current=True,
                    created_by=operator,
                    frozen_by=operator,
                ),
            )

    @staticmethod
    def _create_ready_stage(
        activity: Activity,
        version: RulesetVersion,
        singer: SingerRegistration,
        operator: User,
        stage_key: str,
        award_name: str,
    ) -> StageResult:
        stage = cast(
            StageResult,
            StageResult.objects.create(  # type: ignore[no-untyped-call]
                activity=activity,
                ruleset_version=version,
                created_by=operator,
                stage_key=stage_key,
                status=StageResult.Status.READY_TO_CONFIRM,
                ruleset_hash=version.authority_hash,
                input_fingerprint=_current_input_fingerprint(version, activity, stage_key),
                result_version=1,
                is_test_data=True,
            ),
        )
        StageAwardDecision.objects.create(
            stage_result=stage,
            activity=activity,
            singer=singer,
            name=award_name,
            is_test_data=True,
        )
        return stage

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
