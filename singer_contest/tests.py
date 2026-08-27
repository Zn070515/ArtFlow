from decimal import Decimal
from io import BytesIO

from accounts.models import User
from common.models import AuditLog
from core.models import Activity
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.urls import reverse
from openpyxl import Workbook

from .models import ContestRound, Judge, ScoreRecord, SingerRegistration
from .services import (
    apply_scores,
    expected_score_cells,
    missing_score_cells,
    parse_score_workbook,
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

    def test_expected_cells_include_approved_singer_and_active_judge(self):
        self.assertEqual(expected_score_cells(self.round), [(self.singer.pk, self.judge.pk)])

    def test_missing_cells_report_absent_score_record(self):
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
        with self.assertRaises(ValidationError):
            apply_scores(
                self.round,
                {(self.singer.pk, self.judge.pk): "91", (999999, self.judge.pk): "92"},
                self.user,
            )

        self.assertFalse(ScoreRecord.objects.exists())
        self.assertFalse(AuditLog.objects.exists())

    def test_apply_scores_records_edit_details_and_recalculates(self):
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
