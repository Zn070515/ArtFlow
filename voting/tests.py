import threading
import time
from datetime import timedelta
from unittest import skipUnless

from accounts.models import User
from core.models import Activity
from django.core.exceptions import ValidationError
from django.db import connection, transaction
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from singer_contest.models import SingerRegistration

from .models import VoteBallot, VoteOption, VoteRecord, VoteSession
from .services import submit_ballot


class VoteBallotTests(TestCase):
    def setUp(self):
        user = User.objects.create_user(username="participant", password="pass")
        second_user = User.objects.create_user(username="participant-two", password="pass")
        activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
        )
        singer = SingerRegistration.objects.create(
            activity=activity,
            user=user,
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        second_singer = SingerRegistration.objects.create(
            activity=activity,
            user=second_user,
            name="Second Singer",
            student_id="20260002",
            college="College",
            class_name="Class",
            phone="13800000001",
            song_name="Song 2",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.session = VoteSession.objects.create(
            activity=activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_open=True,
        )
        self.option = VoteOption.objects.create(vote_session=self.session, singer=singer)
        self.second_option = VoteOption.objects.create(
            vote_session=self.session, singer=second_singer
        )

    def test_same_browser_can_submit_only_one_ballot(self):
        first = submit_ballot(
            self.session,
            browser_session_key="browser-1",
            option_ids=[self.option.pk],
            ip_address="10.0.0.1",
        )
        second = submit_ballot(
            self.session,
            browser_session_key="browser-1",
            option_ids=[self.second_option.pk],
            ip_address="10.0.0.1",
        )

        self.assertEqual(first.pk, second.pk)
        self.assertEqual(VoteBallot.objects.filter(vote_session=self.session).count(), 1)
        self.assertEqual(VoteRecord.objects.filter(vote_session=self.session).count(), 1)
        self.assertEqual(VoteRecord.objects.get().vote_option_id, self.option.pk)

    def test_different_browsers_sharing_ip_can_vote(self):
        submit_ballot(
            self.session,
            browser_session_key="browser-1",
            option_ids=[self.option.pk],
            ip_address="10.0.0.1",
        )
        submit_ballot(
            self.session,
            browser_session_key="browser-2",
            option_ids=[self.second_option.pk],
            ip_address="10.0.0.1",
        )

        self.assertEqual(VoteBallot.objects.filter(ip_address="10.0.0.1").count(), 2)

    def test_submit_ballot_rejects_option_from_another_session(self):
        other_session = VoteSession.objects.create(
            activity=self.session.activity,
            name="Other",
            passcode="5678",
            start_time=self.session.start_time,
            end_time=self.session.end_time,
            is_open=True,
        )
        foreign_option = VoteOption.objects.create(
            vote_session=other_session, singer=self.option.singer
        )

        with self.assertRaises(ValidationError):
            submit_ballot(
                self.session,
                browser_session_key="browser-3",
                option_ids=[foreign_option.pk],
                ip_address="10.0.0.2",
            )

        self.assertFalse(VoteBallot.objects.filter(browser_session_key="browser-3").exists())

    def test_submit_ballot_revalidates_state_after_lock(self):
        stale_session = self.session  # in-memory copy still reports open
        VoteSession.objects.filter(pk=self.session.pk).update(is_locked=True, is_open=False)

        with self.assertRaises(ValidationError):
            submit_ballot(
                stale_session,
                browser_session_key="browser-lock",
                option_ids=[self.option.pk],
                ip_address="10.0.0.5",
            )

        self.assertEqual(VoteBallot.objects.filter(vote_session=self.session).count(), 0)


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class VoteBallotConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="concurrent-participant", password="pass")
        activity = Activity.objects.create(
            title="Concurrent Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
        )
        singer = SingerRegistration.objects.create(
            activity=activity,
            user=self.user,
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.session = VoteSession.objects.create(
            activity=activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_open=True,
        )
        self.option = VoteOption.objects.create(vote_session=self.session, singer=singer)

    def test_concurrent_lock_prevents_ballot_after_commit(self):
        lock_held = threading.Event()
        release_lock = threading.Event()
        holder_error = {}

        def hold_lock():
            try:
                with transaction.atomic():
                    session = VoteSession.objects.select_for_update().get(pk=self.session.pk)
                    session.is_locked = True
                    session.save(update_fields=["is_locked"])
                    lock_held.set()
                    release_lock.wait(timeout=10)
            except Exception as error:  # pragma: no cover - diagnostic only
                holder_error["error"] = error
            finally:
                connection.close()

        holder = threading.Thread(target=hold_lock)
        holder.start()
        self.assertTrue(lock_held.wait(timeout=10))

        submit_result = {}

        def try_submit():
            try:
                submit_ballot(
                    self.session,
                    browser_session_key="browser-race",
                    option_ids=[self.option.pk],
                    ip_address="10.0.0.9",
                )
                submit_result["accepted"] = True
            except ValidationError:
                submit_result["rejected"] = True
            except Exception as error:  # pragma: no cover - diagnostic only
                submit_result["error"] = error
            finally:
                connection.close()

        submitter = threading.Thread(target=try_submit)
        submitter.start()
        time.sleep(1)  # let the submitter block on the row lock
        release_lock.set()
        holder.join(timeout=10)
        submitter.join(timeout=10)

        self.assertFalse(holder_error, holder_error)
        self.assertTrue(submit_result.get("rejected"), f"expected rejection, got {submit_result}")
        self.assertEqual(VoteBallot.objects.filter(vote_session=self.session).count(), 0)
