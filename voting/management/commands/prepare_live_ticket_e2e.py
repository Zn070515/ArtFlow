from __future__ import annotations

import json
import os
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from core.models import Activity
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from singer_contest.models import SingerRegistration
from tickets.services import create_ticket, issue_ticket, ticket_credential

from voting.models import VoteOption, VoteSession


class Command(BaseCommand):
    help = "Create a formal isolated Live/Ticket browser fixture."

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--output-file",
            required=True,
            help="Write fixture metadata to this private temporary file.",
        )

    def handle(self, *args, **options) -> None:
        if settings.APP_ENV == "production":
            raise CommandError("Live/Ticket browser fixtures are disabled in production.")
        output_path = Path(options["output_file"]).expanduser()
        if output_path.exists():
            raise CommandError(f"Refusing to overwrite fixture file: {output_path}")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        password = f"LiveTicketFixture!{uuid4().hex[:12]}"
        with transaction.atomic():
            operator = self._create_operator(password)
            activity = self._create_activity()
            singer_user = self._create_participant()
            singer = SingerRegistration.objects.create(
                activity=activity,
                user=singer_user,
                name="Live ticket fixture singer",
                student_id=f"LIVE{uuid4().hex[:12].upper()}",
                college="Test College",
                class_name="Test Class",
                phone="13800000000",
                song_name="Live ticket fixture song",
                pre_status=SingerRegistration.PreStatus.APPROVED,
            )
            now = timezone.now()
            vote_session = VoteSession.objects.create(
                activity=activity,
                name="Live ticket fixture vote",
                start_time=now - timedelta(minutes=1),
                end_time=now + timedelta(hours=1),
                purpose=VoteSession.Purpose.POPULARITY,
                requires_ticket=True,
            )
            VoteOption.objects.create(vote_session=vote_session, singer=singer)
            ticket = create_ticket(
                activity,
                actor=operator,
                batch_reference="live-ticket-e2e",
                serial_number="LIVE-001",
            )
            issued = issue_ticket(ticket, actor=operator)

        output_path.write_text(
            json.dumps(
                {
                    "public_code": activity.public_code,
                    "vote_session_id": vote_session.pk,
                    "credential": ticket_credential(issued.ticket),
                    "staff_username": operator.username,
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
        self.stdout.write(self.style.SUCCESS("Live/Ticket browser fixture prepared."))

    @staticmethod
    def _create_operator(password: str) -> User:
        with authority_write(ACCOUNT_AUTHORITY):
            operator = User(
                username=f"live-ticket-e2e-operator-{uuid4().hex}",
                role=User.Role.STAFF,
                is_staff=True,
            )
            operator.set_password(password)
            operator.save()
        return operator

    @staticmethod
    def _create_participant() -> User:
        with authority_write(ACCOUNT_AUTHORITY):
            participant = User(
                username=f"live-ticket-e2e-participant-{uuid4().hex}",
                role=User.Role.PARTICIPANT,
            )
            participant.set_unusable_password()
            participant.save()
        return participant

    @staticmethod
    def _create_activity() -> Activity:
        with authority_write(ACTIVITY_STATE):
            return Activity.objects.create(
                title="Live ticket fixture activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.LIVE,
                is_test_mode=False,
            )
