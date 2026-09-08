from datetime import timedelta
from io import StringIO
from tempfile import TemporaryDirectory

from accounts.models import User
from core.models import Activity
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone
from singer_contest.models import SingerRegistration
from tickets.models import Ticket, TicketAccessSession
from tickets.services import check_in_ticket, create_ticket, issue_ticket, redeem_ticket
from voting.models import VoteOption, VoteSession
from voting.services import open_vote_session, submit_ballot

from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    TICKET_SESSION_STATE,
    authority_write,
)
from common.management.commands.backup_artflow import collect_counts
from common.models import AuditLog
from common.test_data import clear_activity_test_data, get_test_data_counts


class TicketTestDataCleanupTests(TestCase):
    def setUp(self) -> None:
        self.staff = User.objects.create_user(username="cleanup-ticket-staff", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff.role = User.Role.STAFF
            self.staff.save(update_fields=["role", "is_staff"])
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Ticket cleanup test activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_CLOSED,
                is_test_mode=True,
            )
            self.formal_activity = Activity.objects.create(
                title="Ticket cleanup formal activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_CLOSED,
                is_test_mode=False,
            )
        voter = User.objects.create_user(username="cleanup-ticket-voter", password="pass")
        singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=voter,
            name="Cleanup Singer",
            student_id="20269931",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        vote_session = VoteSession.objects.create(
            activity=self.activity,
            name="Cleanup Ticket Vote",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            requires_ticket=True,
            is_test_data=True,
        )
        option = VoteOption.objects.create(
            vote_session=vote_session,
            singer=singer,
            is_test_data=True,
        )
        self.vote_session = open_vote_session(vote_session, self.staff)  # type: ignore[no-untyped-call]
        self.test_ticket = create_ticket(
            self.activity,
            actor=self.staff,
            serial_number="cleanup-test-001",
        )
        issued = issue_ticket(self.test_ticket, actor=self.staff)
        check_in_ticket(issued.secret, actor=self.staff)
        redeemed = redeem_ticket(issued.secret)
        submit_ballot(
            self.vote_session,
            browser_session_key="cleanup-ticket-browser",
            option_ids=[option.pk],
            ip_address="10.0.0.31",
            ticket_session=redeemed.session,
        )
        self.test_secret = issued.secret
        self.formal_ticket = create_ticket(
            self.formal_activity,
            actor=self.staff,
            serial_number="cleanup-formal-001",
        )

    def test_cleanup_removes_test_ticket_sessions_before_ticket_and_retains_formal_ticket(
        self,
    ) -> None:
        counts = get_test_data_counts(self.activity)
        self.assertEqual(counts["tickets"], 1)
        self.assertEqual(counts["ticket_sessions"], 1)
        self.assertEqual(counts["vote_ballots"], 1)

        clear_activity_test_data(self.activity, operator=self.staff)

        self.assertFalse(Ticket.objects.filter(pk=self.test_ticket.pk).exists())
        self.assertFalse(TicketAccessSession.objects.filter(ticket_id=self.test_ticket.pk).exists())
        self.assertTrue(
            Ticket.objects.filter(pk=self.formal_ticket.pk, activity=self.formal_activity).exists()
        )
        for values in AuditLog.objects.values_list("target", "old_value", "new_value", "note"):
            self.assertNotIn(self.test_secret, " ".join(value or "" for value in values))

    def test_doctor_and_retention_report_or_remove_only_non_secret_session_metadata(self) -> None:
        redeemed = redeem_ticket(self.test_secret)
        redeemed.session.expires_at = timezone.now() - timedelta(minutes=1)
        with authority_write(TICKET_SESSION_STATE):
            redeemed.session.save(update_fields=["expires_at"])

        with TemporaryDirectory() as root, override_settings(STATIC_ROOT=root, MEDIA_ROOT=root):
            output = StringIO()
            call_command("doctor", stdout=output)

        self.assertIn("Ticket rows:", output.getvalue())
        self.assertIn("Stale ticket sessions: 1", output.getvalue())
        self.assertNotIn(self.test_secret, output.getvalue())

        output = StringIO()
        call_command("purge_ticket_sessions", stdout=output)
        self.assertIn("Expired ticket sessions purged: 1", output.getvalue())
        self.assertTrue(Ticket.objects.filter(pk=self.test_ticket.pk).exists())
        self.assertFalse(TicketAccessSession.objects.filter(pk=redeemed.session.pk).exists())

    def test_backup_counts_classify_ticket_rows_without_credentials(self) -> None:
        counts = collect_counts()

        self.assertIn("tickets", counts)
        self.assertIn("ticket_access_sessions", counts)
        self.assertNotIn("secret", str(counts).lower())
        self.assertNotIn(self.test_secret, str(counts))


class TicketSeedTests(TestCase):
    def test_demo_seed_is_idempotent_and_ticket_is_owned_test_data(self) -> None:
        call_command("seed_demo_data")
        call_command("seed_demo_data")

        tickets = Ticket.objects.filter(batch_reference="DEMO-AUDIENCE")
        self.assertEqual(tickets.count(), 1)
        ticket = tickets.get()
        self.assertTrue(ticket.is_test_data)
        self.assertEqual(ticket.state, Ticket.State.ISSUED)

        output = StringIO()
        call_command("seed_demo_data", "--reset", stdout=output)
        self.assertIn("Demo test runtime data reset", output.getvalue())
        self.assertFalse(Ticket.objects.filter(pk=ticket.pk).exists())
