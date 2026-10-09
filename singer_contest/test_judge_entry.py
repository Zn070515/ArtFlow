"""The judge entry capability: the thing a shared judge QR carries and nothing else does.

GOAL §12.3 replaced one QR per seat with one QR for the panel. The entry kept the public
activity route as its whole credential, so `/e/<public_code>/judge/` claimed a real seat
for anyone who could read the code — and the score that followed was a legitimate
`DIRECT_JUDGE` fact, not an anomaly any downstream guard could notice. These tests pin the
capability itself: it resolves only for the activity it was issued for, it is not
interchangeable with a ticket credential, and a reissue kills the previous one.
"""

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from core.models import Activity
from django.test import TestCase
from tickets.models import Ticket
from tickets.services import create_ticket, issue_ticket, ticket_credential

from .judge_entry import (
    JUDGE_ENTRY_PREFIX,
    judge_entry_activity,
    judge_entry_credential,
    judge_entry_signature,
)


def _create_activity(**kwargs):
    with authority_write(ACTIVITY_STATE):
        return Activity.objects.create(**kwargs)


class JudgeEntryCapabilityTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(username="judge-entry-staff", password="pass")
            self.staff.role = User.Role.STAFF
            self.staff.save(update_fields=["role", "is_staff"])
        self.activity = _create_activity(
            title="Capability Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.LIVE,
        )
        self.other = _create_activity(
            title="Other Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.LIVE,
        )

    def _set_version(self, version: int) -> None:
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=self.activity.pk).update(judge_entry_version=version)
        self.activity.refresh_from_db()

    def test_a_capability_resolves_to_its_own_activity(self):
        credential = judge_entry_credential(self.activity)

        self.assertTrue(credential.startswith(f"{JUDGE_ENTRY_PREFIX}."))
        self.assertEqual(len(credential.split(".")), 5)
        self.assertEqual(
            judge_entry_activity(credential, public_code=self.activity.public_code),
            self.activity,
        )

    def test_the_capability_is_not_derivable_from_the_public_code(self):
        """Nothing about the public code alone produces a working capability."""
        guessed = f"{JUDGE_ENTRY_PREFIX}.{self.activity.public_code}.1.{'0' * 32}"

        self.assertIsNone(judge_entry_activity(guessed, public_code=self.activity.public_code))

    def test_a_capability_for_another_activity_is_refused(self):
        credential = judge_entry_credential(self.other)

        self.assertIsNone(judge_entry_activity(credential, public_code=self.activity.public_code))

    def test_a_ticket_credential_cannot_be_replayed_as_a_judge_capability(self):
        """Both are keyed on the same secret, so the signed message separates them."""
        ticket = create_ticket(self.activity, actor=self.staff, serial_number="judge-entry-1")
        issue_ticket(ticket, actor=self.staff)
        ticket_row = Ticket.objects.get(pk=ticket.pk)

        self.assertTrue(ticket_credential(ticket_row).startswith("AF1.T."))
        self.assertIsNone(
            judge_entry_activity(
                ticket_credential(ticket_row), public_code=self.activity.public_code
            )
        )

    def test_a_tampered_signature_is_refused(self):
        credential = judge_entry_credential(self.activity)
        head, _, signature = credential.rpartition(".")
        flipped = "0" if signature[0] != "0" else "1"

        tampered = f"{head}.{flipped}{signature[1:]}"

        self.assertIsNone(judge_entry_activity(tampered, public_code=self.activity.public_code))

    def test_reissuing_invalidates_every_previously_issued_capability(self):
        stale = judge_entry_credential(self.activity)

        self._set_version(2)

        self.assertIsNone(judge_entry_activity(stale, public_code=self.activity.public_code))
        self.assertEqual(
            judge_entry_activity(
                judge_entry_credential(self.activity), public_code=self.activity.public_code
            ),
            self.activity,
        )

    def test_a_capability_is_stable_across_reads(self):
        """Several teachers scan the same printed code, so it cannot drift between reads."""
        self.assertEqual(
            judge_entry_credential(self.activity),
            judge_entry_credential(Activity.objects.get(pk=self.activity.pk)),
        )
        self.assertEqual(
            judge_entry_signature(self.activity.public_code, 1),
            judge_entry_signature(self.activity.public_code, 1),
        )

    def test_a_version_the_activity_has_not_reached_is_refused(self):
        """The row is the authority for the version, not the token's claim."""
        credential = f"{JUDGE_ENTRY_PREFIX}.{self.activity.public_code}.9."
        self.assertIsNone(
            judge_entry_activity(
                f"{credential}{judge_entry_signature(self.activity.public_code, 9)}",
                public_code=self.activity.public_code,
            )
        )
