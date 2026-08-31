import json
import threading
import time
from decimal import Decimal
from io import BytesIO
from unittest import skipUnless

from accounts.models import User
from common.models import AuditLog
from common.test_data import clear_activity_test_data
from core.models import Activity
from core.policies import ActivityAction
from core.services import lock_activity_for_action
from django.contrib import admin
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import (
    IntegrityError,
    OperationalError,
    close_old_connections,
    connection,
    transaction,
)
from django.db.models.deletion import ProtectedError
from django.test import RequestFactory, TestCase, TransactionTestCase
from django.urls import reverse
from exports.services import build_score_template_workbook
from files.models import MaterialCheck, MaterialRequirement, SubmissionFile
from files.services import review_material_check, store_submission_file
from openpyxl import Workbook
from ruleset.models import ContestRuleset, RulesetVersion
from staff_panel.views import activity_material_requirements

from .admin import ContestRoundAdmin, RoundEntryAdmin, RoundJudgeAdmin
from .models import (
    CompositeResult,
    ContestRound,
    Judge,
    RoundEntry,
    RoundJudge,
    ScoreRecord,
    ScoreSummary,
    SingerRegistration,
    StageDecision,
    StageResult,
)
from .services import (
    apply_scores,
    downstream_rounds,
    ensure_round_final_for_advancement,
    expected_score_cells,
    finalize_advancement,
    lock_round,
    missing_score_cells,
    parse_score_workbook,
    prepare_round,
    recalculate_round,
    reset_round_snapshots,
    reset_round_to_draft,
    reset_test_round_snapshots,
    unlock_round,
    validate_score,
)
from .views import my_registration_detail


class ScoringServiceTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="singer", password="pass")
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
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

    def test_prepare_round_rejects_drop_high_low_with_fewer_than_three_judges(self):
        self.round.scoring_mode = ContestRound.ScoringMode.DROP_HIGH_LOW
        self.round.save()
        Judge.objects.create(activity=self.activity, name="Second Judge")

        with self.assertRaises(ValidationError):
            prepare_round(self.round, self.user)

        self.assertEqual(self.round.status, ContestRound.Status.DRAFT)

    def test_prepare_round_allows_drop_high_low_with_three_judges(self):
        self.round.scoring_mode = ContestRound.ScoringMode.DROP_HIGH_LOW
        self.round.save()
        Judge.objects.create(activity=self.activity, name="Second Judge")
        Judge.objects.create(activity=self.activity, name="Third Judge")

        prepared = prepare_round(self.round, self.user)

        self.assertEqual(prepared.status, ContestRound.Status.PREPARED)

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

    def _parse_workbook(self, workbook):
        upload = BytesIO()
        workbook.save(upload)
        upload.seek(0)
        return parse_score_workbook(upload, self.round)

    def _set_meta(self, workbook, key, value):
        for row in workbook["ArtFlowMeta"].iter_rows():
            if row and row[0].value == key:
                row[1].value = str(value)
                return workbook
        raise AssertionError(f"{key} not found in ArtFlowMeta")

    def _meta_dict(self, workbook):
        data = {}
        for row in workbook["ArtFlowMeta"].iter_rows():
            if row and len(row) >= 2 and row[0].value is not None:
                data[str(row[0].value)] = str(row[1].value) if row[1].value is not None else ""
        return data

    def test_score_template_emits_ids_and_hidden_artflow_meta(self):
        prepare_round(self.round, self.user)
        wb = build_score_template_workbook(self.round)
        ws = wb.active
        assert ws is not None
        self.assertEqual(ws.cell(row=1, column=1).value, "选手ID")
        self.assertEqual(ws.cell(row=1, column=2).value, "姓名")
        self.assertEqual(ws.cell(row=1, column=3).value, f"J{self.judge.pk} {self.judge.name}")
        self.assertEqual(ws.cell(row=2, column=1).value, self.singer.pk)
        self.assertIn("ArtFlowMeta", wb.sheetnames)
        self.assertEqual(wb["ArtFlowMeta"].sheet_state, "hidden")
        self.assertEqual(
            [cell.value for cell in wb["ArtFlowMeta"][1]],
            ["schema_version", "1"],
        )

    def test_parse_score_workbook_uses_id_as_authority(self):
        prepare_round(self.round, self.user)
        wb = build_score_template_workbook(self.round)
        ws = wb.active
        assert ws is not None
        ws.cell(row=2, column=3).value = 91
        scores, errors = self._parse_workbook(wb)
        self.assertEqual(errors, [])
        self.assertEqual(scores, {(self.singer.pk, self.judge.pk): Decimal("91")})

    def test_parse_score_workbook_rejects_wrong_activity(self):
        prepare_round(self.round, self.user)
        other = Activity.objects.create(
            title="Other",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=False,
        )
        wb = build_score_template_workbook(self.round)
        self._set_meta(wb, "activity_id", other.pk)
        scores, errors = self._parse_workbook(wb)
        self.assertEqual(scores, {})
        self.assertTrue(any("其他活动" in error for error in errors))

    def test_parse_score_workbook_rejects_wrong_round(self):
        prepare_round(self.round, self.user)
        wb = build_score_template_workbook(self.round)
        self._set_meta(wb, "round_id", self.round.pk + 1)
        scores, errors = self._parse_workbook(wb)
        self.assertEqual(scores, {})
        self.assertTrue(any("其他轮次" in error for error in errors))

    def test_parse_score_workbook_rejects_singer_outside_round(self):
        prepare_round(self.round, self.user)
        wb = build_score_template_workbook(self.round)
        ws = wb.active
        assert ws is not None
        ws.append([999999, "Ghost", ""])
        scores, errors = self._parse_workbook(wb)
        self.assertEqual(scores, {})
        self.assertTrue(any("不属于当前轮次" in error for error in errors))

    def test_score_template_meta_embeds_snapshot_fingerprint_and_ruleset_version(self):
        prepare_round(self.round, self.user)
        wb = build_score_template_workbook(self.round)
        meta = self._meta_dict(wb)
        self.assertEqual(meta["schema_version"], "1")
        self.assertEqual(meta["activity_id"], str(self.activity.pk))
        self.assertEqual(meta["round_id"], str(self.round.pk))
        self.assertEqual(meta["entry_ids"], str(self.singer.pk))
        self.assertEqual(meta["judge_ids"], str(self.judge.pk))
        self.assertIn("ruleset_version", meta)
        self.assertIn("snapshot_fingerprint", meta)
        self.assertTrue(meta["snapshot_fingerprint"])

    def test_parse_score_workbook_accepts_matching_snapshot(self):
        prepare_round(self.round, self.user)
        wb = build_score_template_workbook(self.round)
        ws = wb.active
        assert ws is not None
        ws.cell(row=2, column=3).value = 88
        scores, errors = self._parse_workbook(wb)
        self.assertEqual(errors, [])
        self.assertEqual(scores, {(self.singer.pk, self.judge.pk): Decimal("88")})

    def test_parse_score_workbook_rejects_stale_entry_snapshot(self):
        prepare_round(self.round, self.user)
        wb = build_score_template_workbook(self.round)
        self._set_meta(wb, "entry_ids", "1,999999")
        scores, errors = self._parse_workbook(wb)
        self.assertEqual(scores, {})
        self.assertTrue(any("选手名单" in error for error in errors))

    def test_parse_score_workbook_rejects_stale_judge_snapshot(self):
        prepare_round(self.round, self.user)
        wb = build_score_template_workbook(self.round)
        self._set_meta(wb, "judge_ids", "1,999999")
        scores, errors = self._parse_workbook(wb)
        self.assertEqual(scores, {})
        self.assertTrue(any("评委名单" in error for error in errors))

    def test_parse_score_workbook_rejects_tampered_fingerprint(self):
        prepare_round(self.round, self.user)
        wb = build_score_template_workbook(self.round)
        self._set_meta(wb, "snapshot_fingerprint", "deadbeef")
        scores, errors = self._parse_workbook(wb)
        self.assertEqual(scores, {})
        self.assertTrue(any("指纹不匹配" in error for error in errors))

    def test_parse_score_workbook_rejects_unsupported_schema_version(self):
        prepare_round(self.round, self.user)
        wb = build_score_template_workbook(self.round)
        self._set_meta(wb, "schema_version", "9")
        scores, errors = self._parse_workbook(wb)
        self.assertEqual(scores, {})
        self.assertTrue(any("schema_version" in error for error in errors))


class SingerUploadViewTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="applicant", password="pass")
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
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

    def test_my_registration_detail_get_does_not_mutate_material_checks(self):
        registration = self.make_registration()
        MaterialCheck.objects.create(
            singer_registration=registration,
            item_name="基本信息",
            status=MaterialCheck.Status.UPLOADED,
            sort_order=0,
        )
        MaterialCheck.objects.create(
            singer_registration=registration,
            item_name="伴奏文件",
            status=MaterialCheck.Status.APPROVED,
            review_note="ok",
            sort_order=2,
        )
        self.client.force_login(self.user)
        before = list(
            registration.material_checks.order_by("pk").values_list(
                "item_name", "status", "sort_order", "review_note"
            )
        )
        response = self.client.get(
            reverse("singer_contest:my_registration_detail", args=[registration.pk])
        )
        self.assertEqual(response.status_code, 200)
        after = list(
            registration.material_checks.order_by("pk").values_list(
                "item_name", "status", "sort_order", "review_note"
            )
        )
        self.assertEqual(before, after)

    def test_archived_activity_get_produces_no_material_check_mutation(self):
        registration = self.make_registration()
        self.activity.phase = Activity.Phase.ARCHIVED
        self.activity.save(update_fields=["phase"])
        self.client.force_login(self.user)
        before = registration.material_checks.count()
        response = self.client.get(
            reverse("singer_contest:my_registration_detail", args=[registration.pk])
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(registration.material_checks.count(), before)

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

    def test_apply_rejects_locked_activity(self):
        self.activity.is_locked = True
        self.activity.save()
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
            },
        )
        self.assertEqual(response.status_code, 403)
        self.assertFalse(SingerRegistration.objects.exists())

    def test_apply_rejects_activity_not_in_registration_open(self):
        self.activity.phase = Activity.Phase.REGISTRATION_CLOSED
        self.activity.save(update_fields=["phase"])
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
            },
        )
        self.assertEqual(response.status_code, 404)
        self.assertFalse(SingerRegistration.objects.exists())


class LockActivityForActionTests(TestCase):
    """The canonical activity-first lock helper re-validates state under the lock."""

    def setUp(self):
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )

    def test_returns_authoritative_activity(self):
        with transaction.atomic():
            locked = lock_activity_for_action(self.activity)
        self.assertEqual(locked.pk, self.activity.pk)
        self.assertFalse(locked.is_locked)

    def test_rejects_locked_activity(self):
        self.activity.is_locked = True
        self.activity.save(update_fields=["is_locked"])
        with transaction.atomic():
            with self.assertRaisesMessage(PermissionDenied, "Activity results are locked."):
                lock_activity_for_action(self.activity)

    def test_rejects_action_not_allowed_in_phase(self):
        self.activity.phase = Activity.Phase.REGISTRATION_CLOSED
        self.activity.save(update_fields=["phase"])
        with transaction.atomic():
            with self.assertRaises(PermissionDenied):
                lock_activity_for_action(self.activity, ActivityAction.SUBMIT_REGISTRATION)


