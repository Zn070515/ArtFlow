"""The judge capability is resolved before the activity lock, so staff can act in between.

`claim_judge_session_for_entry` resolves the capability to find the row it must lock, and
the lock can only be taken afterwards. Reissuing the QR or closing the entry commits in
that gap, and the entry used to be judged entirely on the pre-lock read: a claim that had
already resolved the old code took a seat *after* the reissue that was supposed to kill
that code, and after the close that was supposed to stop new scans. The same shape the
ticket credential had, in the same place — the first authorization decision.

These tests fix the interleaving rather than hoping for it: a one-shot gate on the
resolution step holds the racing claim open while the staff action commits on another
connection. That reorders the schedule, not the logic — the service runs unmodified.
"""

import threading

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, CONTEST_ROUND_STATE, authority_write
from core.models import Activity
from django.core.exceptions import ValidationError
from django.db import connection
from django.test import TransactionTestCase
from django.urls import reverse
from tests.helpers import postgresql_only

from singer_contest import judge_authority
from singer_contest.judge_authority import claim_judge_session_for_entry, prepare_judge_panel
from singer_contest.judge_entry import judge_entry_credential
from singer_contest.models import ContestRound, Judge, JudgeSession, Performance, SingerRegistration
from singer_contest.services import prepare_round

INTERLEAVE_TIMEOUT = 15


@postgresql_only
class JudgeEntryRaceTests(TransactionTestCase):
    """Both linearizations must be correct, whichever one the scheduler picks."""

    reset_sequences = True

    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(username="judge-entry-race", password="pass")
            self.staff.role = User.Role.STAFF
            self.staff.save(update_fields=["role", "is_staff"])
            self.participant = User.objects.create_user(
                username="judge-entry-race-singer", password="pass"
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Judge entry race",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REHEARSAL,
                is_test_mode=True,
                judge_entry_open=True,
            )
        with authority_write(ACCOUNT_AUTHORITY):
            judge = Judge.objects.create(activity=self.activity, name="Race Judge")
        singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.participant,
            name="Race Singer",
            student_id="JER-001",
            college="Info",
            class_name="CS1",
            phone="13800000000",
            song_name="Race Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        with authority_write(CONTEST_ROUND_STATE):
            contest_round = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                minimum_judge_count=1,
                is_locked=False,
            )
        Performance.objects.create(
            activity=self.activity,
            round=contest_round,
            singer=singer,
            sequence=1,
            song_title="Race Song",
            is_test_data=True,
        )
        prepare_round(contest_round, self.staff)
        prepare_judge_panel(contest_round.pk, operator=self.staff, attending_judge_ids=[judge.pk])
        self.client.force_login(self.staff)

    def _run_with_staff_action_committed_after_resolution(self, staff_action):
        """Run one claim in a thread, committing ``staff_action`` after it resolves.

        The gate fires once, on the resolution step, and holds that thread until the main
        connection's staff action has committed — the window the entry must survive.
        """
        resolved = threading.Event()
        action_done = threading.Event()
        credential = judge_entry_credential(self.activity)
        original = judge_authority.judge_entry_activity
        calls = 0

        def gated(raw_credential, *, public_code):
            nonlocal calls
            result = original(raw_credential, public_code=public_code)
            calls += 1
            if calls == 1:
                resolved.set()
                if not action_done.wait(timeout=INTERLEAVE_TIMEOUT):
                    raise AssertionError("the staff action never committed")
            return result

        outcomes: list[object] = []
        errors: list[Exception] = []

        def target():
            try:
                outcomes.append(
                    claim_judge_session_for_entry(credential, public_code=self.activity.public_code)
                )
            except Exception as error:  # noqa: BLE001 - the assertion is about which error
                errors.append(error)
            finally:
                connection.close()

        judge_authority.judge_entry_activity = gated
        try:
            thread = threading.Thread(target=target)
            thread.start()
            self.assertTrue(resolved.wait(timeout=INTERLEAVE_TIMEOUT), "resolution never happened")
            staff_action()
            action_done.set()
            thread.join(timeout=INTERLEAVE_TIMEOUT)
        finally:
            judge_authority.judge_entry_activity = original

        self.assertFalse(thread.is_alive(), "the racing claim never finished")
        return outcomes, errors

    def test_a_reissue_that_wins_refuses_a_claim_that_already_resolved(self):
        def rotate():
            response = self.client.post(
                reverse("staff:activity_judge_entry_rotate", args=[self.activity.pk])
            )
            self.assertEqual(response.status_code, 302)

        outcomes, errors = self._run_with_staff_action_committed_after_resolution(rotate)

        self.assertEqual(outcomes, [])
        self.assertTrue(errors, "the stale capability still claimed a seat")
        self.assertIsInstance(errors[0], ValidationError)
        self.assertIn("INVALID_JUDGE_ENTRY", errors[0].messages)
        self.activity.refresh_from_db()
        self.assertEqual(self.activity.judge_entry_version, 2)
        self.assertFalse(JudgeSession.objects.exists())

    def test_a_close_that_wins_refuses_a_claim_that_already_resolved(self):
        def close_entry():
            response = self.client.post(
                reverse("staff:activity_judge_entry_toggle", args=[self.activity.pk])
            )
            self.assertEqual(response.status_code, 302)

        outcomes, errors = self._run_with_staff_action_committed_after_resolution(close_entry)

        self.assertEqual(outcomes, [])
        self.assertTrue(errors, "a closed entry still handed out a seat")
        self.assertIsInstance(errors[0], ValidationError)
        self.assertIn("JUDGE_ENTRY_CLOSED", errors[0].messages)
        self.activity.refresh_from_db()
        self.assertFalse(self.activity.judge_entry_open)
        self.assertFalse(JudgeSession.objects.exists())

    def test_a_claim_that_wins_keeps_its_session_when_the_entry_then_closes(self):
        """The other linearization, and the semantics it protects.

        Closing the entry stops *new* scans; it must not evict the panel that is already
        seated, or the "close after everyone is in" step would end the evening.
        """
        credential = judge_entry_credential(self.activity)
        claimed = claim_judge_session_for_entry(credential, public_code=self.activity.public_code)

        response = self.client.post(
            reverse("staff:activity_judge_entry_toggle", args=[self.activity.pk])
        )
        self.assertEqual(response.status_code, 302)

        claimed.session.refresh_from_db()
        self.assertEqual(claimed.session.state, JudgeSession.State.ACTIVE)
        self.assertIsNone(claimed.session.revoked_at)

    def test_a_reissue_that_wins_leaves_a_seated_panel_alone(self):
        """A reissue kills the codes, not the seats: the panel keeps scoring."""
        credential = judge_entry_credential(self.activity)
        claimed = claim_judge_session_for_entry(credential, public_code=self.activity.public_code)

        self.client.post(reverse("staff:activity_judge_entry_rotate", args=[self.activity.pk]))

        claimed.session.refresh_from_db()
        self.assertEqual(claimed.session.state, JudgeSession.State.ACTIVE)
