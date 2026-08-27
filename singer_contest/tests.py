from decimal import Decimal
from io import BytesIO

from accounts.models import User
from common.models import AuditLog
from core.models import Activity
from django.contrib import admin
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, transaction
from django.db.models.deletion import ProtectedError
from django.test import RequestFactory, TestCase
from django.urls import reverse
from openpyxl import Workbook

from .admin import RoundEntryAdmin, RoundJudgeAdmin
from .models import (
    ContestRound,
    Judge,
    RoundEntry,
    RoundJudge,
    ScoreRecord,
    ScoreSummary,
    SingerRegistration,
)
from .services import (
    apply_scores,
    expected_score_cells,
    missing_score_cells,
    parse_score_workbook,
    prepare_round,
    validate_score,
)


class ScoringServiceTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="singer", password="pass")
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
        )
        self.round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
        )
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.user,
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.judge = Judge.objects.create(activity=self.activity, name="Judge")

    def make_singer(self, *, student_id, activity=None, name=None, user=None):
        user = user or User.objects.create_user(username=f"singer-{student_id}", password="pass")
        return SingerRegistration.objects.create(
            activity=activity or self.activity,
            user=user,
            name=name or f"Singer {student_id}",
            student_id=student_id,
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )

    def test_round_entry_rejects_singer_from_another_activity(self):
        other_activity = Activity.objects.create(
            title="Other", activity_type=Activity.Type.SINGER_CONTEST
        )
        foreign = self.make_singer(activity=other_activity, student_id="foreign")

        with self.assertRaises(ValidationError):
            RoundEntry.objects.create(round=self.round, singer=foreign)

    def test_round_judge_rejects_judge_from_another_activity(self):
        other_activity = Activity.objects.create(
            title="Other", activity_type=Activity.Type.SINGER_CONTEST
        )
        foreign = Judge.objects.create(activity=other_activity, name="Foreign Judge")

        with self.assertRaises(ValidationError):
            RoundJudge.objects.create(round=self.round, judge=foreign)

    def test_round_snapshot_pairs_are_unique(self):
        RoundEntry.objects.create(round=self.round, singer=self.singer)
        RoundJudge.objects.create(round=self.round, judge=self.judge)

        with self.assertRaises(IntegrityError), transaction.atomic():
            RoundEntry.objects.create(round=self.round, singer=self.singer)
        with self.assertRaises(IntegrityError), transaction.atomic():
            RoundJudge.objects.create(round=self.round, judge=self.judge)

    def test_prepared_round_rejects_snapshot_creates(self):
        self.round.status = ContestRound.Status.PREPARED
        self.round.save()
        singer = self.make_singer(activity=self.activity, student_id="prepared-create")
        judge = Judge.objects.create(activity=self.activity, name="Prepared Create Judge")

        with self.assertRaises(ValidationError):
            RoundEntry.objects.create(round=self.round, singer=singer)
        with self.assertRaises(ValidationError):
            RoundJudge.objects.create(round=self.round, judge=judge)

    def test_prepared_round_rejects_snapshot_updates(self):
        entry = RoundEntry.objects.create(round=self.round, singer=self.singer)
        round_judge = RoundJudge.objects.create(round=self.round, judge=self.judge)
        self.round.status = ContestRound.Status.PREPARED
        self.round.save()
        entry.singer = self.make_singer(activity=self.activity, student_id="prepared-update")
        round_judge.judge = Judge.objects.create(activity=self.activity, name="Prepared Update Judge")

        with self.assertRaises(ValidationError):
            entry.save()
        with self.assertRaises(ValidationError):
            round_judge.save()

    def test_prepared_round_rejects_snapshot_deletes(self):
        entry = RoundEntry.objects.create(round=self.round, singer=self.singer)
        round_judge = RoundJudge.objects.create(round=self.round, judge=self.judge)
        self.round.status = ContestRound.Status.PREPARED
        self.round.save()

        with self.assertRaises(ValidationError):
            entry.delete()
        with self.assertRaises(ValidationError):
            round_judge.delete()

        self.assertTrue(RoundEntry.objects.filter(pk=entry.pk).exists())
        self.assertTrue(RoundJudge.objects.filter(pk=round_judge.pk).exists())

    def test_admin_bulk_delete_rejects_prepared_snapshots(self):
        entry = RoundEntry.objects.create(round=self.round, singer=self.singer)
        round_judge = RoundJudge.objects.create(round=self.round, judge=self.judge)
        self.round.status = ContestRound.Status.PREPARED
        self.round.save()
        request = RequestFactory().post("/admin/")

        with self.assertRaises(ValidationError):
            RoundEntryAdmin(RoundEntry, admin.site).delete_queryset(
                request, RoundEntry.objects.filter(pk=entry.pk)
            )
        with self.assertRaises(ValidationError):
            RoundJudgeAdmin(RoundJudge, admin.site).delete_queryset(
                request, RoundJudge.objects.filter(pk=round_judge.pk)
            )

        self.assertTrue(RoundEntry.objects.filter(pk=entry.pk).exists())
        self.assertTrue(RoundJudge.objects.filter(pk=round_judge.pk).exists())

    def test_prepared_round_rejects_snapshot_queryset_deletes(self):
        entry = RoundEntry.objects.create(round=self.round, singer=self.singer)
        round_judge = RoundJudge.objects.create(round=self.round, judge=self.judge)
        self.round.status = ContestRound.Status.PREPARED
        self.round.save()

        with self.assertRaises(ValidationError):
            RoundEntry.objects.filter(pk=entry.pk).delete()
        with self.assertRaises(ValidationError):
            RoundJudge.objects.filter(pk=round_judge.pk).delete()

    def test_prepared_round_rejects_snapshot_queryset_updates(self):
        entry = RoundEntry.objects.create(round=self.round, singer=self.singer)
        round_judge = RoundJudge.objects.create(round=self.round, judge=self.judge)
        self.round.status = ContestRound.Status.PREPARED
        self.round.save()
        singer = self.make_singer(activity=self.activity, student_id="prepared-queryset-update")
        judge = Judge.objects.create(activity=self.activity, name="Prepared Queryset Update Judge")

        with self.assertRaises(ValidationError):
            RoundEntry.objects.filter(pk=entry.pk).update(singer_id=singer.pk)
        with self.assertRaises(ValidationError):
            RoundJudge.objects.filter(pk=round_judge.pk).update(judge_id=judge.pk)

    def test_prepared_round_rejects_snapshot_bulk_creates(self):
        self.round.status = ContestRound.Status.PREPARED
        self.round.save()
        singer = self.make_singer(activity=self.activity, student_id="prepared-bulk-create")
        judge = Judge.objects.create(activity=self.activity, name="Prepared Bulk Create Judge")

        with self.assertRaises(ValidationError):
            RoundEntry.objects.bulk_create([RoundEntry(round=self.round, singer=singer)])
        with self.assertRaises(ValidationError):
            RoundJudge.objects.bulk_create([RoundJudge(round=self.round, judge=judge)])

    def test_prepared_snapshots_protect_parents_from_deletion(self):
        RoundEntry.objects.create(round=self.round, singer=self.singer)
        RoundJudge.objects.create(round=self.round, judge=self.judge)
        self.round.status = ContestRound.Status.PREPARED
        self.round.save()

        with self.assertRaises(ProtectedError):
            self.round.delete()
        with self.assertRaises(ProtectedError):
            self.singer.delete()
        with self.assertRaises(ProtectedError):
            self.judge.delete()

    def test_draft_round_allows_snapshot_bulk_operations(self):
        entry = RoundEntry.objects.bulk_create([RoundEntry(round=self.round, singer=self.singer)])[0]
        round_judge = RoundJudge.objects.bulk_create([RoundJudge(round=self.round, judge=self.judge)])[0]
        singer = self.make_singer(activity=self.activity, student_id="draft-queryset-update")
        judge = Judge.objects.create(activity=self.activity, name="Draft Queryset Update Judge")

        self.assertEqual(
            RoundEntry.objects.filter(pk=entry.pk).update(singer_id=singer.pk),
            1,
        )
        self.assertEqual(
            RoundJudge.objects.filter(pk=round_judge.pk).update(judge_id=judge.pk),
            1,
        )
        self.assertEqual(RoundEntry.objects.filter(pk=entry.pk).delete()[0], 1)
        self.assertEqual(RoundJudge.objects.filter(pk=round_judge.pk).delete()[0], 1)

    def test_base_manager_rejects_prepared_snapshot_bulk_mutations(self):
        entry = RoundEntry.objects.create(round=self.round, singer=self.singer)
        round_judge = RoundJudge.objects.create(round=self.round, judge=self.judge)
        self.round.status = ContestRound.Status.PREPARED
        self.round.save()
        singer = self.make_singer(activity=self.activity, student_id="prepared-base-manager")
        judge = Judge.objects.create(activity=self.activity, name="Prepared Base Manager Judge")

        with self.assertRaises(ValidationError):
            RoundEntry._base_manager.filter(pk=entry.pk).update(singer_id=singer.pk)
        with self.assertRaises(ValidationError):
            RoundJudge._base_manager.filter(pk=round_judge.pk).delete()
        with self.assertRaises(ValidationError):
            RoundEntry._base_manager.bulk_create([RoundEntry(round=self.round, singer=singer)])
        with self.assertRaises(ValidationError):
            RoundJudge._base_manager.bulk_create([RoundJudge(round=self.round, judge=judge)])

    def test_draft_snapshots_allow_parent_deletion(self):
        entry = RoundEntry.objects.create(round=self.round, singer=self.singer)
        round_judge = RoundJudge.objects.create(round=self.round, judge=self.judge)

        self.round.delete()

        self.assertFalse(RoundEntry.objects.filter(pk=entry.pk).exists())
        self.assertFalse(RoundJudge.objects.filter(pk=round_judge.pk).exists())

        singer_round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
        )
        singer = self.make_singer(activity=self.activity, student_id="draft-parent-singer")
        singer_entry = RoundEntry.objects.create(round=singer_round, singer=singer)

        singer.delete()

        self.assertFalse(RoundEntry.objects.filter(pk=singer_entry.pk).exists())

        other_activity = Activity.objects.create(
            title="Other", activity_type=Activity.Type.SINGER_CONTEST
        )
        judge_round = ContestRound.objects.create(
            activity=other_activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
        )
        judge = Judge.objects.create(activity=other_activity, name="Draft Parent Judge")
        round_judge = RoundJudge.objects.create(round=judge_round, judge=judge)

        judge.delete()

        self.assertFalse(RoundJudge.objects.filter(pk=round_judge.pk).exists())

    def test_prepare_preliminary_round_snapshots_approved_non_test_singers(self):
        test_singer = self.make_singer(student_id="prepared-test")
        test_singer.is_test_data = True
        test_singer.save(update_fields=["is_test_data"])
        unapproved_singer = self.make_singer(student_id="prepared-unapproved")
        unapproved_singer.pre_status = SingerRegistration.PreStatus.SUBMITTED
        unapproved_singer.save(update_fields=["pre_status"])

        prepared_round = prepare_round(self.round, self.user)

        self.assertEqual(
            list(RoundEntry.objects.filter(round=self.round).values_list("singer_id", flat=True)),
            [self.singer.pk],
        )
        self.assertEqual(prepared_round.status, ContestRound.Status.PREPARED)
        self.assertFalse(prepared_round.is_locked)
        self.assertTrue(
            AuditLog.objects.filter(
                operator=self.user,
                action_type=AuditLog.ActionType.UPDATE_STATUS,
                target=f"ContestRound:{self.round.pk}",
            ).exists()
        )

    def test_prepare_semifinal_round_uses_only_previous_advancers(self):
        semifinal = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
        )
        for index in range(20):
            singer = self.make_singer(student_id=f"2026{index:04d}")
            ScoreSummary.objects.create(
                round=self.round,
                singer=singer,
                average_score=90 - index,
                rank=index + 1,
                is_advanced=index < 10,
            )

        prepare_round(semifinal, self.user)

        self.assertEqual(RoundEntry.objects.filter(round=semifinal).count(), 10)

    def test_prepare_round_snapshots_active_judges(self):
        second_judge = Judge.objects.create(activity=self.activity, name="Second Judge")
        Judge.objects.create(activity=self.activity, name="Inactive Judge", is_active=False)

        prepare_round(self.round, self.user)

        self.assertEqual(
            list(RoundJudge.objects.filter(round=self.round).values_list("judge_id", flat=True)),
            [self.judge.pk, second_judge.pk],
        )

    def test_prepare_round_is_rejected_after_preparation(self):
        prepare_round(self.round, self.user)

        with self.assertRaises(ValidationError):
            prepare_round(self.round, self.user)

    def test_expected_cells_include_approved_singer_and_active_judge(self):
        prepare_round(self.round, self.user)
        self.assertEqual(expected_score_cells(self.round), [(self.singer.pk, self.judge.pk)])

    def test_missing_cells_report_absent_score_record(self):
        prepare_round(self.round, self.user)

        self.assertEqual(
            missing_score_cells(self.round),
            [
                {
                    "singer_id": self.singer.pk,
                    "singer_name": "Singer",
                    "judge_id": self.judge.pk,
                    "judge_name": "Judge",
                }
            ],
        )

        ScoreRecord.objects.create(round=self.round, singer=self.singer, judge=self.judge, score=90)
        self.assertEqual(missing_score_cells(self.round), [])

    def test_validate_score_rejects_invalid_values(self):
        for value in ("", "abc", "-0.01", "100.01", "NaN", "Infinity", "1.234"):
            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    validate_score(value)

    def test_validate_score_returns_decimal_for_valid_values(self):
        self.assertEqual(validate_score("99.50"), Decimal("99.50"))

    def test_apply_scores_is_atomic_when_one_cell_is_invalid(self):
        prepare_round(self.round, self.user)

        with self.assertRaises(ValidationError):
            apply_scores(
                self.round,
                {(self.singer.pk, self.judge.pk): "91", (999999, self.judge.pk): "92"},
                self.user,
            )

        self.assertFalse(ScoreRecord.objects.exists())
        self.assertFalse(
            AuditLog.objects.filter(action_type=AuditLog.ActionType.ENTER_SCORE).exists()
        )

    def test_apply_scores_records_edit_details_and_recalculates(self):
        prepare_round(self.round, self.user)

        apply_scores(self.round, {(self.singer.pk, self.judge.pk): "91"}, self.user)
        apply_scores(self.round, {(self.singer.pk, self.judge.pk): "92.50"}, self.user)

        self.assertEqual(
            ScoreRecord.objects.get(round=self.round, singer=self.singer, judge=self.judge).score,
            Decimal("92.50"),
        )
        audit = (
            AuditLog.objects.filter(action_type=AuditLog.ActionType.ENTER_SCORE)
            .order_by("-pk")
            .first()
        )
        assert audit is not None
        self.assertIn('"old": "91.00"', audit.new_value)
        self.assertIn('"new": "92.50"', audit.new_value)

    def test_parse_score_workbook_reports_late_invalid_cell_without_writing(self):
        second_singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.user,
            name="Second Singer",
            student_id="20260002",
            college="College",
            class_name="Class",
            phone="13800000001",
            song_name="Song 2",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        prepare_round(self.round, self.user)
        workbook = Workbook()
        worksheet = workbook.active
        assert worksheet is not None
        worksheet.append(["选手\\评委", self.judge.name])
        worksheet.append([self.singer.name, 90])
        worksheet.append([second_singer.name, "bad"])
        upload = BytesIO()
        workbook.save(upload)
        upload.seek(0)

        scores, errors = parse_score_workbook(upload, self.round)

        self.assertEqual(scores, {(self.singer.pk, self.judge.pk): Decimal("90")})
        self.assertEqual(len(errors), 1)
        self.assertFalse(ScoreRecord.objects.exists())


class SingerUploadViewTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="applicant", password="pass")
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
        )

    def test_apply_rejects_disallowed_file_without_creating_registration(self):
        self.client.force_login(self.user)

        response = self.client.post(
            reverse("singer_contest:apply"),
            {
                "activity_id": self.activity.pk,
                "name": "Singer",
                "student_id": "20260001",
                "college": "College",
                "class_name": "Class",
                "phone": "13800000000",
                "song_name": "Song",
                "accompaniment": SimpleUploadedFile("song.exe", b"bad"),
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "文件类型")
        self.assertFalse(SingerRegistration.objects.exists())
