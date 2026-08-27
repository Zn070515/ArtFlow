from datetime import timedelta

from accounts.models import User
from core.models import Activity
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.utils import timezone
from singer_contest.models import SingerRegistration

from .models import VoteBallot, VoteOption, VoteRecord, VoteSession
from .services import submit_ballot


class VoteBallotTests(TestCase):
    def setUp(self):
        user = User.objects.create_user(username="participant", password="pass")
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
            user=user,
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
