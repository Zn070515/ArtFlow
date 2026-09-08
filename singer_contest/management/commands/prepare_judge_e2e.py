from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import uuid4

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, CONTEST_ROUND_STATE, authority_write
from core.models import Activity
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from singer_contest.judge_authority import (
    advance_performance,
    issue_judge_grant,
    prepare_judge_panel,
)
from singer_contest.models import ContestRound, Judge, SingerRegistration
from singer_contest.services import prepare_round, set_round_groups


class Command(BaseCommand):
    help = "Create an isolated non-production Judge browser fixture without printing its grant."

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--output-file",
            required=True,
            help="Write the short-lived grant fixture JSON to this private temporary file.",
        )

    def handle(self, *args, **options) -> None:
        if settings.APP_ENV == "production":
            raise CommandError("Judge browser fixtures are disabled in production.")

        output_path = Path(options["output_file"]).expanduser()
        if output_path.exists():
            raise CommandError(f"Refusing to overwrite fixture file: {output_path}")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with transaction.atomic():
            operator = self._create_operator()
            activity = self._create_activity()
            singer_user = self._create_participant()
            singer = SingerRegistration.objects.create(
                activity=activity,
                user=singer_user,
                name="Judge browser fixture singer",
                student_id=f"E2E{uuid4().hex[:12].upper()}",
                college="Test College",
                class_name="Test Class",
                phone="13800000000",
                song_name="Judge browser fixture song",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            )
            Judge.objects.create(
                activity=activity,
                name="Judge browser fixture judge",
                is_active=True,
            )
            with authority_write(CONTEST_ROUND_STATE):
                contest_round = ContestRound.objects.create(
                    activity=activity,
                    round_type=ContestRound.RoundType.PRELIMINARY,
                    name="Judge browser fixture round",
                    minimum_judge_count=1,
                    status=ContestRound.Status.DRAFT,
                    is_locked=False,
                )
            set_round_groups(
                contest_round,
                [{"name": "Judge browser fixture group", "singer_ids": [singer.pk]}],
                operator,
            )
            prepare_round(contest_round, operator)
            snapshot = prepare_judge_panel(contest_round.pk, operator=operator)
            performance = contest_round.performances.get()
            advance_performance(contest_round.pk, performance.pk, operator=operator)
            seat = snapshot.members.get(seat_key="seat-1").seats.get()
            issued = issue_judge_grant(seat.pk, operator=operator, ttl_seconds=10 * 60)

        output_path.write_text(
            json.dumps(
                {
                    "grant_token": issued.token,
                    "activity_id": activity.pk,
                    "round_id": contest_round.pk,
                    "performance_id": performance.pk,
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
        self.stdout.write(self.style.SUCCESS("Judge browser fixture prepared."))

    @staticmethod
    def _create_operator() -> User:
        with authority_write(ACCOUNT_AUTHORITY):
            operator = User(
                username=f"judge-e2e-operator-{uuid4().hex}",
                role=User.Role.ADMIN,
                is_staff=True,
                is_superuser=True,
            )
            operator.set_unusable_password()
            operator.save()
        return operator

    @staticmethod
    def _create_participant() -> User:
        with authority_write(ACCOUNT_AUTHORITY):
            participant = User(
                username=f"judge-e2e-participant-{uuid4().hex}",
                role=User.Role.PARTICIPANT,
            )
            participant.set_unusable_password()
            participant.save()
        return participant

    @staticmethod
    def _create_activity() -> Activity:
        # Activity state is deliberately test-only and cannot be promoted by this fixture.
        with authority_write(ACTIVITY_STATE):
            return Activity.objects.create(
                title="Judge browser fixture activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.TESTING,
                is_test_mode=True,
            )
