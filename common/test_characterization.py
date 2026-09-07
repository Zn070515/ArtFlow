"""Characterization / regression snapshots for the pre-M1-B domain behavior.

M1-B/C restructure the competition model (ContestRound, SingerRegistration,
ScoreSummary, Material structure). These tests pin the CURRENT behavior of the
invariants those phases will touch, so a regression during the migration shows up
as a test failure rather than being mistaken for "the old base was already broken".

These deliberately mirror the SubmissionFile version/one-current pattern that
ArchivePackage now shares (M1-A A2), and snapshot the round-snapshot immutability,
score, vote, material, and TEST/FORMAL isolation guarantees the roadmap leans on.
"""

from archive.models import ArchivePackage
from core.models import Activity
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone
from files.models import SubmissionFile
from files.services import store_submission_file
from singer_contest.models import (
    ContestRound,
    Judge,
    RoundEntry,
    RoundJudge,
    ScoreRecord,
    SingerRegistration,
)
from voting.models import VoteOption, VoteSession

from common.authority import (
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    VOTE_SESSION_STATE,
    authority_write,
)
from common.lifecycle import runtime_approved_singers, scope_runtime
from common.test_data import get_test_data_counts


class _CharacterizationBase(TestCase):
    def make_activity(self, *, is_test_mode=False, **kwargs):
        values = dict(
            title="CharActivity",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REHEARSAL,
            is_test_mode=is_test_mode,
        )
        values.update(kwargs)
        with authority_write(ACTIVITY_STATE):
            return Activity.objects.create(**values)

    def make_user(self, username):
        return get_user_model().objects.create_user(username=username, password="pass")

    def make_round(self, activity, *, round_type=None):
        return ContestRound.objects.create(
            activity=activity,
            round_type=round_type or ContestRound.RoundType.PRELIMINARY,
            advance_count=1,
        )

    def make_singer(self, activity, *, username, student_id, name=None, **kwargs):
        values = dict(
            activity=activity,
            user=self.make_user(username),
            name=name or f"Singer{student_id}",
            student_id=student_id,
            college="Info",
            class_name="CS",
            phone="13800000000",
            song_name="Song",
            is_test_data=False,
        )
        values.update(kwargs)
        return SingerRegistration.objects.create(**values)


class ArchiveInvariantCharacterizationTests(_CharacterizationBase):
    """Pin ArchivePackage version / one-current DB invariants (M1-A A2).

    Before M1-A these were maintained only by the service under the Activity lock;
    now the DB enforces them. Re-pinning forces a model-cleanup regression (e.g. a
    dedup that leaves two currents or a stale version) to surface in this test.
    """

    def test_single_package_is_current_v1(self):
        pkg = ArchivePackage.objects.create(
            activity=self.make_activity(), version=1, is_current=True
        )
        self.assertTrue(pkg.is_current)
        self.assertEqual(pkg.version, 1)

    def test_duplicate_version_for_activity_rejected(self):
        activity = self.make_activity()
        ArchivePackage.objects.create(activity=activity, version=1, is_current=True)
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                ArchivePackage.objects.create(activity=activity, version=1, is_current=False)

    def test_second_current_for_activity_rejected(self):
        activity = self.make_activity()
        ArchivePackage.objects.create(activity=activity, version=1, is_current=True)
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                ArchivePackage.objects.create(activity=activity, version=2, is_current=True)

    def test_sequential_versions_single_current_ok(self):
        activity = self.make_activity()
        ArchivePackage.objects.create(activity=activity, version=1, is_current=False)
        ArchivePackage.objects.create(activity=activity, version=2, is_current=True)
        self.assertEqual(
            ArchivePackage.objects.filter(activity=activity, is_current=True).count(), 1
        )
        self.assertEqual(ArchivePackage.objects.filter(activity=activity).count(), 2)


class RoundSnapshotCharacterizationTests(_CharacterizationBase):
    """Round snapshots (entries, judges) are immutable once the round leaves DRAFT."""

    def test_entry_create_rejected_after_round_leaves_draft(self):
        activity = self.make_activity()
        singer = self.make_singer(activity, username="s1", student_id="1")
        contest_round = self.make_round(activity)
        contest_round.status = ContestRound.Status.SCORING
        with authority_write(CONTEST_ROUND_STATE):
            contest_round.save(update_fields=["status"])
        with self.assertRaises(ValidationError):
            RoundEntry.objects.create(round=contest_round, singer=singer)

    def test_entry_delete_rejected_after_round_leaves_draft(self):
        activity = self.make_activity()
        singer = self.make_singer(activity, username="s1", student_id="1")
        contest_round = self.make_round(activity)
        entry = RoundEntry.objects.create(round=contest_round, singer=singer)
        contest_round.status = ContestRound.Status.PREPARED
        with authority_write(CONTEST_ROUND_STATE):
            contest_round.save(update_fields=["status"])
        with self.assertRaises(ValidationError):
            entry.delete()

    def test_judge_assignment_immutable_after_round_leaves_draft(self):
        activity = self.make_activity()
        judge = Judge.objects.create(activity=activity, name="Judge A", is_active=True)
        contest_round = self.make_round(activity)
        assignment = RoundJudge.objects.create(round=contest_round, judge=judge)
        contest_round.status = ContestRound.Status.PREPARED
        with authority_write(CONTEST_ROUND_STATE):
            contest_round.save(update_fields=["status"])
        with self.assertRaises(ValidationError):
            assignment.delete()


