from datetime import timedelta

from common.authority import (
    RULESET_FREEZE,
    TICKET_STATE,
    VOTE_BALLOT_WRITE,
    authority_write,
)
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

    def test_formal_singer_contest_vote_is_forced_to_ticket_authority(self):
        formal = Activity.objects.create(
            title="Formal ticket vote authority",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
        )
        session = VoteSession.objects.create(
            activity=formal,
            name="Formal audience vote",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            requires_ticket=False,
        )
        self.assertTrue(session.requires_ticket)
        with self.assertRaises(ValidationError):
            VoteSession.objects.filter(pk=session.pk).update(requires_ticket=False)

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

    def test_a_bound_sessions_meaning_cannot_drift_after_the_freeze(self):
        """A frozen binding names the session, so what the session *means* may not change.

        `purpose` decides whether the ballots are a scored component, `selection_type` and
        `max_selections` decide what a ballot may contain. None of them were checked against
        the binding, so a staff edit after the freeze silently rewrote the authority the
        frozen ruleset had bound — with no audit trace of the change.
        """
        from ruleset.models import ContestRuleset, RulesetVersion
        from ruleset.test_schema import DEF

        ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="Frozen meaning binding",
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

        for field, value in (
            ("purpose", VoteSession.Purpose.SCORE_COMPONENT),
            ("selection_type", VoteSession.SelectionType.MULTI),
            ("max_selections", 3),
            ("requires_ticket", True),
        ):
            with self.subTest(field=field, path="instance"):
                session = VoteSession._base_manager.get(pk=self.session.pk)
                setattr(session, field, value)
                with self.assertRaises(ValidationError):
                    session.save(update_fields=[field])
            with self.subTest(field=field, path="queryset"):
                with self.assertRaises(ValidationError):
                    VoteSession.objects.filter(pk=self.session.pk).update(**{field: value})

        unchanged = VoteSession._base_manager.get(pk=self.session.pk)
        self.assertEqual(unchanged.purpose, VoteSession.Purpose.SELECTION)
        self.assertEqual(unchanged.max_selections, 1)

    def test_operational_fields_still_change_after_the_freeze(self):
        """The window and the label do not redefine the vote, so they stay editable."""
        from ruleset.models import ContestRuleset, RulesetVersion
        from ruleset.test_schema import DEF

        ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="Frozen operational binding",
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

        self.session.name = "改名后的投票"
        self.session.save(update_fields=["name"])

        self.assertEqual(VoteSession._base_manager.get(pk=self.session.pk).name, "改名后的投票")

    def test_ticket_ballot_rejects_cross_activity_relation(self):
        # `submit_ballot` is the only writer of a ballot (GOAL §8.4 raw audience fact), so a
        # fixture that writes one has to hold the same authority the service holds.
        with authority_write(VOTE_BALLOT_WRITE):
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
        with authority_write(VOTE_BALLOT_WRITE):
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
