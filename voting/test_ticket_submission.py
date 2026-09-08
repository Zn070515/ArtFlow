from datetime import timedelta

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    TICKET_SESSION_STATE,
    authority_write,
)
from core.models import Activity
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone
from singer_contest.models import SingerRegistration
from tickets.models import Ticket
from tickets.services import (
    TicketRequestMeta,
    check_in_ticket,
    create_ticket,
    issue_ticket,
    redeem_ticket,
    revoke_ticket_session,
)

from .models import VoteBallot, VoteOption, VoteSession
from .services import open_vote_session, submit_ballot


class TicketVoteSubmissionTests(TestCase):
    def setUp(self):
        self.staff = User.objects.create_user(username="ticket-vote-staff", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff.role = User.Role.STAFF
            self.staff.save(update_fields=["role", "is_staff"])
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Ticket vote activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_CLOSED,
                is_test_mode=True,
            )
        self.voter = User.objects.create_user(username="ticket-voter", password="pass")
        singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.voter,
            name="Ticket Singer",
            student_id="20269901",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        self.vote_session = VoteSession.objects.create(
            activity=self.activity,
            name="Ticket Vote",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            requires_ticket=True,
            is_test_data=True,
        )
        self.option = VoteOption.objects.create(
            vote_session=self.vote_session,
            singer=singer,
            is_test_data=True,
        )
        self.vote_session = open_vote_session(self.vote_session, self.staff)

    def _ticket_session(self, *, activity=None):
        activity = activity or self.activity
        serial_number = f"{activity.pk}-{Ticket.objects.filter(activity=activity).count() + 1:03d}"
        ticket = create_ticket(activity, actor=self.staff, serial_number=serial_number)
        issued = issue_ticket(ticket, actor=self.staff)
        checked_in = check_in_ticket(
            issued.secret,
            actor=self.staff,
            request_meta=TicketRequestMeta(ip_address="10.0.0.10"),
        )
        self.assertEqual(checked_in.state, Ticket.State.CHECKED_IN)
        return issued, redeem_ticket(issued.secret)

    def test_required_vote_rejects_missing_ticket_session(self):
        with self.assertRaises(ValidationError):
            submit_ballot(
                self.vote_session,
                browser_session_key="ticket-browser-missing",
                option_ids=[self.option.pk],
                ip_address="10.0.0.11",
            )

        self.assertFalse(VoteBallot.objects.filter(vote_session=self.vote_session).exists())

    def test_checked_in_ticket_is_recorded_and_is_idempotent_by_ticket(self):
        _issued, redeemed = self._ticket_session()
        ticket_session = redeemed.session

        first = submit_ballot(
            self.vote_session,
            browser_session_key="ticket-browser-one",
            option_ids=[self.option.pk],
            ip_address="10.0.0.12",
            ticket_session=ticket_session,
        )
        second = submit_ballot(
            self.vote_session,
            browser_session_key="ticket-browser-two",
            option_ids=[self.option.pk],
            ip_address="10.0.0.13",
            ticket_session=ticket_session,
        )

        self.assertEqual(first.pk, second.pk)
        self.assertEqual(first.ticket_id, ticket_session.ticket_id)
        self.assertEqual(VoteBallot.objects.filter(vote_session=self.vote_session).count(), 1)

    def test_unchecked_ticket_cannot_cast(self):
        ticket = create_ticket(self.activity, actor=self.staff, serial_number="unchecked")
        issued = issue_ticket(ticket, actor=self.staff)
        ticket_session = redeem_ticket(issued.secret).session

        with self.assertRaises(ValidationError):
            submit_ballot(
                self.vote_session,
                browser_session_key="ticket-browser-unchecked",
                option_ids=[self.option.pk],
                ip_address="10.0.0.14",
                ticket_session=ticket_session,
            )

    def test_same_browser_cannot_switch_to_another_ticket(self):
        _issued, first_redeemed = self._ticket_session()
        _issued, second_redeemed = self._ticket_session()
        submit_ballot(
            self.vote_session,
            browser_session_key="ticket-browser-switch",
            option_ids=[self.option.pk],
            ip_address="10.0.0.17",
            ticket_session=first_redeemed.session,
        )

        with self.assertRaises(ValidationError):
            submit_ballot(
                self.vote_session,
                browser_session_key="ticket-browser-switch",
                option_ids=[self.option.pk],
                ip_address="10.0.0.18",
                ticket_session=second_redeemed.session,
            )

    def test_foreign_ticket_cannot_cast_and_revoked_session_cannot_cast(self):
        with authority_write(ACTIVITY_STATE):
            foreign_activity = Activity.objects.create(
                title="Foreign ticket vote activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_CLOSED,
                is_test_mode=True,
            )
        _issued, foreign_redeemed = self._ticket_session(activity=foreign_activity)
        foreign_session = foreign_redeemed.session

        with self.assertRaises(ValidationError):
            submit_ballot(
                self.vote_session,
                browser_session_key="ticket-browser-foreign",
                option_ids=[self.option.pk],
                ip_address="10.0.0.15",
                ticket_session=foreign_session,
            )

        _issued, revoked_redeemed = self._ticket_session()
        revoked_session = revoked_redeemed.session
        revoke_ticket_session(revoked_session, actor=self.staff)
        with self.assertRaises(ValidationError):
            submit_ballot(
                self.vote_session,
                browser_session_key="ticket-browser-revoked",
                option_ids=[self.option.pk],
                ip_address="10.0.0.16",
                ticket_session=revoked_session,
            )

        _issued, expired_redeemed = self._ticket_session()
        expired_redeemed.session.expires_at = timezone.now() - timedelta(minutes=1)
        with authority_write(TICKET_SESSION_STATE):
            expired_redeemed.session.save(update_fields=["expires_at"])
        with self.assertRaises(ValidationError):
            submit_ballot(
                self.vote_session,
                browser_session_key="ticket-browser-expired",
                option_ids=[self.option.pk],
                ip_address="10.0.0.19",
                ticket_session=expired_redeemed.session,
            )

    def test_public_vote_cast_requires_and_consumes_ticket_session_cookie(self):
        self.client.force_login(self.staff)
        self.client.post(
            reverse("voting:vote_entry", args=[self.vote_session.pk]),
            {"passcode": self.vote_session.passcode},
        )
        without_ticket = self.client.post(
            reverse("voting:vote_cast", args=[self.vote_session.pk]),
            {"selected_option": [self.option.pk]},
        )
        self.assertEqual(without_ticket.status_code, 200)
        self.assertFalse(VoteBallot.objects.filter(vote_session=self.vote_session).exists())

        _issued, redeemed = self._ticket_session()
        self.client.cookies["artflow_ticket_session"] = redeemed.token
        response = self.client.post(
            reverse("voting:vote_cast", args=[self.vote_session.pk]),
            {"selected_option": [self.option.pk]},
        )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(
            VoteBallot.objects.get(vote_session=self.vote_session).ticket_id,
            redeemed.session.ticket_id,
        )
