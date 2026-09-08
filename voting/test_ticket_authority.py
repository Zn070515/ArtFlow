from datetime import timedelta

from common.authority import RULESET_FREEZE, TICKET_STATE, authority_write
from core.models import Activity
from django.core.exceptions import ValidationError
from django.db import IntegrityError
from django.test import TestCase
from django.utils import timezone
from tickets.models import Ticket

from .models import VoteBallot, VoteSession
from .services import lock_vote_session, open_vote_session


class TicketVoteAuthorityTests(TestCase):
    def setUp(self):
        self.activity = Activity.objects.create(
            title="Ticket vote authority",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=True,
        )
        self.other_activity = Activity.objects.create(
            title="Other ticket vote authority",
            activity_type=Activity.Type.GENERAL,
            is_test_mode=True,
        )
        self.staff = self._user("ticket-vote-staff", "staff")
        self.session = VoteSession.objects.create(
            activity=self.activity,
            name="Ticket audience vote",
            passcode="ticket-pass",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_test_data=True,
        )
        self.ticket = self._ticket(self.activity, "a" * 64)
        self.other_ticket = self._ticket(self.other_activity, "b" * 64)

    def _user(self, username, role):
        from accounts.models import User

        with authority_write("account.authority"):
            return User.objects.create_user(username=username, password="pass", role=role)

    def _ticket(self, activity, digest):
        with authority_write(TICKET_STATE):
            return Ticket.objects.create(
                activity=activity,
                state=Ticket.State.CHECKED_IN,
                secret_digest=digest,
                is_test_data=True,
            )

    def test_vote_session_defaults_to_no_ticket_requirement(self):
        self.assertFalse(self.session.requires_ticket)

    def test_ticket_requirement_cannot_change_after_open_or_lock(self):
        self.session.requires_ticket = True
        self.session.save(update_fields=["requires_ticket"])
        self.session = open_vote_session(self.session, self.staff)
        self.session.requires_ticket = False
        with self.assertRaises(ValidationError):
            self.session.save(update_fields=["requires_ticket"])
        self.session = lock_vote_session(self.session, self.staff)
        with self.assertRaises(ValidationError):
            VoteSession.objects.filter(pk=self.session.pk).update(requires_ticket=False)

    def test_ticket_requirement_cannot_change_after_ruleset_binding_freeze(self):
        from ruleset.models import ContestRuleset, RulesetVersion
        from ruleset.test_schema import DEF

        ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="Frozen ticket binding",
            is_test_data=True,
        )
        with authority_write(RULESET_FREEZE):
            RulesetVersion.objects.create(
                ruleset=ruleset,
                definition=DEF,
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
                binding={"vote_keys": {"audience": self.session.pk}},
            )

        self.session.requires_ticket = True
        with self.assertRaises(ValidationError):
            self.session.save(update_fields=["requires_ticket"])

    def test_ticket_ballot_rejects_cross_activity_relation(self):
        ballot = VoteBallot(
            vote_session=self.session,
            browser_session_key="ticket-browser",
            ip_address="127.0.0.1",
            ticket=self.ticket,
            is_test_data=True,
        )
        ballot.save()

        ballot.ticket = self.other_ticket
        with self.assertRaises(ValidationError):
            ballot.save(update_fields=["ticket"])
        with self.assertRaises(ValidationError):
            VoteBallot.objects.filter(pk=ballot.pk).update(ticket=self.other_ticket)

    def test_one_ticket_has_at_most_one_ballot_per_vote_session(self):
        VoteBallot.objects.create(
            vote_session=self.session,
            browser_session_key="ticket-browser-one",
            ip_address="127.0.0.1",
            ticket=self.ticket,
            is_test_data=True,
        )

        with self.assertRaises(IntegrityError):
            VoteBallot.objects.create(
                vote_session=self.session,
                browser_session_key="ticket-browser-two",
                ip_address="127.0.0.1",
                ticket=self.ticket,
                is_test_data=True,
            )
