from decimal import Decimal
from io import BytesIO

from accounts.models import User
from common.models import AuditLog
from core.models import Activity
from django.contrib import admin
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, transaction
from django.db.models.deletion import ProtectedError
from django.test import RequestFactory, TestCase
from django.urls import reverse
from openpyxl import Workbook

from .admin import ContestRoundAdmin, RoundEntryAdmin, RoundJudgeAdmin
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
    downstream_rounds,
    ensure_round_final_for_advancement,
    expected_score_cells,
    finalize_advancement,
    missing_score_cells,
    parse_score_workbook,
    prepare_round,
    recalculate_round,
    reset_round_snapshots,
    reset_round_to_draft,
    reset_test_round_snapshots,
    validate_score,
)


class ScoringServiceTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="singer", password="pass")
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
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

    def test_round_admin_lists_status_lock_and_snapshot_counts(self):
        RoundEntry.objects.create(round=self.round, singer=self.singer)
        RoundJudge.objects.create(round=self.round, judge=self.judge)
        self.round.status = ContestRound.Status.LOCKED
        self.round.is_locked = True
        self.round.save(update_fields=["status", "is_locked"])

        round_admin = ContestRoundAdmin(ContestRound, admin.site)

        self.assertEqual(
            round_admin.list_display,
            [
                "name",
                "activity",
                "round_type",
                "scoring_mode",
                "status",
                "is_locked",
                "entry_count",
                "judge_count",
            ],
        )
        self.assertEqual(round_admin.entry_count(self.round), 1)
        self.assertEqual(round_admin.judge_count(self.round), 1)
        request = RequestFactory().get("/admin/")
        request.user = self.user
        form = round_admin.get_form(request, self.round)
        self.assertNotIn("status", form.base_fields)
        self.assertNotIn("is_locked", form.base_fields)

    def test_test_round_reset_requires_explicit_opt_in(self):
        self.singer.is_test_data = True
        self.singer.save(update_fields=["is_test_data"])
        RoundEntry.objects.create(round=self.round, singer=self.singer)
        RoundJudge.objects.create(round=self.round, judge=self.judge)
        self.round.status = ContestRound.Status.PREPARED
        self.round.save(update_fields=["status"])

        with self.assertRaisesMessage(
            ValidationError, "Test round reset requires explicit test-only opt-in."
        ):
            reset_test_round_snapshots(
                self.round,
                self.user,
                owned_singer_ids={self.singer.pk},
                owned_judge_ids={self.judge.pk},
            )

        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.PREPARED)
        self.assertTrue(RoundEntry.objects.filter(round=self.round, singer=self.singer).exists())
        self.assertTrue(RoundJudge.objects.filter(round=self.round, judge=self.judge).exists())

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
        round_judge.judge = Judge.objects.create(
            activity=self.activity, name="Prepared Update Judge"
        )

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
        singer = self.make_singer(activity=self.activity, student_id="prepared-qset-update")
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
        entry = RoundEntry.objects.bulk_create([RoundEntry(round=self.round, singer=self.singer)])[
            0
        ]
        round_judge = RoundJudge.objects.bulk_create(
            [RoundJudge(round=self.round, judge=self.judge)]
        )[0]
        singer = self.make_singer(activity=self.activity, student_id="draft-qset-update")
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
        singer = self.make_singer(activity=self.activity, student_id="prepared-base-mgr")
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

    def _lock_scored_round(self, round, singer_count, advance_count):
        for index in range(singer_count):
            self.make_singer(student_id=f"2027{index:04d}")
        if advance_count:
            round.advance_count = advance_count
            round.save(update_fields=["advance_count"])
        prepare_round(round, self.user)
        judge_ids = list(RoundJudge.objects.filter(round=round).values_list("judge_id", flat=True))
        singer_ids = list(
            RoundEntry.objects.filter(round=round).values_list("singer_id", flat=True)
        )
        apply_scores(
            round,
            {
                (singer_id, judge_id): 95 - index
                for index, singer_id in enumerate(singer_ids)
                for judge_id in judge_ids
            },
            self.user,
        )
        round.status = ContestRound.Status.LOCKED
        round.is_locked = True
        round.save(update_fields=["status", "is_locked"])

    def _prepare_boundary_tie_round(self, advance_count=2):
        """Score a round where the last passing score ties the first failing one."""
        self.round.advance_count = advance_count
        self.round.save(update_fields=["advance_count"])
        extras = [self.make_singer(student_id=f"tie{idx}", name=f"Tie {idx}") for idx in range(3)]
        prepare_round(self.round, self.user)
        judge_id = list(
            RoundJudge.objects.filter(round=self.round).values_list("judge_id", flat=True)
        )[0]
        apply_scores(
            self.round,
            {
                (self.singer.pk, judge_id): 95,
                (extras[0].pk, judge_id): 90,
                (extras[1].pk, judge_id): 90,
                (extras[2].pk, judge_id): 80,
            },
            self.user,
        )
        return self.singer, extras[0], extras[1], extras[2]

    def test_advancement_boundary_tie_marks_round_needs_review_and_blocks_downstream(self):
        self._prepare_boundary_tie_round()
        self.round.refresh_from_db()
        self.assertEqual(self.round.advancement_status, ContestRound.AdvancementStatus.NEEDS_REVIEW)

        self.round.status = ContestRound.Status.LOCKED
        self.round.is_locked = True
        self.round.save(update_fields=["status", "is_locked"])
        semifinal = ContestRound.objects.create(
            activity=self.activity, round_type=ContestRound.RoundType.SEMI_FINAL
        )
        with self.assertRaisesMessage(ValidationError, "请先人工核定晋级人选"):
            prepare_round(semifinal, self.user)

    def test_finalize_advancement_records_manual_selection_and_audits(self):
        singer, extra0, extra1, extra2 = self._prepare_boundary_tie_round()
        chosen = [singer.pk, extra0.pk]
        result = finalize_advancement(self.round, chosen, self.user)
        self.assertEqual(result.advancement_status, ContestRound.AdvancementStatus.FINALIZED)
        advanced = set(
            ScoreSummary.objects.filter(round=self.round, is_advanced=True).values_list(
                "singer_id", flat=True
            )
        )
        self.assertEqual(advanced, set(chosen))
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.FINALIZE_ADVANCEMENT,
                operator=self.user,
                target=f"ContestRound:{self.round.pk}",
            ).exists()
        )

    def test_finalize_advancement_rejects_singer_outside_round(self):
        self._prepare_boundary_tie_round()
        outsider = self.make_singer(student_id="outsider")
        with self.assertRaisesMessage(ValidationError, "晋级选手必须属于当前轮次"):
            finalize_advancement(self.round, [outsider.pk], self.user)

    def test_finalize_advancement_rejects_locked_round(self):
        self._prepare_boundary_tie_round()
        self.round.status = ContestRound.Status.LOCKED
        self.round.is_locked = True
        self.round.save(update_fields=["status", "is_locked"])
        with self.assertRaises(PermissionDenied):
            finalize_advancement(self.round, [self.singer.pk], self.user)

    def test_finalize_advancement_rejects_locked_activity(self):
        self._prepare_boundary_tie_round()
        self.activity.is_locked = True
        self.activity.save(update_fields=["is_locked"])
        with self.assertRaises(PermissionDenied):
            finalize_advancement(self.round, [self.singer.pk], self.user)

    def test_finalize_advancement_requires_exact_advance_count(self):
        self._prepare_boundary_tie_round()
        with self.assertRaisesMessage(
            ValidationError, "晋级核定人数必须等于该轮晋级名额（2 人）。"
        ):
            finalize_advancement(self.round, [self.singer.pk], self.user)

    def test_advancement_without_boundary_tie_stays_auto(self):
        self._lock_scored_round(self.round, singer_count=4, advance_count=2)
        self.round.refresh_from_db()
        self.assertEqual(self.round.advancement_status, ContestRound.AdvancementStatus.AUTO)

    def test_prepare_semifinal_round_uses_only_previous_advancers(self):
        self._lock_scored_round(self.round, singer_count=20, advance_count=10)

        semifinal = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
        )
        prepare_round(semifinal, self.user)

        self.assertEqual(RoundEntry.objects.filter(round=semifinal).count(), 10)

    def test_prepare_semifinal_rejects_when_upstream_not_locked(self):
        self._lock_scored_round(self.round, singer_count=5, advance_count=0)
        self.round.status = ContestRound.Status.SCORING
        self.round.is_locked = False
        self.round.save(update_fields=["status", "is_locked"])

        semifinal = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
        )
        with self.assertRaisesMessage(ValidationError, "上游轮次尚未锁定，无法生成后续轮次。"):
            prepare_round(semifinal, self.user)

    def test_ensure_round_final_rejects_unlocked_upstream(self):
        with self.assertRaisesMessage(ValidationError, "上游轮次尚未锁定，无法生成后续轮次。"):
            ensure_round_final_for_advancement(self.round)

    def test_ensure_round_final_rejects_empty_score_matrix(self):
        self.round.status = ContestRound.Status.LOCKED
        self.round.is_locked = True
        self.round.save(update_fields=["status", "is_locked"])

        with self.assertRaisesMessage(ValidationError, "上游轮次没有可用的评分矩阵。"):
            ensure_round_final_for_advancement(self.round)

    def test_downstream_rounds_empty_for_semifinal(self):
        semifinal = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
        )
        self.assertEqual(downstream_rounds(semifinal).count(), 0)

    def test_downstream_rounds_finds_semifinal_for_preliminary(self):
        semifinal = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
        )
        self.assertEqual(list(downstream_rounds(self.round)), [semifinal])

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

    def test_new_global_judge_does_not_change_prepared_matrix(self):
        prepare_round(self.round, self.user)
        new_judge = Judge.objects.create(activity=self.activity, name="Late Judge")

        self.assertEqual(expected_score_cells(self.round), [(self.singer.pk, self.judge.pk)])
        self.assertEqual(
            missing_score_cells(self.round),
            [
                {
                    "singer_id": self.singer.pk,
                    "singer_name": self.singer.name,
                    "judge_id": self.judge.pk,
                    "judge_name": self.judge.name,
                }
            ],
        )
        self.assertNotIn((self.singer.pk, new_judge.pk), expected_score_cells(self.round))

    def test_registration_status_change_does_not_change_prepared_roster(self):
        prepare_round(self.round, self.user)
        self.singer.pre_status = SingerRegistration.PreStatus.SUBMITTED
        self.singer.save(update_fields=["pre_status"])

        self.assertEqual(expected_score_cells(self.round), [(self.singer.pk, self.judge.pk)])
        self.assertEqual(
            missing_score_cells(self.round),
            [
                {
                    "singer_id": self.singer.pk,
                    "singer_name": self.singer.name,
                    "judge_id": self.judge.pk,
                    "judge_name": self.judge.name,
                }
            ],
        )

    def test_recalculate_ignores_score_from_judge_outside_snapshot(self):
        prepare_round(self.round, self.user)
        inactive_judge = Judge.objects.create(
            activity=self.activity, name="Inactive Judge", is_active=False
        )
        ScoreRecord.objects.create(round=self.round, singer=self.singer, judge=self.judge, score=90)
        ScoreRecord.objects.create(
            round=self.round, singer=self.singer, judge=inactive_judge, score=0
        )

        recalculate_round(self.round)

        self.assertEqual(
            ScoreSummary.objects.get(round=self.round, singer=self.singer).average_score,
            Decimal("90"),
        )

    def test_apply_scores_rejects_draft_round(self):
        with self.assertRaisesMessage(ValidationError, "请先准备比赛轮次"):
            apply_scores(
                self.round,
                {(self.singer.pk, self.judge.pk): "90"},
                self.user,
            )

    def test_apply_scores_transitions_prepared_round_to_scoring(self):
        prepare_round(self.round, self.user)

        apply_scores(
            self.round,
            {(self.singer.pk, self.judge.pk): "90"},
            self.user,
        )

        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.SCORING)

    def test_apply_scores_keeps_prepared_round_prepared_when_submission_is_empty(self):
        prepare_round(self.round, self.user)

        apply_scores(self.round, {}, self.user)

        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.PREPARED)

    def test_apply_scores_keeps_prepared_round_prepared_when_scores_are_unchanged(self):
        prepare_round(self.round, self.user)
        ScoreRecord.objects.create(
            round=self.round,
            singer=self.singer,
            judge=self.judge,
            score=90,
            is_test_data=False,
        )

        apply_scores(self.round, {(self.singer.pk, self.judge.pk): "90"}, self.user)

        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.PREPARED)

    def test_apply_scores_rejects_locked_round_status(self):
        prepare_round(self.round, self.user)
        self.round.status = ContestRound.Status.LOCKED
        self.round.is_locked = True
        self.round.save(update_fields=["status", "is_locked"])

        with self.assertRaisesMessage(ValidationError, "该比赛轮次已锁定"):
            apply_scores(
                self.round,
                {(self.singer.pk, self.judge.pk): "90"},
                self.user,
            )

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
        second_user = User.objects.create_user(username="singer-two", password="pass")
        second_singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=second_user,
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

    def test_apply_rejects_duplicate_registration_for_same_user(self):
        self.client.force_login(self.user)
        payload = {
            "activity_id": self.activity.pk,
            "name": "Singer",
            "student_id": "20260001",
            "college": "College",
            "class_name": "Class",
            "phone": "13800000000",
            "song_name": "Song",
        }

        first = self.client.post(reverse("singer_contest:apply"), payload)
        self.assertEqual(first.status_code, 302)

        second = self.client.post(reverse("singer_contest:apply"), payload)
        self.assertEqual(second.status_code, 200)
        self.assertContains(second, "请勿重复提交")
        self.assertEqual(
            SingerRegistration.objects.filter(activity=self.activity, user=self.user).count(), 1
        )

    def test_duplicate_registration_by_student_id_is_rejected_at_db_level(self):
        SingerRegistration.objects.create(
            activity=self.activity,
            user=self.user,
            name="First Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
        )
        other_user = User.objects.create_user(username="applicant-two", password="pass")

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                SingerRegistration.objects.create(
                    activity=self.activity,
                    user=other_user,
                    name="Second Singer",
                    student_id="20260001",
                    college="College",
                    class_name="Class",
                    phone="13800000001",
                    song_name="Song 2",
                )