class RoundLockTOCTOUTests(TestCase):
    """M0-P guards: activity-first lock and re-validation of round mutations."""

    def setUp(self):
        self.user = User.objects.create_user(username="round-actor", password="pass")
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        self.round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
        )
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=User.objects.create_user(username="round-singer", password="pass"),
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.judge = Judge.objects.create(activity=self.activity, name="Judge")

    def prepare_matrix(self):
        prepare_round(self.round, self.user)
        apply_scores(self.round, {(self.singer.pk, self.judge.pk): 90}, self.user)
        self.round.status = ContestRound.Status.LOCKED
        self.round.is_locked = True
        self.round.save(update_fields=["status", "is_locked"])

    def test_prepare_round_rejects_locked_activity(self):
        self.activity.is_locked = True
        self.activity.save(update_fields=["is_locked"])
        with self.assertRaisesMessage(PermissionDenied, "Activity results are locked."):
            prepare_round(self.round, self.user)
        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.DRAFT)

    def test_prepare_round_rejects_phase_without_score_authority(self):
        # M0-W: prepare_round must be its own authority — it re-checks the SCORE
        # action policy after acquiring the Activity lock, not before.
        self.activity.phase = Activity.Phase.DRAFT
        self.activity.save(update_fields=["phase"])
        with self.assertRaises(PermissionDenied):
            prepare_round(self.round, self.user)
        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.DRAFT)
        self.assertEqual(self.round.entries.count(), 0)
        self.assertEqual(self.round.round_judges.count(), 0)
        self.assertFalse(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.UPDATE_STATUS,
                target=f"ContestRound:{self.round.pk}",
            ).exists()
        )

    def test_reset_round_to_draft_rejects_locked_activity(self):
        self.round.status = ContestRound.Status.PREPARED
        self.round.save(update_fields=["status"])
        self.activity.is_locked = True
        self.activity.save(update_fields=["is_locked"])
        with self.assertRaisesMessage(PermissionDenied, "活动结果已锁定，无法重置轮次。"):
            reset_round_to_draft(self.round, self.user, reason="admin unwind")
        self.round.refresh_from_db()
        self.assertEqual(self.round.status, ContestRound.Status.PREPARED)

    def test_lock_round_rejects_already_locked_round(self):
        self.round.status = ContestRound.Status.LOCKED
        self.round.is_locked = True
        self.round.save(update_fields=["status", "is_locked"])
        with self.assertRaisesMessage(PermissionDenied, "该比赛轮次已锁定。"):
            lock_round(self.round, self.user)

    def test_lock_round_freezes_complete_round_and_audits(self):
        prepare_round(self.round, self.user)
        apply_scores(self.round, {(self.singer.pk, self.judge.pk): 90}, self.user)
        locked = lock_round(self.round, self.user)
        self.assertTrue(locked.is_locked)
        self.assertEqual(locked.status, ContestRound.Status.LOCKED)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.RELOCK_RESULT,
                target=f"ContestRound:{self.round.pk}",
            ).exists()
        )

    def test_unlock_round_rejects_active_downstream(self):
        self.prepare_matrix()
        ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
            status=ContestRound.Status.PREPARED,
        )
        with self.assertRaisesMessage(
            PermissionDenied, "后续轮次仍在使用本轮结果，解锁前必须先清空后续轮次。"
        ):
            unlock_round(self.round, self.user)
        self.round.refresh_from_db()
        self.assertTrue(self.round.is_locked)

    def test_unlock_round_restores_scoring_state_and_audits(self):
        self.prepare_matrix()
        unlocked = unlock_round(self.round, self.user, note="admin unwind")
        self.assertFalse(unlocked.is_locked)
        self.assertEqual(unlocked.status, ContestRound.Status.SCORING)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.UNLOCK_RESULT,
                target=f"ContestRound:{self.round.pk}",
            ).exists()
        )


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class ActivityFirstLockConcurrencyTests(TransactionTestCase):
    """Concurrent M0-P races must never produce a state the lock order forbids."""

    def setUp(self):
        self.user = User.objects.create_user(username="concurrency-actor", password="pass")
        self.activity = Activity.objects.create(
            title="Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        self.round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
        )
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=User.objects.create_user(username="concurrency-singer", password="pass"),
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.judge = Judge.objects.create(activity=self.activity, name="Judge")

    def _lock_round(self):
        prepare_round(self.round, self.user)
        apply_scores(self.round, {(self.singer.pk, self.judge.pk): 90}, self.user)
        self.round.status = ContestRound.Status.LOCKED
        self.round.is_locked = True
        self.round.save(update_fields=["status", "is_locked"])

    def test_concurrent_unlock_and_downstream_prepare_never_leave_orphan(self):
        self._lock_round()
        semifinal = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.SEMI_FINAL,
        )
        results: dict[str, str] = {}

        def do_unlock():
            close_old_connections()
            try:
                unlock_round(self.round, self.user)
                results["unlock"] = "ok"
            except (PermissionDenied, ValidationError):
                results["unlock"] = "rejected"
            except Exception:
                results["unlock"] = "error"
            finally:
                close_old_connections()

        def do_prepare():
            close_old_connections()
            try:
                prepare_round(semifinal, self.user)
                results["prepare"] = "ok"
            except (PermissionDenied, ValidationError):
                results["prepare"] = "rejected"
            except Exception:
                results["prepare"] = "error"
            finally:
                close_old_connections()

        threads = [threading.Thread(target=do_unlock), threading.Thread(target=do_prepare)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        self.round.refresh_from_db()
        semifinal.refresh_from_db()
        downstream_active = semifinal.status != ContestRound.Status.DRAFT
        orphan = downstream_active and not self.round.is_locked
        self.assertFalse(
            orphan,
            "a PREPARED downstream round cannot coexist with an unlocked upstream",
        )


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class PrepareRoundScoreAuthorityConcurrencyTests(TransactionTestCase):
    """M0-W: a no-SCORE phase commit must prevent prepare_round from landing."""

    def setUp(self):
        self.user = User.objects.create_user(username="prepare-actor", password="pass")
        self.activity = Activity.objects.create(
            title="Prepared Score Authority",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        self.round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
        )
        SingerRegistration.objects.create(
            activity=self.activity,
            user=User.objects.create_user(username="prepare-singer", password="pass"),
            name="Singer",
            student_id="20260001",
            college="College",
            class_name="Class",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        Judge.objects.create(activity=self.activity, name="Judge", is_active=True)

    def test_prepare_never_lands_after_no_score_phase_commits(self):
        phased_held = threading.Event()
        release_lock = threading.Event()
        holder_error: dict[str, object] = {}

        def transition_to_no_score_phase():
            try:
                with transaction.atomic():
                    activity = Activity.objects.select_for_update().get(pk=self.activity.pk)
                    activity.phase = Activity.Phase.REVIEWING
                    activity.save(update_fields=["phase"])
                    phased_held.set()
                    release_lock.wait(timeout=10)
            except Exception as error:  # pragma: no cover - diagnostic only
                holder_error["error"] = error
            finally:
                close_old_connections()

        holder = threading.Thread(target=transition_to_no_score_phase)
        holder.start()
        self.assertTrue(phased_held.wait(timeout=10))

        prepare_result: dict[str, object] = {}

        def try_prepare():
            close_old_connections()
            try:
                prepare_round(self.round, self.user)
                prepare_result["done"] = True
            except PermissionDenied as error:
                prepare_result["rejected"] = str(error)
            except Exception as error:  # pragma: no cover - diagnostic only
                prepare_result["error"] = repr(error)
            finally:
                close_old_connections()

        worker = threading.Thread(target=try_prepare)
        worker.start()
        time.sleep(1)  # let the worker block on the Activity row lock
        release_lock.set()
        holder.join(timeout=10)
        worker.join(timeout=10)

        self.assertFalse(holder_error, holder_error)
        self.activity.refresh_from_db()
        self.round.refresh_from_db()
        self.assertEqual(self.activity.phase, Activity.Phase.REVIEWING)
        self.assertNotIn("done", prepare_result, prepare_result)
        self.assertIn("rejected", prepare_result, prepare_result)
        self.assertEqual(self.round.status, ContestRound.Status.DRAFT)
        self.assertEqual(self.round.entries.count(), 0)
        self.assertEqual(self.round.round_judges.count(), 0)


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class ActivityOwnedMutationBoundaryTests(TransactionTestCase):
    """M0-T: an Activity lock commit must block every activity-owned mutation.

    O1 participant edit, O2 singer review, O3 material-requirement change. Each
    races a live Activity row lock against the mutation and asserts the mutation
    never lands after the lock commits.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="boundary-participant", password="pass")
        self.staff = User.objects.create_user(
            username="boundary-staff", password="pass", role=User.Role.STAFF
        )
        self.activity = Activity.objects.create(
            title="Boundary Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        self.reg = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.user,
            name="Boundary Singer",
            student_id="20260050",
            college="College",
            class_name="Class",
            phone="13800000050",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )

    def test_o1_participant_edit_never_lands_after_activity_lock(self):
        lock_held = threading.Event()
        release_lock = threading.Event()
        holder_error: dict[str, object] = {}

        def hold_activity_lock():
            try:
                with transaction.atomic():
                    activity = Activity.objects.select_for_update().get(pk=self.activity.pk)
                    activity.is_locked = True
                    activity.save(update_fields=["is_locked"])
                    lock_held.set()
                    release_lock.wait(timeout=10)
            except Exception as error:  # pragma: no cover - diagnostic only
                holder_error["error"] = error
            finally:
                close_old_connections()

        holder = threading.Thread(target=hold_activity_lock)
        holder.start()
        self.assertTrue(lock_held.wait(timeout=10))

        edit_result: dict[str, object] = {}

        def try_participant_edit():
            close_old_connections()
            try:
                request = RequestFactory().post("/x", {"phone": "13800000051"})
                request.user = self.user
                my_registration_detail(request, self.reg.pk)
                edit_result["done"] = True
            except Exception as error:  # pragma: no cover - diagnostic only
                edit_result["error"] = repr(error)
            finally:
                close_old_connections()

        editor = threading.Thread(target=try_participant_edit)
        editor.start()
        time.sleep(1)  # let the editor block on the Activity row lock
        release_lock.set()
        holder.join(timeout=10)
        editor.join(timeout=10)

        self.assertFalse(holder_error, holder_error)
        self.activity.refresh_from_db()
        self.reg.refresh_from_db()
        self.assertTrue(self.activity.is_locked)
        self.assertEqual(self.reg.phone, "13800000050")
        self.assertEqual(edit_result.get("done"), True, edit_result)

    def test_o2_singer_review_never_lands_after_activity_lock(self):
        check = MaterialCheck.objects.create(
            singer_registration=self.reg,
            item_name="Accompaniment",
            status=MaterialCheck.Status.UPLOADED,
        )
        lock_held = threading.Event()
        release_lock = threading.Event()
        holder_error: dict[str, object] = {}

        def hold_activity_lock():
            try:
                with transaction.atomic():
                    activity = Activity.objects.select_for_update().get(pk=self.activity.pk)
                    activity.is_locked = True
                    activity.save(update_fields=["is_locked"])
                    lock_held.set()
                    release_lock.wait(timeout=10)
            except Exception as error:  # pragma: no cover - diagnostic only
                holder_error["error"] = error
            finally:
                close_old_connections()

        holder = threading.Thread(target=hold_activity_lock)
        holder.start()
        self.assertTrue(lock_held.wait(timeout=10))

        review_result: dict[str, object] = {}

        def try_review():
            close_old_connections()
            try:
                review_material_check(
                    check,
                    status=MaterialCheck.Status.APPROVED,
                    note="ok",
                    actor=self.staff,
                )
                review_result["done"] = True
            except PermissionDenied:
                review_result["rejected"] = True
            except Exception as error:  # pragma: no cover - diagnostic only
                review_result["error"] = repr(error)
            finally:
                close_old_connections()

        reviewer = threading.Thread(target=try_review)
        reviewer.start()
        time.sleep(1)
        release_lock.set()
        holder.join(timeout=10)
        reviewer.join(timeout=10)

        self.assertFalse(holder_error, holder_error)
        self.activity.refresh_from_db()
        check.refresh_from_db()
        self.assertTrue(self.activity.is_locked)
        self.assertEqual(check.status, MaterialCheck.Status.UPLOADED)
        self.assertEqual(review_result.get("rejected"), True, review_result)

    def test_o3_material_requirement_never_lands_after_activity_lock(self):
        lock_held = threading.Event()
        release_lock = threading.Event()
        holder_error: dict[str, object] = {}

        def hold_activity_lock():
            try:
                with transaction.atomic():
                    activity = Activity.objects.select_for_update().get(pk=self.activity.pk)
                    activity.is_locked = True
                    activity.save(update_fields=["is_locked"])
                    lock_held.set()
                    release_lock.wait(timeout=10)
            except Exception as error:  # pragma: no cover - diagnostic only
                holder_error["error"] = error
            finally:
                close_old_connections()

        holder = threading.Thread(target=hold_activity_lock)
        holder.start()
        self.assertTrue(lock_held.wait(timeout=10))

        mutate_result: dict[str, object] = {}

        def try_mutate_requirements():
            close_old_connections()
            try:
                request = RequestFactory().post(
                    "/x",
                    {
                        "applies_to": MaterialRequirement.AppliesTo.SINGER,
                        "item_name": "New Requirement",
                    },
                )
                request.user = self.staff
                activity_material_requirements(request, self.activity.pk)
                mutate_result["done"] = True
            except PermissionDenied:
                mutate_result["rejected"] = True
            except Exception as error:  # pragma: no cover - diagnostic only
                mutate_result["error"] = repr(error)
            finally:
                close_old_connections()

        mutator = threading.Thread(target=try_mutate_requirements)
        mutator.start()
        time.sleep(1)
        release_lock.set()
        holder.join(timeout=10)
        mutator.join(timeout=10)

        self.assertFalse(holder_error, holder_error)
        self.activity.refresh_from_db()
        self.assertTrue(self.activity.is_locked)
        self.assertFalse(
            MaterialRequirement.objects.filter(
                activity=self.activity, item_name="New Requirement"
            ).exists()
        )
        self.assertEqual(mutate_result.get("rejected"), True, mutate_result)

    def test_o5_test_cleanup_vs_participant_upload_no_deadlock(self):
        test_activity = Activity.objects.create(
            title="Test Cleanup",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
        )
        test_user = User.objects.create_user(username="cleanup-participant", password="pass")
        test_reg = SingerRegistration.objects.create(
            activity=test_activity,
            user=test_user,
            name="Cleanup Singer",
            student_id="20260060",
            college="College",
            class_name="Class",
            phone="13800000060",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        results: dict[str, str] = {}

        def run_cleanup():
            close_old_connections()
            try:
                clear_activity_test_data(test_activity, operator=self.staff)
                results["clear"] = "ok"
            except OperationalError as error:
                results["clear"] = "deadlock" if "deadlock" in str(error).lower() else "error"
            except Exception:
                results["clear"] = "error"
            finally:
                close_old_connections()

        def run_upload():
            close_old_connections()
            try:
                store_submission_file(
                    owner=test_reg,
                    uploaded_file=SimpleUploadedFile("a.mp3", b"x"),
                    purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                    uploaded_by=test_user,
                )
                results["upload"] = "ok"
            except OperationalError as error:
                results["upload"] = "deadlock" if "deadlock" in str(error).lower() else "error"
            except Exception:
                results["upload"] = "error"
            finally:
                close_old_connections()

        threads = [threading.Thread(target=run_cleanup), threading.Thread(target=run_upload)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        self.assertNotEqual(results.get("clear"), "deadlock", results)
        self.assertNotEqual(results.get("upload"), "deadlock", results)


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class RulesetActivityLockConcurrencyTests(TransactionTestCase):
    """R0 §44: ruleset edits/clones serialize on the Activity lock (M0 authority).

    A ruleset mutation must never land after an Activity lock (or ARCHIVED) commits
    — the mutation re-validates the lock inside ``lock_activity_for_action``.
    """

    def setUp(self):
        import json as _json

        from ruleset.models import ContestRuleset, RulesetTemplate, RulesetVersion

        self.admin = User.objects.create_user(
            username="r0-rule-admin", password="pass", role=User.Role.ADMIN
        )
        self.activity = Activity.objects.create(
            title="R0 Ruleset Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="R0规则",
            is_test_data=False,
            created_by=self.admin,
        )
        definition = _json.dumps(
            {
                "schema_version": 1,
                "nodes": [
                    {"key": "assess", "type": "ASSESS", "source": "entry", "round": "r1"},
                    {"key": "ranked", "type": "RANK", "source": "assess", "descending": True},
                ],
            }
        )
        self.version = RulesetVersion.objects.create(
            ruleset=self.ruleset,
            definition=definition,
            version=1,
            is_current=True,
            created_by=self.admin,
        )
        self.template = RulesetTemplate.objects.create(
            name="院十佳", definition=definition, created_by=self.admin
        )

    def _hold_lock(self, *, phase=None, locked=False):
        lock_held = threading.Event()
        release_lock = threading.Event()
        holder_error: dict[str, object] = {}

        def hold():
            try:
                with transaction.atomic():
                    act = Activity.objects.select_for_update().get(pk=self.activity.pk)
                    updated = []
                    if phase is not None:
                        act.phase = phase
                        updated.append("phase")
                    if locked:
                        act.is_locked = True
                        updated.append("is_locked")
                    act.save(update_fields=updated)
                    lock_held.set()
                    release_lock.wait(timeout=10)
            except Exception as error:  # pragma: no cover - diagnostic only
                holder_error["error"] = repr(error)
            finally:
                close_old_connections()

        holder = threading.Thread(target=hold)
        holder.start()
        self.assertTrue(lock_held.wait(timeout=10))
        return holder, release_lock, holder_error

    def test_ruleset_edit_never_lands_after_activity_lock(self):
        from staff_panel.views import ruleset_edit

        holder, release_lock, holder_error = self._hold_lock(locked=True)
        edit_result: dict[str, object] = {}

        def try_edit():
            close_old_connections()
            try:
                request = RequestFactory().post("/x", {"action": "add", "new_type": "ASSESS"})
                request.user = self.admin
                ruleset_edit(request, self.version.pk)
                edit_result["done"] = True
            except PermissionDenied as error:
                edit_result["rejected"] = str(error)
            except Exception as error:  # pragma: no cover - diagnostic only
                edit_result["error"] = repr(error)
            finally:
                close_old_connections()

        worker = threading.Thread(target=try_edit)
        worker.start()
        time.sleep(1)
        release_lock.set()
        holder.join(timeout=10)
        worker.join(timeout=10)

        self.assertFalse(holder_error, holder_error)
        self.activity.refresh_from_db()
        self.version.refresh_from_db()
        self.assertTrue(self.activity.is_locked)
        self.assertNotIn("done", edit_result, edit_result)
        self.assertIn("rejected", edit_result, edit_result)
        nodes = json.loads(self.version.definition)["nodes"]
        self.assertEqual(len(nodes), 2)

    def test_ruleset_clone_never_lands_after_activity_lock(self):
        from staff_panel.views import ruleset_clone_from_template

        holder, release_lock, holder_error = self._hold_lock(locked=True)
        clone_result: dict[str, object] = {}

        def try_clone():
            close_old_connections()
            try:
                request = RequestFactory().post("/x", {"activity": self.activity.pk, "name": "X"})
                request.user = self.admin
                ruleset_clone_from_template(request, self.template.pk)
                clone_result["done"] = True
            except PermissionDenied as error:
                clone_result["rejected"] = str(error)
            except Exception as error:  # pragma: no cover - diagnostic only
                clone_result["error"] = repr(error)
            finally:
                close_old_connections()

        worker = threading.Thread(target=try_clone)
        worker.start()
        time.sleep(1)
        release_lock.set()
        holder.join(timeout=10)
        worker.join(timeout=10)

        self.assertFalse(holder_error, holder_error)
        self.activity.refresh_from_db()
        self.assertTrue(self.activity.is_locked)
        self.assertNotIn("done", clone_result, clone_result)
        self.assertIn("rejected", clone_result, clone_result)


class ParticipantApplyVisibilityTests(TestCase):
    def setUp(self):
        self.participant = User.objects.create_user(username="apply-participant", password="pass")
        self.staff = User.objects.create_user(
            username="apply-staff", password="pass", role=User.Role.STAFF
        )
        self.formal = Activity.objects.create(
            title="Formal Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=False,
        )
        self.testing = Activity.objects.create(
            title="Test Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
        )

    def test_participant_apply_hides_test_activity(self):
        self.client.force_login(self.participant)
        response = self.client.get(reverse("singer_contest:apply"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, self.formal.title)
        self.assertNotContains(response, self.testing.title)

    def test_participant_cannot_submit_to_test_activity(self):
        self.client.force_login(self.participant)
        self.client.raise_request_exception = False
        response = self.client.post(
            reverse("singer_contest:apply"),
            {
                "activity_id": str(self.testing.pk),
                "name": "Intruder",
                "student_id": "20269999",
                "college": "College",
                "class_name": "Class",
                "song_name": "Song",
            },
        )
        self.assertEqual(response.status_code, 404)
        self.assertFalse(SingerRegistration.objects.filter(activity=self.testing).exists())

    def test_staff_apply_can_preview_test_activity(self):
        self.client.force_login(self.staff)
        response = self.client.get(reverse("singer_contest:apply"))
        self.assertContains(response, self.testing.title)

    def test_participant_apply_hides_video_field_for_formal_activity(self):
        self.client.force_login(self.participant)
        response = self.client.get(reverse("singer_contest:apply"))
        self.assertEqual(response.status_code, 200)
        self.assertNotContains(response, "performance_video")

    def test_staff_apply_shows_video_field_for_test_activity(self):
        self.client.force_login(self.staff)
        response = self.client.get(reverse("singer_contest:apply"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "performance_video")

    def test_participant_apply_rejects_oversize_video_for_formal_activity(self):
        self.client.force_login(self.participant)
        response = self.client.post(
            reverse("singer_contest:apply"),
            {
                "activity_id": str(self.formal.pk),
                "name": "Singer",
                "student_id": "20260001",
                "college": "College",
                "class_name": "Class",
                "song_name": "Song",
                "performance_video": SimpleUploadedFile(
                    "clip.mp4", b"x" * (200 * 1024 * 1024), content_type="video/mp4"
                ),
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "正式活动不支持大视频直传。")
        self.assertFalse(SingerRegistration.objects.filter(activity=self.formal).exists())


class StageResultModelTests(TestCase):
    """Characterization of the M1-F result models (StageResult + children)."""

    def setUp(self):
        self.user = User.objects.create_user(username="stage-staff", password="pass")
        self.activity = Activity.objects.create(
            title="院十佳",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
        )
        definition = json.dumps(
            {
                "schema_version": 1,
                "nodes": [
                    {"key": "assess", "type": "ASSESS", "source": "entry", "round": "r1"},
                    {"key": "ranked", "type": "RANK", "source": "assess", "descending": True},
                ],
            }
        )
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity, name="院十佳规则", is_test_data=True
        )
        self.version = RulesetVersion.objects.create(
            ruleset=self.ruleset, definition=definition, is_current=False
        )
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.user,
            name="选手甲",
            student_id="20260001",
            college="学院",
            class_name="班级",
            song_name="歌曲",
        )

    def _result(self, **overrides):
        payload = {
            "activity": self.activity,
            "ruleset_version": self.version,
            "created_by": self.user,
            "stage_key": "院十佳",
            "content_hash": self.version.content_hash,
            "is_test_data": True,
        }
        payload.update(overrides)
        return StageResult.objects.create(**payload)

    def test_stage_result_roundtrips_with_fks(self):
        result = self._result()
        self.assertEqual(result.activity, self.activity)
        self.assertEqual(result.ruleset_version, self.version)
        self.assertEqual(result.status, StageResult.Status.HOLD)
        self.assertTrue(result.content_hash)
        self.assertEqual(result.schema_version, 1)

    def test_children_roundtrip_with_parent(self):
        result = self._result()
        decision = StageDecision.objects.create(
            stage_result=result,
            singer=self.singer,
            outcome_code="direct",
            rank=1,
            score=Decimal("92.46"),
            is_test_data=True,
        )
        composite = CompositeResult.objects.create(
            stage_result=result,
            singer=self.singer,
            node_key="stage2",
            value=Decimal("92.46"),
            components=[
                {"source": "stage1", "weight": "0.6", "value": "88.10", "contribution": "52.86"}
            ],
            is_test_data=True,
        )
        self.assertEqual(result.decisions.get(pk=decision.pk).stage_result, result)
        self.assertEqual(result.composites.get(pk=composite.pk).singer, self.singer)
        self.assertEqual(StageResult.Status.READY, StageResult.Status.READY)

    def test_test_marker_mismatch_rejected(self):
        with self.assertRaises(ValidationError):
            self._result(is_test_data=False)

    def test_child_test_marker_mismatch_rejected(self):
        result = self._result()
        with self.assertRaises(ValidationError):
            StageDecision(
                stage_result=result,
                singer=self.singer,
                outcome_code="direct",
                is_test_data=False,
            ).save()

    def test_reads_immutable_after_ready(self):
        result = self._result()
        # A HOLD result can still be updated to READY.
        StageResult.objects.filter(pk=result.pk).update(status=StageResult.Status.READY)
        # Once READY, further update/delete is blocked.
        with self.assertRaises(ValidationError):
            StageResult.objects.filter(pk=result.pk).update(status=StageResult.Status.HOLD)
        with self.assertRaises(ValidationError):
            StageResult.objects.filter(pk=result.pk).delete()

    def test_child_immutable_when_parent_ready(self):
        result = self._result()
        decision = StageDecision.objects.create(
            stage_result=result,
            singer=self.singer,
            outcome_code="direct",
            rank=1,
            score=Decimal("92.46"),
            is_test_data=True,
        )
        StageResult.objects.filter(pk=result.pk).update(status=StageResult.Status.READY)
        with self.assertRaises(ValidationError):
            StageDecision.objects.filter(pk=decision.pk).update(rank=2)

    def test_unique_activity_stage_key_hash(self):
        self._result()
        with self.assertRaises(IntegrityError):
            self._result()


class StageResolverBindingTests(TestCase):
    """M1-F binder + run_ruleset/persist over a small DB-backed fixture."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="binder-staff", password="pass", role=User.Role.STAFF
        )
        self.activity = Activity.objects.create(
            title="院十佳",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
        )
        definition = json.dumps(
            {
                "schema_version": 1,
                "nodes": [
                    {"key": "assess", "type": "ASSESS", "source": "entry", "round": "r1"},
                    {"key": "ranked", "type": "RANK", "source": "assess", "descending": True},
                ],
            }
        )
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity, name="院十佳规则", is_test_data=True
        )
        self.version = RulesetVersion.objects.create(
            ruleset=self.ruleset,
            definition=definition,
            is_current=True,
            status=RulesetVersion.Status.FROZEN,
        )
        self.round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            name="初赛",
        )
        self.judge = Judge.objects.create(activity=self.activity, name="评委甲")
        self.singers = [self._make_singer(i) for i in range(1, 4)]

    def _make_singer(self, index):
        singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=User.objects.create_user(username=f"binder-s{index}", password="pass"),
            name=f"选手{index}",
            student_id=f"2026100{index}",
            college="学院",
            class_name="班级",
            song_name="歌曲",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        ScoreRecord.objects.create(
            round=self.round,
            singer=singer,
            judge=self.judge,
            score=Decimal(80 + index),
            is_test_data=True,
        )
        return singer

    def test_bind_resolve_input_builds_roster_and_round_scores(self):
        from .services import bind_resolve_input

        inputs = bind_resolve_input(self.version, self.activity, round_keys={"r1": self.round})
        self.assertEqual(inputs.roster, tuple(str(s.pk) for s in self.singers))
        expected = {str(s.pk): (Decimal(80 + i),) for i, s in enumerate(self.singers, 1)}
        self.assertEqual(inputs.round_scores["r1"], expected)
        self.assertEqual(inputs.vote_scores, {})

    def test_run_ruleset_persists_stage_result_and_decisions(self):
        from .services import run_ruleset

        stage = run_ruleset(
            self.version,
            self.activity,
            stage_key="选拔",
            computed_by=self.user,
            round_keys={"r1": self.round},
        )
        self.assertEqual(stage.status, StageResult.Status.READY)
        self.assertEqual(stage.stage_key, "选拔")
        self.assertEqual(stage.ruleset_version, self.version)
        self.assertTrue(stage.content_hash)
        self.assertEqual(stage.plan_version, 1)
        self.assertEqual(stage.decisions.count(), 3)
        self.assertEqual(stage.composites.count(), 0)
        for decision in stage.decisions.all():
            self.assertEqual(decision.outcome_code, "eliminated")
            self.assertIsNotNone(decision.score)

    def test_run_ruleset_rejects_version_from_other_activity(self):
        from .services import run_ruleset

        other = Activity.objects.create(
            title="其他",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
        )
        with self.assertRaises(ValidationError):
            run_ruleset(
                self.version,
                other,
                stage_key="选拔",
                computed_by=self.user,
                round_keys={"r1": self.round},
            )

    def test_run_ruleset_rejects_draft_version(self):
        """A DRAFT ruleset version is not an execution authority (R0 boundary)."""
        from .services import run_ruleset

        draft = RulesetVersion.objects.create(
            ruleset=self.ruleset,
            definition=self.version.definition,
            version=2,
            is_current=False,
            status=RulesetVersion.Status.DRAFT,
        )
        with self.assertRaises(ValidationError):
            run_ruleset(
                draft,
                self.activity,
                stage_key="选拔",
                computed_by=self.user,
                round_keys={"r1": self.round},
            )

    def test_run_ruleset_accepts_frozen_same_activity_version(self):
        from .services import run_ruleset

        stage = run_ruleset(
            self.version,
            self.activity,
            stage_key="选拔",
            computed_by=self.user,
            round_keys={"r1": self.round},
        )
        self.assertEqual(stage.ruleset_version, self.version)
        self.assertEqual(stage.status, StageResult.Status.READY)


