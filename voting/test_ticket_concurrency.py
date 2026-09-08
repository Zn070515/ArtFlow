import threading
from datetime import timedelta
from unittest import skipUnless

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from core.models import Activity
from django.db import connection
from django.test import TransactionTestCase
from django.utils import timezone
from singer_contest.models import SingerRegistration
from tickets.models import TicketAccessSession
from tickets.services import check_in_ticket, create_ticket, issue_ticket, redeem_ticket

from .models import VoteBallot, VoteOption, VoteSession
from .services import open_vote_session, submit_ballot


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class TicketBallotConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        self.staff = User.objects.create_user(username="ticket-race-staff", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff.role = User.Role.STAFF
            self.staff.save(update_fields=["role", "is_staff"])
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Ticket ballot race",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_CLOSED,
                is_test_mode=True,
            )
        voter = User.objects.create_user(username="ticket-race-voter", password="pass")
        singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=voter,
            name="Race Singer",
            student_id="20269911",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        vote_session = VoteSession.objects.create(
            activity=self.activity,
            name="Race Vote",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            requires_ticket=True,
            is_test_data=True,
        )
        self.option = VoteOption.objects.create(
            vote_session=vote_session,
            singer=singer,
            is_test_data=True,
        )
        self.vote_session = open_vote_session(vote_session, self.staff)
        ticket = create_ticket(self.activity, actor=self.staff, serial_number="race-001")
        issued = issue_ticket(ticket, actor=self.staff)
        check_in_ticket(issued.secret, actor=self.staff)
        self.redeemed = redeem_ticket(issued.secret)

    def test_simultaneous_same_ticket_submissions_create_one_ballot(self):
        barrier = threading.Barrier(2)
        results: list[object] = []
        errors: list[Exception] = []

        def submit_from_separate_connection(browser_key: str):
            try:
                session = VoteSession.objects.get(pk=self.vote_session.pk)
                ticket_session = TicketAccessSession(pk=self.redeemed.session.pk)
                barrier.wait(timeout=10)
                results.append(
                    submit_ballot(
                        session,
                        browser_session_key=browser_key,
                        option_ids=[self.option.pk],
                        ip_address="10.0.0.21",
                        ticket_session=ticket_session,
                    )
                )
            except Exception as error:  # pragma: no cover - diagnostic only
                errors.append(error)
            finally:
                connection.close()

        first = threading.Thread(target=submit_from_separate_connection, args=("race-one",))
        second = threading.Thread(target=submit_from_separate_connection, args=("race-two",))
        first.start()
        second.start()
        first.join(timeout=15)
        second.join(timeout=15)

        self.assertFalse(errors, errors)
        self.assertEqual(len(results), 2)
        self.assertEqual(VoteBallot.objects.filter(vote_session=self.vote_session).count(), 1)