class RoundResetServiceTests(TestCase):
    def setUp(self):
        self.actor = User.objects.create_user(username="reset-actor", password="pass")
        self.activity = Activity.objects.create(
            title="Test contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=True,
        )
        self.round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
        )
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=User.objects.create_user(username="reset-singer", password="pass"),
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        self.judge = Judge.objects.create(activity=self.activity, name="Judge")

    def _prepare_round_with_scores(self):
        RoundEntry.objects.create(round=self.round, singer=self.singer)
        RoundJudge.objects.create(round=self.round, judge=self.judge)
        ScoreRecord.objects.create(
            round=self.round,
            singer=self.singer,
            judge=self.judge,
            score=Decimal("90.00"),
            is_test_data=True,
        )
        ScoreSummary.objects.create(
            round=self.round,
            singer=self.singer,
            average_score=Decimal("90.000"),
            rank=1,
            is_advanced=True,
            is_test_data=True,
        )
        self.round.status = ContestRound.Status.PREPARED
        self.round.save(update_fields=["status", "is_locked"])

    def test_reset_round_snapshots_returns_test_round_to_draft(self):
        self._prepare_round_with_scores()

        reset_round_snapshots(self.round, self.actor, reason="reset test round")

        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.DRAFT)
        self.assertFalse(self.round.is_locked)
        self.assertFalse(RoundEntry.objects.filter(round=self.round).exists())
        self.assertFalse(RoundJudge.objects.filter(round=self.round).exists())
        self.assertFalse(ScoreRecord.objects.filter(round=self.round).exists())
        self.assertFalse(ScoreSummary.objects.filter(round=self.round).exists())
        self.assertTrue(AuditLog.objects.filter(target=f"ContestRound:{self.round.pk}").exists())

    def test_reset_round_snapshots_rejects_formal_parents_in_test_activity(self):
        self.singer.is_test_data = False
        self.singer.save(update_fields=["is_test_data"])
        self._prepare_round_with_scores()

        with self.assertRaises(ValidationError):
            reset_round_snapshots(self.round, self.actor, reason="reset formal parent")

        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.PREPARED)

    def test_reset_round_to_draft_requires_reason(self):
        self._prepare_round_with_scores()
        with self.assertRaises(ValidationError):
            reset_round_to_draft(self.round, self.actor, reason="  ")

    def test_reset_round_to_draft_rejects_downstream_active(self):
        semifinal = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
            status=ContestRound.Status.PREPARED,
        )
        self._prepare_round_with_scores()

        with self.assertRaises(ValidationError):
            reset_round_to_draft(self.round, self.actor, reason="reset preliminary")

        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.PREPARED)
        self.assertEqual(semifinal.status, ContestRound.Status.PREPARED)

    def test_reset_round_to_draft_resets_prepared_round(self):
        self._prepare_round_with_scores()

        reset_round_to_draft(self.round, self.actor, reason="admin unwind")

        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.DRAFT)
        self.assertFalse(RoundEntry.objects.filter(round=self.round).exists())

    def test_reset_round_to_draft_is_no_op_on_draft_round(self):
        reset_round_to_draft(self.round, self.actor, reason="already draft")
        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.DRAFT)


class ParticipantRegistrationFlowTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="participant", password="pass")
        self.other = User.objects.create_user(username="other", password="pass")
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )

    def make_registration(self, *, user=None, student_id="20260001"):
        return SingerRegistration.objects.create(
            activity=self.activity,
            user=user or self.user,
            name=f"Singer {student_id}",
            student_id=student_id,
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
        )

    def test_my_registrations_lists_all_activities(self):
        other_activity = Activity.objects.create(
            title="Other Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
        )
        self.make_registration(student_id="20260001")
        SingerRegistration.objects.create(
            activity=other_activity,
            user=self.user,
            name="Another",
            student_id="20260002",
            college="College",
            class_name="Class",
            phone="13800000001",
            song_name="Song 2",
        )
        self.client.force_login(self.user)
        response = self.client.get(reverse("singer_contest:my_registrations"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, self.activity.title)
        self.assertContains(response, other_activity.title)

    def test_my_registration_detail_is_user_scoped(self):
        registration = self.make_registration()
        self.client.force_login(self.other)
        response = self.client.get(
            reverse("singer_contest:my_registration_detail", args=[registration.pk])
        )
        self.assertEqual(response.status_code, 404)

    def test_participant_can_edit_own_registration_during_registration_open(self):
        registration = self.make_registration()
        self.client.force_login(self.user)
        response = self.client.post(
            reverse("singer_contest:my_registration_detail", args=[registration.pk]),
            {"phone": "13900000000", "song_name": "New Song"},
        )
        self.assertEqual(response.status_code, 302)
        registration.refresh_from_db()
        self.assertEqual(registration.phone, "13900000000")
        self.assertEqual(registration.song_name, "New Song")
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.UPDATE_REGISTRATION,
                target=f"SingerRegistration:{registration.pk}",
            ).exists()
        )

    def test_participant_cannot_edit_when_phase_is_live(self):
        self.activity.phase = Activity.Phase.LIVE
        self.activity.save()
        registration = self.make_registration()
        self.client.force_login(self.user)
        response = self.client.post(
            reverse("singer_contest:my_registration_detail", args=[registration.pk]),
            {"phone": "13900000000"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "不允许修改报名")
        registration.refresh_from_db()
        self.assertEqual(registration.phone, "13800000000")

    def test_participant_cannot_edit_a_locked_activity(self):
        self.activity.is_locked = True
        self.activity.save()
        registration = self.make_registration()
        self.client.force_login(self.user)
        response = self.client.post(
            reverse("singer_contest:my_registration_detail", args=[registration.pk]),
            {"phone": "13900000000"},
        )
        self.assertEqual(response.status_code, 200)
        registration.refresh_from_db()
        self.assertEqual(registration.phone, "13800000000")