def _schidui_definition():
    """§11.3 院十佳 weights (30/60/10, 60/40, 30/50/20) as one forward-only graph."""
    from ruleset.templates import GOLDEN_SCHIDUI

    return GOLDEN_SCHIDUI


def _xiaofeng_definition():
    """§12.5 校十佳屏峰 chain as one forward-only graph (no 2025 special-casing)."""
    from ruleset.templates import GOLDEN_XIAOFENG

    return GOLDEN_XIAOFENG


class GoldenSchiduiDbTests(TestCase):
    """M1-F golden 院十佳 end-to-end: 15 singers through the DB, run_ruleset, verify.

    Scores are deterministic and synthetic (five identical judge scores per round so
    the engine's mean reproduces the target exactly); audience scores are pre-normalized
    Decimals passed as ready values — the binder never re-derives a raw-vote score
    (§16.9). No 2025-value special-casing lives in Python: the weights and the
    15->10->5->3 cutoffs all live in the frozen definition.
    """

    JUDGE_COUNT = 5

    def setUp(self):
        self.admin = User.objects.create_user(
            username="golden-admin", password="pass", role=User.Role.ADMIN
        )
        self.activity = Activity.objects.create(
            title="院十佳",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
        )
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity, name="院十佳规则", is_test_data=True
        )
        self.version = RulesetVersion.objects.create(
            ruleset=self.ruleset,
            definition=_schidui_definition(),
            is_current=True,
            status=RulesetVersion.Status.FROZEN,
        )
        self.judges = [
            Judge.objects.create(activity=self.activity, name=f"评委{chr(0x41 + i)}")
            for i in range(self.JUDGE_COUNT)
        ]
        self.rounds = {}
        for rkey in ("r1", "r2", "r3", "r4"):
            self.rounds[rkey] = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name=rkey,
            )
        self.singers = [self._make_singer(i) for i in range(1, 16)]
        self._seed_scores()

    def _make_singer(self, index):
        return SingerRegistration.objects.create(
            activity=self.activity,
            user=User.objects.create_user(username=f"golden-s{index}", password="pass"),
            name=f"选手{index}",
            student_id=f"2026001{index:02d}",
            college="学院",
            class_name="班级",
            song_name="歌曲",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )

    def _score(self, round_key, singers, scorer):
        for idx, singer in enumerate(singers, 1):
            for judge in self.judges:
                ScoreRecord.objects.create(
                    round=self.rounds[round_key],
                    singer=singer,
                    judge=judge,
                    score=Decimal(scorer(idx)),
                    is_test_data=True,
                )

    def _seed_scores(self):
        # R1/R2: the whole entry roster; R3: top-10 advancees; R4: top-5 advancees.
        self._score("r1", self.singers, lambda i: 100 - i)
        self._score("r2", self.singers, lambda i: 90 - i)
        self._score("r3", self.singers[:10], lambda i: 100 - i)
        self._score("r4", self.singers[:5], lambda i: 100 - i)

    def _vote_scores(self):
        audience1 = {str(s.pk): Decimal("50") for s in self.singers}
        audience4 = {str(self.singers[i].pk): Decimal(90 - (i + 1)) for i in range(5)}
        return {"audience1": audience1, "audience4": audience4}

    def _round_keys(self):
        return dict(self.rounds)

    def test_golden_schidui_end_to_end_ready(self):
        from .services import run_ruleset

        stage = run_ruleset(
            self.version,
            self.activity,
            stage_key="院十佳",
            computed_by=self.admin,
            round_keys=self._round_keys(),
            vote_scores=self._vote_scores(),
        )
        self.assertEqual(stage.status, StageResult.Status.READY)
        self.assertEqual(stage.stage_key, "院十佳")
        self.assertEqual(stage.ruleset_version, self.version)
        self.assertEqual(stage.plan_version, 1)
        self.assertEqual(stage.decisions.count(), 15)

        # Composite scoping is roster-scoped: stage1 all 15, stage2 top-10, final top-5.
        self.assertEqual(stage.composites.filter(node_key="stage1").count(), 15)
        self.assertEqual(stage.composites.filter(node_key="stage2").count(), 10)
        self.assertEqual(stage.composites.filter(node_key="final").count(), 5)

        # Top-3 advance directly; the rest who only reached a lower roster are direct
        # too (origin tag), and those never selected are eliminated.
        by_singer = {d.singer_id: d for d in stage.decisions.all()}
        for idx in range(3):
            decision = by_singer[self.singers[idx].pk]
            self.assertEqual(decision.outcome_code, "direct")
            self.assertEqual(decision.rank, idx + 1)
        for idx in range(3, 10):
            self.assertEqual(by_singer[self.singers[idx].pk].outcome_code, "direct")
        for idx in range(10, 15):
            self.assertEqual(by_singer[self.singers[idx].pk].outcome_code, "eliminated")

    def _composite_map(self, stage, node_key):
        return {c.singer_id: c.value for c in stage.composites.filter(node_key=node_key)}

    def test_golden_schidui_layered_decimals(self):
        from .services import run_ruleset

        stage = run_ruleset(
            self.version,
            self.activity,
            stage_key="院十佳",
            computed_by=self.admin,
            round_keys=self._round_keys(),
            vote_scores=self._vote_scores(),
        )

        # Hand-computed §11.3 values keyed by creation order (pk order).
        stage1 = self._composite_map(stage, "stage1")
        self.assertEqual(stage1[self.singers[0].pk], Decimal("88.1"))
        self.assertEqual(stage1[self.singers[4].pk], Decimal("84.5"))
        self.assertEqual(stage1[self.singers[14].pk], Decimal("75.5"))

        stage2 = self._composite_map(stage, "stage2")
        self.assertEqual(stage2[self.singers[0].pk], Decimal("92.46"))
        self.assertEqual(stage2[self.singers[9].pk], Decimal("84.00"))

        final = self._composite_map(stage, "final")
        self.assertEqual(final[self.singers[0].pk], Decimal("97.0"))
        self.assertEqual(final[self.singers[4].pk], Decimal("93.0"))

    def test_golden_schidui_persisted_result_roundtrip(self):
        from .services import run_ruleset

        stage = run_ruleset(
            self.version,
            self.activity,
            stage_key="院十佳",
            computed_by=self.admin,
            round_keys=self._round_keys(),
            vote_scores=self._vote_scores(),
        )
        self.assertTrue(stage.content_hash)
        self.assertEqual(stage.schema_version, 1)
        self.assertEqual(stage.result_version, 1)
        decision = stage.decisions.first()
        self.assertIsNotNone(decision.singer_id)
        self.assertIsNotNone(decision.score)
        composite = stage.composites.filter(node_key="stage1").first()
        self.assertEqual(len(composite.components), 3)
        self.assertIn("source", composite.components[0])


