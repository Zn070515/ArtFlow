"""Boundaries on the original audience facts (2026-10 audit, §7 P2).

Three separate holes in the same idea — "a ballot is a raw fact, and only a *valid*
ticket produces a valid one":

* ``VoteBallot``/``VoteRecord`` were writable by any ORM call as long as the session was
  not *locked* yet, so the window between ``close_vote_session`` and the Activity lock
  accepted ballots with no ticket check and no audit;
* ticket revocation invalidated the holder's entrance but not the ballot already counted
  from that ticket, so the published denominator still included it;
* a session whose passcode was left blank accepted an empty passcode submission.
"""

from datetime import timedelta
from decimal import Decimal

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from common.models import AuditLog
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
    revoke_ticket,
)

from .models import VoteBallot, VoteOption, VoteRecord, VoteSession
from .services import (
    ballot_share_percentages,
    close_vote_session,
    open_vote_session,
    submit_ballot,
    vote_session_configuration_facts,
)


def full_share(singer_id: int) -> dict[str, Decimal]:
    """The §5.4 support rate a single valid ballot produces for one candidate."""
    return {str(singer_id): Decimal("100.0000")}


class AudienceFactBoundaryTests(TestCase):
    def setUp(self):
        self.staff = User.objects.create_user(username="audience-staff", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff.role = User.Role.STAFF
            self.staff.save(update_fields=["role", "is_staff"])
        self.admin = User.objects.create_user(username="audience-admin", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.admin.role = User.Role.ADMIN
            self.admin.save(update_fields=["role", "is_staff"])
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Audience fact activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_CLOSED,
                is_test_mode=True,
            )
        self.voter = User.objects.create_user(username="audience-voter", password="pass")
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.voter,
            name="Audience Singer",
            student_id="20269950",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        self.vote_session = VoteSession.objects.create(
            activity=self.activity,
            name="Audience Vote",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            requires_ticket=True,
            is_test_data=True,
        )
        self.option = VoteOption.objects.create(
            vote_session=self.vote_session,
            singer=self.singer,
            is_test_data=True,
        )
        self.vote_session = open_vote_session(self.vote_session, self.staff)

    def _ticket_session(self):
        serial_number = (
            f"{self.activity.pk}-{Ticket.objects.filter(activity=self.activity).count() + 1:03d}"
        )
        ticket = create_ticket(self.activity, actor=self.staff, serial_number=serial_number)
        issued = issue_ticket(ticket, actor=self.staff)
        check_in_ticket(
            issued.secret,
            actor=self.staff,
            request_meta=TicketRequestMeta(ip_address="10.0.0.10"),
        )
        return redeem_ticket(issued.secret)

    def _cast(self, redeemed, *, browser: str, ip: str):
        return submit_ballot(
            self.vote_session,
            browser_session_key=browser,
            option_ids=[self.option.pk],
            ip_address=ip,
            ticket_session=redeemed.session,
        )

    def test_a_revoked_tickets_ballot_leaves_the_valid_ballot_count(self):
        """§9.1 / §9.3: revoked ⇒ that ballot is no longer a *valid* ballot.

        The row survives (it is the evidence of what happened at the door), but it must
        not keep inflating the denominator the published support rate divides by.
        """
        first = self._ticket_session()
        second = self._ticket_session()
        self._cast(first, browser="audience-browser-one", ip="10.0.0.11")
        self._cast(second, browser="audience-browser-two", ip="10.0.0.12")
        self.assertEqual(
            ballot_share_percentages(self.vote_session, test_flag=True), full_share(self.singer.pk)
        )

        revoke_ticket(second.session.ticket, actor=self.admin)

        self.assertEqual(VoteBallot.objects.filter(vote_session=self.vote_session).count(), 2)
        self.assertEqual(
            ballot_share_percentages(self.vote_session, test_flag=True), full_share(self.singer.pk)
        )
        facts = vote_session_configuration_facts(self.vote_session, test_flag=True)
        self.assertEqual(facts["valid_ballots"], 1)
        self.assertEqual(facts["candidate_votes"][self.singer.pk], 1)

    def test_no_valid_ballot_left_holds_instead_of_publishing_a_zero(self):
        """0 valid ballots is not a zero score — the caller has to hold (§9.3)."""
        redeemed = self._ticket_session()
        self._cast(redeemed, browser="audience-browser-only", ip="10.0.0.13")
        revoke_ticket(redeemed.session.ticket, actor=self.admin)

        self.assertIsNone(ballot_share_percentages(self.vote_session, test_flag=True))
        facts = vote_session_configuration_facts(self.vote_session, test_flag=True)
        self.assertEqual(facts["valid_ballots"], 0)
        self.assertTrue(VoteRecord.objects.filter(vote_session=self.vote_session).exists())

    def test_a_ballot_with_no_ticket_stays_valid(self):
        """A legacy ticket-less ballot has nothing to invalidate (§9.4 compatibility)."""
        close_vote_session(self.vote_session, self.staff)
        legacy_session = VoteSession.objects.create(
            activity=self.activity,
            name="Legacy Vote",
            passcode="5678",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            requires_ticket=False,
            is_test_data=True,
        )
        legacy_option = VoteOption.objects.create(
            vote_session=legacy_session, singer=self.singer, is_test_data=True
        )
        legacy_session = open_vote_session(legacy_session, self.staff)
        submit_ballot(
            legacy_session,
            browser_session_key="legacy-browser",
            option_ids=[legacy_option.pk],
            ip_address="10.0.0.14",
        )

        self.assertEqual(
            ballot_share_percentages(legacy_session, test_flag=True),
            full_share(self.singer.pk),
        )

    def test_direct_orm_ballot_write_is_refused_after_the_vote_is_closed(self):
        """The closed-but-unlocked window used to accept a fabricated ballot."""
        redeemed = self._ticket_session()
        self._cast(redeemed, browser="audience-browser-closed", ip="10.0.0.15")
        close_vote_session(self.vote_session, self.staff)
        self.vote_session.refresh_from_db()
        self.assertFalse(self.vote_session.is_open)
        self.assertFalse(self.vote_session.is_locked)

        with self.assertRaises(ValidationError):
            VoteBallot.objects.create(
                vote_session=self.vote_session,
                browser_session_key="fabricated-browser",
                ip_address="10.0.0.99",
                is_test_data=True,
            )
        with self.assertRaises(ValidationError):
            VoteRecord.objects.create(
                vote_session=self.vote_session,
                vote_option=self.option,
                browser_session_key="fabricated-browser",
                ip_address="10.0.0.99",
                is_test_data=True,
            )

        self.assertEqual(VoteBallot.objects.filter(vote_session=self.vote_session).count(), 1)

    def test_the_ballot_service_holds_the_authority_it_requires(self):
        """`submit_ballot` is the sanctioned writer, so it must still work end to end."""
        redeemed = self._ticket_session()
        ballot = self._cast(redeemed, browser="audience-browser-service", ip="10.0.0.16")

        self.assertTrue(VoteBallot.objects.filter(pk=ballot.pk).exists())
        self.assertTrue(VoteRecord.objects.filter(ballot=ballot, vote_option=self.option).exists())

    def test_revoking_a_ticket_records_which_ballots_it_invalidated(self):
        """The ballot rows stay (§19.1), so the audit entry has to name the change."""
        redeemed = self._ticket_session()
        self._cast(redeemed, browser="audience-browser-audit", ip="10.0.0.17")

        revoke_ticket(redeemed.session.ticket, actor=self.admin, note="leaked code")

        audit = AuditLog.objects.get(
            action_type=AuditLog.ActionType.TICKET_REVOKE,
            target=f"Ticket:{redeemed.session.ticket_id}",
        )
        self.assertIn("leaked code", audit.note)
        self.assertIn(f"VoteSession:{self.vote_session.pk}", audit.note)


class VoteEntryPasscodeTests(TestCase):
    def setUp(self):
        # A TEST-lifecycle activity is only reachable by staff (GOAL §14.2), so the entry
        # page has to be opened the same way a rehearsal would open it.
        self.staff = User.objects.create_user(username="blank-passcode-staff", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff.role = User.Role.STAFF
            self.staff.save(update_fields=["role", "is_staff"])
        self.client.force_login(self.staff)
        self.activity = Activity.objects.create(
            title="Blank passcode activity",
            activity_type=Activity.Type.GENERAL,
            is_test_mode=True,
        )
        self.session = VoteSession.objects.create(
            activity=self.activity,
            name="Blank passcode vote",
            passcode="",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            requires_ticket=False,
            is_test_data=True,
        )

    def test_an_unset_passcode_is_not_an_entry_credential(self):
        url = reverse("voting:vote_entry", args=[self.session.pk])
        response = self.client.post(url, {"passcode": ""})

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "尚未设置现场口令")
        self.assertNotIn("vote_passcode_ok", self.client.session)
