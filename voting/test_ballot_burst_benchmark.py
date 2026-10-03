"""Safety rails for the ballot burst benchmark (P1-8)."""

from datetime import timedelta
from io import StringIO

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, VOTE_SESSION_STATE, authority_write
from core.models import Activity
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connections
from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from singer_contest.models import SingerRegistration

from voting.models import VoteBallot, VoteOption, VoteSession


class BallotBurstBenchmarkTests(TransactionTestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.operator = User.objects.create_user(
                username="benchmark-staff", password="pass", role=User.Role.STAFF
            )
            self.singer_user = User.objects.create_user(
                username="benchmark-singer", password="pass", role=User.Role.PARTICIPANT
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Benchmark activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.singer_user,
            name="Benchmark singer",
            student_id="benchmark-001",
            college="Arts",
            class_name="Class 1",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        now = timezone.now()
        self.vote_session = VoteSession.objects.create(
            activity=self.activity,
            name="Benchmark vote",
            start_time=now - timedelta(minutes=1),
            end_time=now + timedelta(hours=1),
            is_test_data=True,
        )
        self.option = VoteOption.objects.create(
            vote_session=self.vote_session,
            singer=self.singer,
            sort_order=1,
            is_test_data=True,
        )

    def _open_session(self) -> None:
        with authority_write(VOTE_SESSION_STATE):
            self.vote_session.is_open = True
            self.vote_session.save(update_fields=["is_open"])

    def _run(self, **options):
        stdout = StringIO()
        stderr = StringIO()
        call_command("benchmark_ballot_burst", stdout=stdout, stderr=stderr, **options)
        return stdout.getvalue(), stderr.getvalue()

    def test_refuses_a_non_test_activity(self):
        with authority_write(ACTIVITY_STATE):
            formal = Activity.objects.create(
                title="Formal benchmark activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=False,
            )
        now = timezone.now()
        formal_session = VoteSession.objects.create(
            activity=formal,
            name="Formal benchmark vote",
            start_time=now - timedelta(minutes=1),
            end_time=now + timedelta(hours=1),
        )

        with self.assertRaisesMessage(CommandError, "is_test_mode=True"):
            self._run(
                vote_session=formal_session.pk,
                clients=1,
                duration=0.01,
                allow_sqlite=True,
            )

    def test_refuses_a_closed_session(self):
        with self.assertRaisesMessage(CommandError, "Open the vote session"):
            self._run(
                vote_session=self.vote_session.pk,
                clients=1,
                duration=0.01,
                allow_sqlite=True,
            )

    def test_refuses_sqlite_without_the_opt_in(self):
        if connections["default"].vendor == "postgresql":
            self.skipTest("The SQLite guard only applies on SQLite.")
        self._open_session()

        with self.assertRaisesMessage(CommandError, "--allow-sqlite"):
            self._run(vote_session=self.vote_session.pk, clients=1, duration=0.01)

    @override_settings(DEBUG=True)
    def test_runs_a_burst_and_reports_the_invariants(self):
        self._open_session()

        stdout, stderr = self._run(
            vote_session=self.vote_session.pk,
            clients=1,
            duration=0.01,
            allow_sqlite=True,
        )

        self.assertIn("Ballots: 1 ok / 0 failed", stdout)
        self.assertIn("+1 ballots, +1 records", stdout)
        self.assertEqual(stderr, "")
        self.assertEqual(VoteBallot.objects.filter(vote_session=self.vote_session).count(), 1)
