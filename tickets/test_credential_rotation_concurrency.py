"""The credential is resolved before the row lock, so a rotation can land in between.

`rotate_ticket_credential` promises that rotating "invalidates the printed QR code and
existing browser sessions". Sequentially that holds — the resolution re-reads the stored
version and returns nothing once it has moved. Under concurrency it did not: a check-in or
a redemption that had already resolved the *old* code kept going after the rotation
committed, because the code after the lock re-read the row and checked only its `state`.
A redemption would even mint a `TicketAccessSession` immediately after the rotation had
revoked the sessions that code had produced, so an operator who had just reset a leaked
code would see a working session created from it.

These two tests pin the interleaving rather than hoping for it. They hold the resolution
step open with a hook on `_ticket_for_credential` so the rotation commits at exactly the
moment that matters: after the credential resolved, before the lock was taken. That is a
reordering of the schedule, not of the logic — the service code runs unmodified.
"""

import threading

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from core.models import Activity
from django.core.exceptions import ValidationError
from django.db import connection
from django.test import TransactionTestCase
from django.utils import timezone
from tests.helpers import postgresql_only

from tickets import services as ticket_services
from tickets.models import Ticket, TicketAccessSession
from tickets.services import (
    check_in_ticket_outcome,
    create_ticket,
    issue_ticket,
    redeem_ticket,
    rotate_ticket_credential,
    ticket_credential,
)

INTERLEAVE_TIMEOUT = 15


@postgresql_only
class CredentialRotationRaceTests(TransactionTestCase):
    """Both linearizations must be correct, whichever one the scheduler picks."""

    reset_sequences = True

    def setUp(self):
        self.staff = User.objects.create_user(username="rotate-race-staff", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff.role = User.Role.STAFF
            self.staff.save(update_fields=["role", "is_staff"])
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Rotation race",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.LIVE,
                is_test_mode=True,
            )

    def _issued_ticket(self, serial_number: str):
        ticket = create_ticket(self.activity, actor=self.staff, serial_number=serial_number)
        issued = issue_ticket(ticket, actor=self.staff)
        return Ticket.objects.get(pk=ticket.pk), issued.secret

    def _run_with_rotation_committed_after_resolution(self, work):
        """Run ``work`` in a thread, rotating the credential after it resolves the code.

        The hook fires once, on the first resolution, and holds that thread until the
        main connection has committed the rotation.
        """
        resolved = threading.Event()
        rotation_done = threading.Event()
        original = ticket_services._ticket_for_credential
        calls = 0

        def gated(raw_credential):
            nonlocal calls
            result = original(raw_credential)
            calls += 1
            if calls == 1:
                resolved.set()
                if not rotation_done.wait(timeout=INTERLEAVE_TIMEOUT):
                    raise AssertionError("the rotation never committed")
            return result

        results: list[object] = []
        errors: list[Exception] = []

        def target():
            try:
                results.append(work())
            except Exception as error:  # noqa: BLE001 - the assertion is about which error
                errors.append(error)
            finally:
                connection.close()

        ticket_services._ticket_for_credential = gated
        try:
            thread = threading.Thread(target=target)
            thread.start()
            self.assertTrue(resolved.wait(timeout=INTERLEAVE_TIMEOUT), "resolution never happened")
            rotate_ticket_credential(Ticket.objects.get(pk=self.ticket.pk), actor=self.staff)
            rotation_done.set()
            thread.join(timeout=INTERLEAVE_TIMEOUT)
        finally:
            ticket_services._ticket_for_credential = original

        self.assertFalse(thread.is_alive(), "the racing request never finished")
        return results, errors

    def _assert_no_new_session_survives(self):
        self.assertFalse(
            TicketAccessSession.objects.filter(
                ticket_id=self.ticket.pk, revoked_at__isnull=True, expires_at__gt=timezone.now()
            ).exists()
        )

    def test_a_rotation_that_wins_rejects_a_check_in_that_already_resolved(self):
        self.ticket, stale_credential = self._issued_ticket("rotate-checkin-1")
        initial_version = self.ticket.credential_version

        def check_in():
            return check_in_ticket_outcome(stale_credential, actor=self.staff)

        _results, errors = self._run_with_rotation_committed_after_resolution(check_in)

        self.assertTrue(errors, "the stale credential was accepted for check-in")
        self.assertIsInstance(errors[0], ValidationError)
        self.ticket.refresh_from_db()
        self.assertEqual(self.ticket.state, Ticket.State.ISSUED)
        self.assertEqual(self.ticket.credential_version, initial_version + 1)

    def test_a_rotation_that_wins_rejects_a_redemption_that_already_resolved(self):
        self.ticket, stale_credential = self._issued_ticket("rotate-redeem-1")
        initial_version = self.ticket.credential_version

        def redeem():
            return redeem_ticket(stale_credential)

        _results, errors = self._run_with_rotation_committed_after_resolution(redeem)

        self.assertTrue(errors, "the stale credential minted a session after the rotation")
        self.assertIsInstance(errors[0], ValidationError)
        self.ticket.refresh_from_db()
        self.assertEqual(self.ticket.credential_version, initial_version + 1)
        self._assert_no_new_session_survives()

    def test_a_redemption_that_wins_the_lock_keeps_a_session_the_rotation_then_revokes(self):
        """The other linearization: the rotation must still cover a session already made.

        Sequential, but it is the half of the promise the race tests cannot see — that a
        session created *before* the rotation does not survive it.
        """
        self.ticket, credential = self._issued_ticket("rotate-redeem-2")
        redeemed = redeem_ticket(credential)

        rotate_ticket_credential(Ticket.objects.get(pk=self.ticket.pk), actor=self.staff)

        redeemed.session.refresh_from_db()
        self.assertIsNotNone(redeemed.session.revoked_at)
        self._assert_no_new_session_survives()

    def test_the_rotated_credential_is_the_only_one_that_works_afterwards(self):
        """The fix must not have made rotation merely break the old code *sometimes*."""
        self.ticket, stale_credential = self._issued_ticket("rotate-checkin-2")

        fresh_credential = rotate_ticket_credential(
            Ticket.objects.get(pk=self.ticket.pk), actor=self.staff
        )

        self.assertNotEqual(fresh_credential, stale_credential)
        with self.assertRaises(ValidationError):
            check_in_ticket_outcome(stale_credential, actor=self.staff)
        outcome = check_in_ticket_outcome(fresh_credential, actor=self.staff)
        self.assertFalse(outcome.already_checked_in)
        self.assertEqual(ticket_credential(Ticket.objects.get(pk=self.ticket.pk)), fresh_credential)