class GoldenSchiduiXiaofengDbTests(TestCase):
    """M1-G golden 校十佳屏峰 end-to-end (DB-bound).

    20 singers -> 5 initial groups -> top1/group direct (5) -> leftover R1 top12
    -> R2 top7 -> merge 12 -> final groups -> manual 0~2/group -> fill to 6. All
    control flow (counts, groups, quota) lives in the frozen definition; binder and
    run_ruleset are generic. Finalists are read from ``node_values['filled']`` because
    every merged contestant already carries DIRECT/REPECHAGE via first-writer-wins.
    """

    JUDGE_COUNT = 5

    def setUp(self):
        self.admin = User.objects.create_user(
            username="xf-golden-admin", password="pass", role=User.Role.ADMIN
        )
        self.activity = Activity.objects.create(
            title="校十佳屏峰",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
        )
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity, name="校十佳屏峰规则", is_test_data=True
        )
        self.version = RulesetVersion.objects.create(
            ruleset=self.ruleset,
            definition=_xiaofeng_definition(),
            is_current=True,
            status=RulesetVersion.Status.FROZEN,
        )
        self.judges = [
            Judge.objects.create(activity=self.activity, name=f"评委{chr(0x41 + i)}")
            for i in range(self.JUDGE_COUNT)
        ]
        self.rounds = {}
        for rkey in ("r1", "r2"):
            self.rounds[rkey] = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name=rkey,
            )
        self.singers = [self._make_singer(i) for i in range(1, 21)]
        self._seed_scores()

    def _make_singer(self, index):
        return SingerRegistration.objects.create(
            activity=self.activity,
            user=User.objects.create_user(username=f"xf-golden-s{index}", password="pass"),
            name=f"选手{index}",
            student_id=f"2026010{index:02d}",
            college="学院",
            class_name="班级",
            song_name="歌曲",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )

    def _score(self, round_key, singers, scorer):
        for idx, singer in enumerate(singers, 1):
            for judge in self.judges:
                ScoreRecord.objects.create(
                    round=self.rounds[round_key],
                    singer=singer,
                    judge=judge,
                    score=Decimal(scorer(idx)),
                    is_test_data=True,
                )

    def _seed_scores(self):
        self._score("r1", self.singers, lambda i: 100 - i)
        self._score("r2", self.singers, lambda i: 200 - i)

    def _group_of(self):
        initial = {
            str(singer.pk): group
            for group, start in (("G1", 0), ("G2", 4), ("G3", 8), ("G4", 12), ("G5", 16))
            for singer in self.singers[start : start + 4]
        }
        final = {
            str(singer.pk): group
            for group, positions in (
                ("F1", (0, 1, 2, 3)),
                ("F2", (4, 5, 6, 7)),
                ("F3", (8, 9, 12, 16)),
            )
            for position in positions
            for singer in (self.singers[position],)
        }
        return {"initial_group": initial, "final_group": final}

    def _manual(self):
        # F1/F2 full (2 each), F3 short by one -> FILL_TO_QUOTA must pull c13 in.
        return {
            "manual": {
                "F1": (str(self.singers[0].pk), str(self.singers[1].pk)),
                "F2": (str(self.singers[4].pk), str(self.singers[5].pk)),
                "F3": (str(self.singers[8].pk),),
            }
        }

    def test_golden_xiaofeng_end_to_end_ready(self):
        from .services import run_ruleset

        stage = run_ruleset(
            self.version,
            self.activity,
            stage_key="校十佳屏峰",
            computed_by=self.admin,
            round_keys=dict(self.rounds),
            group_of=self._group_of(),
            manual=self._manual(),
        )
        self.assertEqual(stage.status, StageResult.Status.READY)
        self.assertEqual(stage.stage_key, "校十佳屏峰")
        self.assertEqual(stage.ruleset_version, self.version)
        self.assertEqual(stage.plan_version, 1)
        self.assertEqual(stage.decisions.count(), 20)

        by_singer = {d.singer_id: d for d in stage.decisions.all()}
        # 5 direct (top1/group), 12 repechage, 3 never-selected eliminated.
        codes = [d.outcome_code for d in stage.decisions.all()]
        self.assertEqual(codes.count("direct"), 5)
        self.assertEqual(codes.count("repechage"), 12)
        self.assertEqual(codes.count("eliminated"), 3)
        # Direct winners are creation order 1/5/9/13/17, each seated by their global R1 rank.
        for idx, expected_rank in ((0, 1), (4, 5), (8, 9), (12, 13), (16, 17)):
            decision = by_singer[self.singers[idx].pk]
            self.assertEqual(decision.outcome_code, "direct")
            self.assertEqual(decision.rank, expected_rank)
        # Eliminated are the three lowest leftovers: creation order 18/19/20.
        for idx in (17, 18, 19):
            self.assertEqual(by_singer[self.singers[idx].pk].outcome_code, "eliminated")

    def test_golden_xiaofeng_fill_to_quota_finalists(self):
        from .services import run_ruleset

        stage = run_ruleset(
            self.version,
            self.activity,
            stage_key="校十佳屏峰",
            computed_by=self.admin,
            round_keys=dict(self.rounds),
            group_of=self._group_of(),
            manual=self._manual(),
        )
        self.assertEqual(stage.status, StageResult.Status.READY)

        # Re-resolve to inspect the fill GROUP_MAP: F3 was short one and must be topped
        # up from the merged pool (c13). Finalists are read from node_values['filled'].
        from ruleset.resolver import resolve

        result = resolve(self.version.definition, self._resolve_input())
        self.assertEqual(result.status.value, "ready")
        self.assertEqual(
            result.node_values["filled"],
            {
                "F1": [str(self.singers[0].pk), str(self.singers[1].pk)],
                "F2": [str(self.singers[4].pk), str(self.singers[5].pk)],
                "F3": [str(self.singers[8].pk), str(self.singers[12].pk)],
            },
        )
        finalists = [c for group in result.node_values["filled"].values() for c in group]
        self.assertEqual(len(finalists), 6)
        self.assertEqual(len(set(finalists)), 6)

    def _resolve_input(self):
        from .services import bind_resolve_input

        return bind_resolve_input(
            self.version,
            self.activity,
            round_keys=dict(self.rounds),
            group_of=self._group_of(),
            manual=self._manual(),
        )


