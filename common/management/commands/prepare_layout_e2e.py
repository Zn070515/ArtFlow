"""Prepare the browser fixture the mobile layout audit runs against.

The audit needs pages that actually render with data: an empty list still shows its
header and filters, but the wide table that overflows on a phone only exists once there
are rows. It also needs a staff session, because the pages that break worst are the
staff ones — and local development has no ``STAFF_ACCESS_KEY`` configured, so the
command mints the session directly rather than pretending the login form is usable.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from datetime import timedelta
from typing import Any
from uuid import uuid4

from accounts.models import User
from core.models import Activity
from django.conf import settings
from django.contrib.auth import BACKEND_SESSION_KEY, HASH_SESSION_KEY, SESSION_KEY
from django.contrib.sessions.backends.db import SessionStore
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from singer_contest.models import ContestRound, SingerRegistration
from voting.models import VoteOption, VoteSession

from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    VOTE_SESSION_STATE,
    authority_write,
)


class Command(BaseCommand):
    help = "Create an isolated staff/activity fixture for the mobile layout audit."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--output-file",
            required=True,
            help="Write fixture metadata to this private temporary file.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        if settings.APP_ENV == "production":
            raise CommandError("Layout browser fixtures are disabled in production.")
        output_path = Path(options["output_file"]).expanduser()
        if output_path.exists():
            raise CommandError(f"Refusing to overwrite fixture file: {output_path}")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        password = f"LayoutFixture!{uuid4().hex[:12]}"
        with transaction.atomic():
            staff = self._create_staff(password)
            activity = self._create_activity()
            contest_round = self._create_round(activity)
            singers = [self._create_singer(activity, index) for index in range(3)]
            vote_session = self._create_vote_session(activity, singers)
            session_key = self._session_key(staff)

        output_path.write_text(
            json.dumps(
                {
                    "public_code": activity.public_code,
                    "activity_id": activity.pk,
                    "round_id": contest_round.pk,
                    "singer_id": singers[0].pk,
                    "vote_session_id": vote_session.pk,
                    "session_key": session_key,
                    "staff_username": staff.username,
                    "staff_password": password,
                },
                ensure_ascii=True,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        try:
            os.chmod(output_path, 0o600)
        except OSError:
            pass
        self.stdout.write(self.style.SUCCESS("Layout browser fixture prepared."))

    @staticmethod
    def _create_staff(password: str) -> User:
        # An ADMIN, not a STAFF: user administration and material review are admin-only,
        # and the point of this fixture is that every staff surface renders so its layout
        # can be measured. Role does not change the markup of the shared pages.
        with authority_write(ACCOUNT_AUTHORITY):
            staff = User(
                username=f"layout-e2e-admin-{uuid4().hex}",
                role=User.Role.ADMIN,
                is_staff=True,
            )
            staff.set_password(password)
            staff.save()
        return staff

    @staticmethod
    def _session_key(staff: User) -> str:
        session = SessionStore()
        session[SESSION_KEY] = str(staff.pk)
        session[BACKEND_SESSION_KEY] = settings.AUTHENTICATION_BACKENDS[0]
        session[HASH_SESSION_KEY] = staff.get_session_auth_hash()
        session.create()
        return str(session.session_key)

    @staticmethod
    def _create_activity() -> Activity:
        with authority_write(ACTIVITY_STATE):
            return Activity.objects.create(
                title="Layout fixture activity with a deliberately long title",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.LIVE,
                is_test_mode=False,
            )

    @staticmethod
    def _create_round(activity: Activity) -> ContestRound:
        with authority_write(CONTEST_ROUND_STATE):
            return ContestRound.objects.create(
                activity=activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="Layout fixture round",
                minimum_judge_count=1,
                is_locked=False,
            )

    @staticmethod
    def _create_vote_session(
        activity: Activity, singers: list[SingerRegistration]
    ) -> VoteSession:
        """A session with options, so the detail page renders its switches and its table."""
        with authority_write(VOTE_SESSION_STATE):
            session = VoteSession.objects.create(
                activity=activity,
                name="Layout fixture vote with a deliberately long session name",
                passcode="4321",
                start_time=timezone.now() - timedelta(minutes=30),
                end_time=timezone.now() + timedelta(hours=2),
            )
        VoteOption.objects.bulk_create(
            [
                VoteOption(vote_session=session, singer=singer, sort_order=index)
                for index, singer in enumerate(singers)
            ]
        )
        return session

    @staticmethod
    def _create_singer(activity: Activity, index: int) -> SingerRegistration:
        with authority_write(ACCOUNT_AUTHORITY):
            user = User(
                username=f"layout-e2e-singer-{index}-{uuid4().hex[:8]}",
                role=User.Role.PARTICIPANT,
            )
            user.set_unusable_password()
            user.save()
        return SingerRegistration.objects.create(
            activity=activity,
            user=user,
            name=f"布局审计选手 {index + 1}",
            student_id=f"LAY{index:04d}",
            college="Test College",
            class_name="Test Class",
            phone="13800000000",
            song_name=f"审计曲目 {index + 1}（一个偏长的曲目名）",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