class ScoreRecordCharacterizationTests(_CharacterizationBase):
    def test_score_singer_must_belong_to_round_activity(self):
        activity = self.make_activity()
        other = self.make_activity()
        other_singer = self.make_singer(other, username="s2", student_id="2")
        judge = Judge.objects.create(activity=activity, name="Judge A")
        contest_round = self.make_round(activity)
        with self.assertRaises(ValidationError):
            ScoreRecord.objects.create(
                round=contest_round, singer=other_singer, judge=judge, score=95
            )

    def test_score_unique_round_singer_judge(self):
        activity = self.make_activity()
        singer = self.make_singer(activity, username="s1", student_id="1")
        judge = Judge.objects.create(activity=activity, name="Judge A")
        contest_round = self.make_round(activity)
        ScoreRecord.objects.create(round=contest_round, singer=singer, judge=judge, score=95)
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                ScoreRecord.objects.create(
                    round=contest_round, singer=singer, judge=judge, score=96
                )


class VoteCharacterizationTests(_CharacterizationBase):
    def test_locked_session_must_be_closed(self):
        activity = self.make_activity()
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                with authority_write(VOTE_SESSION_STATE):
                    VoteSession.objects.create(
                        activity=activity,
                        name="Pop",
                        passcode="1234",
                        start_time=timezone.now(),
                        end_time=timezone.now() + timezone.timedelta(minutes=5),  # type: ignore[attr-defined]
                        is_open=True,
                        is_locked=True,
                        is_test_data=False,
                    )

    def test_vote_option_singer_must_belong_to_session_activity(self):
        activity = self.make_activity()
        other = self.make_activity()
        other_singer = self.make_singer(other, username="s2", student_id="2")
        session = VoteSession.objects.create(
            activity=activity,
            name="Pop",
            passcode="1234",
            start_time=timezone.now(),
            end_time=timezone.now() + timezone.timedelta(minutes=5),  # type: ignore[attr-defined]
            is_test_data=False,
        )
        with self.assertRaises(ValidationError):
            VoteOption.objects.create(vote_session=session, singer=other_singer, is_test_data=False)


class MaterialCharacterizationTests(_CharacterizationBase):
    def setUp(self):
        super().setUp()
        self.activity = self.make_activity(is_test_mode=False)
        self.singer = self.make_singer(
            self.activity,
            username="material-singer",
            student_id="mat1",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.staff = self.make_user("material-staff")

    def test_store_submission_file_flips_current_and_bumps_version(self):
        first = store_submission_file(
            owner=self.singer,
            uploaded_file=ContentFile(b"first", name="track.mp3"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.staff,
        )
        self.assertTrue(first.is_current)
        self.assertEqual(first.version, 1)

        second = store_submission_file(
            owner=self.singer,
            uploaded_file=ContentFile(b"second", name="track2.mp3"),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.staff,
        )
        self.assertEqual(second.version, 2)
        self.assertTrue(second.is_current)
        first.refresh_from_db()
        self.assertFalse(first.is_current)
        self.assertEqual(
            SubmissionFile.objects.filter(
                singer_registration=self.singer,
                file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                is_current=True,
            ).count(),
            1,
        )

    def test_two_current_for_same_owner_purpose_rejected(self):
        # The DB backstop for the flip above: a second is_current for the same
        # owner+purpose violates the one-current partial unique constraint.
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                SubmissionFile.objects.create(
                    singer_registration=self.singer,
                    file=ContentFile(b"a", name="a.mp3"),
                    original_name="a.mp3",
                    file_size=1,
                    file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                    is_current=True,
                    version=1,
                    uploaded_by=self.staff,
                )
                SubmissionFile.objects.create(
                    singer_registration=self.singer,
                    file=ContentFile(b"b", name="b.mp3"),
                    original_name="b.mp3",
                    file_size=1,
                    file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                    is_current=True,
                    version=2,
                    uploaded_by=self.staff,
                )


class RuntimeIsolationCharacterizationTests(_CharacterizationBase):
    def test_scope_runtime_isolates_test_rows(self):
        test_activity = self.make_activity(is_test_mode=True)
        formal_activity = self.make_activity(is_test_mode=False)
        test_singer = self.make_singer(
            test_activity,
            username="t1",
            student_id="t1",
            is_test_data=True,
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        formal_singer = self.make_singer(
            formal_activity,
            username="f1",
            student_id="f1",
            is_test_data=False,
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.assertIn(
            test_singer,
            scope_runtime(SingerRegistration.objects.filter(activity=test_activity), test_activity),
        )
        self.assertNotIn(
            formal_singer,
            scope_runtime(SingerRegistration.objects.filter(activity=test_activity), test_activity),
        )

    def test_runtime_approved_singers_matches_lifecycle(self):
        test_activity = self.make_activity(is_test_mode=True)
        self.make_singer(
            test_activity,
            username="t1",
            student_id="t1",
            is_test_data=True,
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.make_singer(
            test_activity,
            username="t2",
            student_id="t2",
            is_test_data=True,
            pre_status=SingerRegistration.PreStatus.DRAFT,
        )
        self.assertEqual(
            runtime_approved_singers(test_activity).count(), 1, "only approved test singers"
        )

    def test_get_test_data_counts_reports_test_rows(self):
        test_activity = self.make_activity(is_test_mode=True)
        formal_activity = self.make_activity(is_test_mode=False)
        self.make_singer(
            test_activity,
            username="t1",
            student_id="t1",
            is_test_data=True,
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.make_singer(
            formal_activity,
            username="f1",
            student_id="f1",
            is_test_data=False,
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.assertEqual(get_test_data_counts(test_activity)["singer_registrations"], 1)
        self.assertEqual(get_test_data_counts(formal_activity)["singer_registrations"], 0)