class RapidEntryServiceTests(TestCase):
    """M1-H rapid-entry backstage: stale-edit version bump + auto re-resolve service."""

    def setUp(self):
        self.admin = User.objects.create_user(
            username="rapid-admin", password="pass", role=User.Role.ADMIN
        )
        self.activity = Activity.objects.create(
            title="录分活动",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
        )
        self.round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            name="r1",
        )
        self.singer = self._make_singer(1)
        self.judge = Judge.objects.create(activity=self.activity, name="评委A")
        RoundEntry.objects.create(round=self.round, singer=self.singer)
        RoundJudge.objects.create(round=self.round, judge=self.judge)
        self.round.status = ContestRound.Status.PREPARED
        self.round.save(update_fields=["status"])

    def _make_singer(self, index):
        return SingerRegistration.objects.create(
            activity=self.activity,
            user=User.objects.create_user(username=f"rapid-s{index}", password="pass"),
            name=f"选手{index}",
            student_id=f"2026m1h{index:02d}",
            college="学院",
            class_name="班级",
            song_name="歌曲",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )

    def test_apply_scores_bumps_score_version(self):
        from .services import apply_scores

        self.assertEqual(self.round.score_version, 0)
        apply_scores(self.round, {(self.singer.pk, self.judge.pk): "95"}, self.admin)
        self.round.refresh_from_db()
        self.assertEqual(self.round.score_version, 1)
        # Re-saving the same value is a no-op and must not bump again.
        apply_scores(self.round, {(self.singer.pk, self.judge.pk): "95"}, self.admin)
        self.round.refresh_from_db()
        self.assertEqual(self.round.score_version, 1)

    def test_recompute_activity_result_persists_ready(self):
        import json

        from ruleset.models import ContestRuleset, RulesetVersion

        from .services import recompute_activity_result

        ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="录分规则",
            is_test_data=True,
            stage_key="院十佳",
            round_keys={"r1": self.round.pk},
        )
        version = RulesetVersion.objects.create(
            ruleset=ruleset,
            definition=json.dumps(
                {
                    "schema_version": 1,
                    "nodes": [
                        {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
                        {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
                        {"key": "top1", "type": "SELECT", "source": "rank1", "count": 1},
                    ],
                }
            ),
            is_current=True,
            status=RulesetVersion.Status.FROZEN,
        )
        # Seed the single cell so the composite resolves (no HOLD).
        from .services import apply_scores

        apply_scores(self.round, {(self.singer.pk, self.judge.pk): "90"}, self.admin)

        stage = recompute_activity_result(self.activity, self.admin, ruleset=ruleset)
        self.assertEqual(stage.stage_key, "院十佳")
        self.assertEqual(stage.status, StageResult.Status.READY)
        self.assertEqual(stage.ruleset_version, version)
        self.assertEqual(stage.decisions.count(), 1)
        decision = stage.decisions.get()
        self.assertEqual(decision.outcome_code, "direct")

    def test_frozen_binding_authoritative_over_ruleset_mutation(self):
        """M1-R1: after freeze, editing the ContestRuleset binding does not change the result.

        A frozen version carries its binding snapshot; the runtime reads it from the
        version, never the still-mutable ContestRuleset round_keys / stage_key.
        """
        import json

        from ruleset.models import ContestRuleset, RulesetVersion

        from .services import apply_scores, recompute_activity_result

        ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="权威规则",
            is_test_data=True,
            stage_key="院十佳",
            round_keys={"r1": self.round.pk},
        )
        version = RulesetVersion.objects.create(
            ruleset=ruleset,
            definition=json.dumps(
                {
                    "schema_version": 1,
                    "nodes": [
                        {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
                        {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
                        {"key": "top1", "type": "SELECT", "source": "rank1", "count": 1},
                    ],
                }
            ),
            is_current=True,
            status=RulesetVersion.Status.FROZEN,
            binding={
                "stage_key": "院十佳",
                "round_keys": {"r1": self.round.pk},
                "announcement_blocks": [],
            },
        )
        apply_scores(self.round, {(self.singer.pk, self.judge.pk): "90"}, self.admin)

        # The frozen version is authoritative: rewriting the ruleset binding must be inert.
        ruleset.stage_key = "篡改赛段"
        ruleset.round_keys = {}
        ruleset.save()

        stage = recompute_activity_result(self.activity, self.admin, ruleset=ruleset)
        self.assertEqual(stage.stage_key, "院十佳")
        self.assertEqual(stage.status, StageResult.Status.READY)
        self.assertEqual(stage.ruleset_version, version)
        self.assertEqual(stage.decisions.count(), 1)
