"""Batch A (M1-CORE-CLOSE) acceptance regression tests.

The reviewer's §四十 requires these regressions before declaring M1 Core CLOSED. Three
(migration-safety) live in ``ruleset/test_migrations.py``; these six cover the ORM and
service guards that keep the formal authority unreachable through Django's ORM:

- ORM cannot manufacture FROZEN/current ``RulesetVersion`` or CONFIRMED ``StageResult``.
- A CONFIRMED ``StageResult`` cannot gain ``StageDecision`` / ``CompositeResult`` children.
- ``ManualDecision`` ``QuerySet`` mutations are sealed behind the formal service.
- Formal publication never overrides the frozen round binding.
"""

import json
from decimal import Decimal

from accounts.models import User
from common.authority import (
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    RULESET_FREEZE,
    STAGE_RESULT_CONFIRM,
    authority_write,
)
from common.models import AuditLog
from core.models import Activity
from django.contrib import admin
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.utils import timezone
from ruleset.models import ContestRuleset, RulesetVersion

from .admin import JudgeAdmin, SingerRegistrationAdmin
from .models import (
    CompositeResult,
    ContestRound,
    Judge,
    ManualDecision,
    RoundEntry,
    RoundJudge,
    ScoreRecord,
    ScoreWriteReceipt,
    SingerRegistration,
    StageDecision,
    StageResult,
)
from .services import (
    IdempotencyConflictError,
    _authorized_manual_write,
    apply_scores,
    apply_scores_if_version,
    recompute_activity_result,
)


class AuthorityClosureAcceptanceTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="closure", password="pass")
        self.activity = Activity.objects.create(
            title="closure",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=True,
        )
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=self.activity.pk).update(
                phase=Activity.Phase.REGISTRATION_OPEN
            )
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity, name="r", is_test_data=True
        )
        with authority_write(RULESET_FREEZE):
            self.version = RulesetVersion.objects.create(
                ruleset=self.ruleset,
                definition='{"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]}',
                is_current=True,
                status=RulesetVersion.Status.FROZEN,
            )
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=User.objects.create_user(username="closure-s", password="pass"),
            name="选手",
            student_id="c01",
            college="学院",
            class_name="班级",
            song_name="歌",
            pre_status=SingerRegistration.PreStatus.APPROVED,
            is_test_data=True,
        )
        self.round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            name="r1",
        )
        self.judge = Judge.objects.create(activity=self.activity, name="评委A")
        RoundEntry.objects.create(round=self.round, singer=self.singer)
        RoundJudge.objects.create(round=self.round, judge=self.judge)
        self.round.status = ContestRound.Status.PREPARED
        with authority_write(CONTEST_ROUND_STATE):
            self.round.save(update_fields=["status"])

    def _confirmed(self):
        result = StageResult.objects.create(
            activity=self.activity,
            ruleset_version=self.version,
            stage_key="s",
            is_test_data=True,
        )
        with authority_write(STAGE_RESULT_CONFIRM):
            StageResult.objects.filter(pk=result.pk).update(  # type: ignore[misc]
                status=StageResult.Status.CONFIRMED,
                confirmed_at=timezone.now(),
                confirmed_by=self.user,
            )
        result.refresh_from_db()
        return result

    # 1. ORM cannot manufacture a FROZEN/current RulesetVersion.
    def test_orm_cannot_manufacture_frozen_current_ruleset_version(self):
        with self.assertRaises(ValidationError):
            RulesetVersion.objects.create(
                ruleset=self.ruleset,
                definition="{}",
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
            )
        with self.assertRaises(ValidationError):
            RulesetVersion.objects.filter(ruleset=self.ruleset).update(
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
            )

    # 2. ORM cannot manufacture a CONFIRMED StageResult.
    def test_orm_cannot_manufacture_confirmed_stageresult(self):
        with self.assertRaises(ValidationError):
            StageResult.objects.create(
                activity=self.activity,
                ruleset_version=self.version,
                stage_key="s",
                status=StageResult.Status.CONFIRMED,
            )
        with self.assertRaises(ValidationError):
            StageResult.objects.filter(activity=self.activity).update(
                status=StageResult.Status.CONFIRMED
            )

    # 3. A CONFIRMED StageResult cannot gain a StageDecision via .objects.create().
    def test_confirmed_cannot_gain_stagedecision_via_create(self):
        result = self._confirmed()
        with self.assertRaises(ValidationError):
            StageDecision.objects.create(
                stage_result=result,
                singer=self.singer,
                outcome_code="direct",
                rank=1,
                score=Decimal("92"),
                is_test_data=True,
            )

    # 4. A CONFIRMED StageResult cannot gain a CompositeResult via .save().
    def test_confirmed_cannot_gain_compositeresult_via_save(self):
        result = self._confirmed()
        with self.assertRaises(ValidationError):
            CompositeResult(
                stage_result=result,
                singer=self.singer,
                node_key="stage2",
                value=Decimal("92"),
                components=[{"source": "stage1", "weight": "1", "value": "92"}],
                is_test_data=True,
            ).save()

    # 5. ManualDecision QuerySet mutations are sealed behind the formal service.
    def test_manualdecision_queryset_mutations_rejected(self):
        with _authorized_manual_write():
            md = ManualDecision.objects.create(
                activity=self.activity,
                ruleset_version=self.version,
                manual_key="manual",
                group="",
                chosen=[str(self.singer.pk)],
                is_test_data=True,
            )
        with self.assertRaises(ValidationError):
            ManualDecision.objects.filter(pk=md.pk).update(group="G2")
        with self.assertRaises(ValidationError):
            ManualDecision.objects.filter(pk=md.pk).delete()
        with self.assertRaises(ValidationError):
            ManualDecision.objects.bulk_create(
                [
                    ManualDecision(
                        activity=self.activity,
                        ruleset_version=self.version,
                        manual_key="manual2",
                        group="",
                        chosen=[],
                        is_test_data=True,
                    )
                ]
            )

    # 6. Formal publication never overrides the frozen round binding.
    def test_formal_recompute_cannot_override_frozen_round_binding(self):
        # Demote the setUp current version, then re-freeze a v2 authority bound to the round
        # (an activity owns exactly one ContestRuleset, so the shared ruleset is reused).
        with authority_write(RULESET_FREEZE):
            RulesetVersion._base_manager.filter(pk=self.version.pk).update(is_current=False)
        self.ruleset.stage_key = "院十佳"
        self.ruleset.round_keys = {"r1": self.round.pk}
        self.ruleset.save(update_fields=["stage_key", "round_keys"])
        definition = json.dumps(
            {
                "schema_version": 1,
                "nodes": [
                    {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
                    {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
                    {"key": "top1", "type": "SELECT", "source": "rank1", "count": 1},
                ],
            }
        )
        with authority_write(RULESET_FREEZE):
            version = RulesetVersion.objects.create(
                ruleset=self.ruleset,
                definition=definition,
                version=2,
                is_current=True,
                status=RulesetVersion.Status.FROZEN,
                binding={
                    "stage_key": "院十佳",
                    "round_keys": {"r1": self.round.pk},
                    "announcement_blocks": [],
                },
            )
        apply_scores(self.round, {(self.singer.pk, self.judge.pk): "90"}, self.user)

        # The override kwarg is gone from the formal publication path.
        with self.assertRaises(TypeError):
            recompute_activity_result(  # type: ignore[call-arg]
                self.activity, self.user, ruleset=self.ruleset, round_keys={"r1": self.round.pk}
            )
        stage = recompute_activity_result(self.activity, self.user, ruleset=self.ruleset)
        self.assertEqual(stage.status, StageResult.Status.READY_TO_CONFIRM)
        self.assertEqual(stage.ruleset_version, version)
        self.assertEqual(stage.stage_key, "院十佳")

    def test_rapid_score_receipt_replays_first_result_without_second_mutation(self):
        """Removing the receipt lookup would create a second score audit/version bump."""
        first = apply_scores_if_version(
            self.round.pk,
            0,
            {(self.singer.pk, self.judge.pk): "90"},
            self.user,
            command_id="receipt-replay-001",
        )
        replay = apply_scores_if_version(
            self.round.pk,
            0,
            {(self.singer.pk, self.judge.pk): "90"},
            self.user,
            command_id="receipt-replay-001",
        )

        self.round.refresh_from_db()
        self.assertEqual(replay, first)
        self.assertEqual(self.round.score_version, 1)
        self.assertEqual(ScoreRecord.objects.filter(round=self.round).count(), 1)
        self.assertEqual(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.ENTER_SCORE,
                target=f"ContestRound:{self.round.pk}",
            ).count(),
            1,
        )
        self.assertEqual(ScoreWriteReceipt.objects.count(), 1)

    def test_rapid_score_receipt_rejects_same_command_with_different_payload(self):
        """Removing the payload hash comparison would permit a command collision to overwrite."""
        apply_scores_if_version(
            self.round.pk,
            0,
            {(self.singer.pk, self.judge.pk): "90"},
            self.user,
            command_id="receipt-conflict-001",
        )

        with self.assertRaisesMessage(IdempotencyConflictError, "IDEMPOTENCY_CONFLICT"):
            apply_scores_if_version(
                self.round.pk,
                0,
                {(self.singer.pk, self.judge.pk): "91"},
                self.user,
                command_id="receipt-conflict-001",
            )

        self.round.refresh_from_db()
        self.assertEqual(self.round.score_version, 1)
        self.assertEqual(ScoreRecord.objects.get(round=self.round).score, Decimal("90"))
        self.assertEqual(ScoreWriteReceipt.objects.count(), 1)

    def test_rapid_score_receipt_replays_after_activity_is_locked(self):
        """Checking mutability before a receipt lookup would turn a safe retry into a failure."""
        first = apply_scores_if_version(
            self.round.pk,
            0,
            {(self.singer.pk, self.judge.pk): "90"},
            self.user,
            command_id="receipt-locked-replay-001",
        )
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=self.activity.pk).update(is_locked=True)

        replay = apply_scores_if_version(
            self.round.pk,
            0,
            {(self.singer.pk, self.judge.pk): "90"},
            self.user,
            command_id="receipt-locked-replay-001",
        )

        self.assertEqual(replay, first)
        self.assertEqual(ScoreWriteReceipt.objects.count(), 1)

    def test_rapid_score_receipt_is_not_persisted_when_score_batch_is_invalid(self):
        """Receipt creation outside the score transaction would leave a false success trace."""
        with self.assertRaises(ValidationError):
            apply_scores_if_version(
                self.round.pk,
                0,
                {
                    (self.singer.pk, self.judge.pk): "90",
                    (999999, self.judge.pk): "91",
                },
                self.user,
                command_id="receipt-atomic-001",
            )

        self.assertFalse(ScoreRecord.objects.filter(round=self.round).exists())
        self.assertFalse(
            AuditLog.objects.filter(action_type=AuditLog.ActionType.ENTER_SCORE).exists()
        )
        self.assertFalse(ScoreWriteReceipt.objects.exists())

    def test_rapid_score_receipt_rejects_replay_by_different_operator(self):
        other_operator = User.objects.create_user(username="closure-other-operator")
        apply_scores_if_version(
            self.round.pk,
            0,
            {(self.singer.pk, self.judge.pk): "90"},
            self.user,
            command_id="receipt-operator-001",
        )

        with self.assertRaisesMessage(IdempotencyConflictError, "IDEMPOTENCY_CONFLICT"):
            apply_scores_if_version(
                self.round.pk,
                0,
                {(self.singer.pk, self.judge.pk): "90"},
                other_operator,
                command_id="receipt-operator-001",
            )

        self.round.refresh_from_db()
        self.assertEqual(self.round.score_version, 1)
        self.assertEqual(ScoreWriteReceipt.objects.get().operator_id, self.user.pk)

    def test_rapid_score_receipt_result_payload_is_bounded(self):
        receipt = ScoreWriteReceipt(
            command_id="receipt-bounded-001",
            operator=self.user,
            operation="rapid_score_apply",
            payload_hash="0" * 64,
            result_version=1,
            result_payload={"unexpected": "x" * 2048},
        )

        with self.assertRaises(ValidationError):
            receipt.full_clean()

    def test_rapid_score_receipt_rejects_unbounded_direct_orm_persistence(self):
        invalid_payload = {"unexpected": "x" * 2048}
        valid_payload = {
            "status": ScoreWriteReceipt.Status.SUCCEEDED,
            "reason_code": "SCORES_APPLIED",
            "version": 1,
            "matrix_complete": True,
        }

        with self.assertRaises(ValidationError):
            ScoreWriteReceipt.objects.create(
                command_id="receipt-direct-create-001",
                operator=self.user,
                operation="rapid_score_apply",
                payload_hash="0" * 64,
                result_version=1,
                result_payload=invalid_payload,
                status=ScoreWriteReceipt.Status.SUCCEEDED,
            )

        receipt = ScoreWriteReceipt.objects.create(
            command_id="receipt-direct-update-001",
            operator=self.user,
            operation="rapid_score_apply",
            payload_hash="1" * 64,
            result_version=1,
            result_payload=valid_payload,
            status=ScoreWriteReceipt.Status.SUCCEEDED,
        )
        with self.assertRaises(ValidationError):
            ScoreWriteReceipt.objects.filter(pk=receipt.pk).update(result_payload=invalid_payload)

        with self.assertRaises(ValidationError):
            ScoreWriteReceipt._base_manager.filter(pk=receipt.pk).update(
                result_payload=invalid_payload
            )

        with self.assertRaises(ValidationError):
            ScoreWriteReceipt.objects.bulk_create(
                [
                    ScoreWriteReceipt(
                        command_id="receipt-direct-bulk-001",
                        operator=self.user,
                        operation="rapid_score_apply",
                        payload_hash="2" * 64,
                        result_version=1,
                        result_payload=invalid_payload,
                        status=ScoreWriteReceipt.Status.SUCCEEDED,
                    )
                ]
            )
        receipt.result_payload = invalid_payload
        with self.assertRaises(ValidationError):
            ScoreWriteReceipt.objects.bulk_update([receipt], ["result_payload"])
        self.assertFalse(
            ScoreWriteReceipt.objects.filter(
                command_id__in=["receipt-direct-create-001", "receipt-direct-bulk-001"]
            ).exists()
        )
        receipt.refresh_from_db()
        self.assertEqual(receipt.result_payload, valid_payload)

    def test_rapid_score_receipt_accepts_legitimate_bulk_status_transition(self):
        valid_payload = {
            "status": ScoreWriteReceipt.Status.SUCCEEDED,
            "reason_code": "SCORES_APPLIED",
            "version": 2,
            "matrix_complete": False,
        }
        receipt = ScoreWriteReceipt.objects.create(
            command_id="receipt-direct-valid-bulk-001",
            operator=self.user,
            operation="rapid_score_apply",
            payload_hash="3" * 64,
            result_version=0,
            result_payload={},
            status=ScoreWriteReceipt.Status.PENDING,
        )

        receipt.result_version = 2
        receipt.result_payload = valid_payload
        receipt.status = ScoreWriteReceipt.Status.SUCCEEDED
        ScoreWriteReceipt.objects.bulk_update(
            [receipt],
            ["result_version", "result_payload", "status"],
        )

        receipt.refresh_from_db()
        self.assertEqual(receipt.status, ScoreWriteReceipt.Status.SUCCEEDED)
        self.assertEqual(receipt.result_payload, valid_payload)
        self.assertEqual(receipt.result_version, 2)

    def test_rapid_score_receipt_rejects_payload_value_semantic_drift(self):
        valid_payload = {
            "status": ScoreWriteReceipt.Status.SUCCEEDED,
            "reason_code": "SCORES_APPLIED",
            "version": 7,
            "matrix_complete": False,
        }
        receipt = ScoreWriteReceipt.objects.create(
            command_id="semantic-valid",
            operator=self.user,
            operation="rapid_score_apply",
            payload_hash="d" * 64,
            result_version=7,
            result_payload=valid_payload,
            status=ScoreWriteReceipt.Status.SUCCEEDED,
        )

        invalid_payloads = (
            {**valid_payload, "status": ScoreWriteReceipt.Status.PENDING},
            {**valid_payload, "reason_code": "STALE_SCORE_VERSION"},
            {**valid_payload, "version": "7"},
            {**valid_payload, "matrix_complete": "false"},
        )
        for index, payload in enumerate(invalid_payloads):
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                ScoreWriteReceipt.objects.create(
                    command_id=f"semantic-invalid-{index}",
                    operator=self.user,
                    operation="rapid_score_apply",
                    payload_hash="e" * 64,
                    result_version=7,
                    result_payload=payload,
                    status=ScoreWriteReceipt.Status.SUCCEEDED,
                )

        with self.assertRaises(ValidationError):
            ScoreWriteReceipt.objects.filter(pk=receipt.pk).update(
                result_payload={**valid_payload, "version": 8}
            )

        with self.assertRaises(ValidationError):
            ScoreWriteReceipt._base_manager.filter(pk=receipt.pk).update(
                result_version=8,
                result_payload=valid_payload,
            )

        receipt.result_version = 8
        with self.assertRaises(ValidationError):
            ScoreWriteReceipt.objects.bulk_update([receipt], ["result_version"])

    def test_rapid_score_receipt_rejects_succeeded_empty_payload_and_pending_result(self):
        with self.assertRaises(ValidationError):
            ScoreWriteReceipt.objects.create(
                command_id="semantic-empty-succeeded",
                operator=self.user,
                operation="rapid_score_apply",
                payload_hash="f" * 64,
                result_version=0,
                result_payload={},
                status=ScoreWriteReceipt.Status.SUCCEEDED,
            )

        with self.assertRaises(ValidationError):
            ScoreWriteReceipt.objects.create(
                command_id="semantic-pending-with-result",
                operator=self.user,
                operation="rapid_score_apply",
                payload_hash="a" * 64,
                result_version=7,
                result_payload={
                    "status": ScoreWriteReceipt.Status.SUCCEEDED,
                    "reason_code": "SCORES_APPLIED",
                    "version": 7,
                    "matrix_complete": False,
                },
                status=ScoreWriteReceipt.Status.PENDING,
            )


class ContestIdentityOwnershipTests(TestCase):
    """A contest identity remains owned by the activity and account that created it."""

    def setUp(self):
        self.user = User.objects.create_user(username="identity-owner", password="pass")
        self.other_user = User.objects.create_user(username="identity-other", password="pass")
        self.activity = Activity.objects.create(
            title="identity-primary",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=True,
        )
        self.other_activity = Activity.objects.create(
            title="identity-secondary",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=True,
        )
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk__in=[self.activity.pk, self.other_activity.pk]).update(
                phase=Activity.Phase.REGISTRATION_OPEN
            )
        self.singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.user,
            name="原选手",
            student_id="identity-01",
            college="学院",
            class_name="班级",
            phone="13000000000",
            song_name="原曲目",
        )
        self.judge = Judge.objects.create(activity=self.activity, name="原评委")
        self.round = ContestRound.objects.create(
            activity=self.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            name="身份归属轮次",
        )
        RoundEntry.objects.create(round=self.round, singer=self.singer)
        RoundJudge.objects.create(round=self.round, judge=self.judge)
        self.round.status = ContestRound.Status.PREPARED
        with authority_write(CONTEST_ROUND_STATE):
            self.round.save(update_fields=["status"])

    def test_instance_save_rejects_singer_and_judge_ownership_changes(self):
        self.singer.activity = self.other_activity
        with self.assertRaises(ValidationError):
            self.singer.save()

        self.singer.refresh_from_db()
        self.singer.user = self.other_user
        with self.assertRaises(ValidationError):
            self.singer.save()

        self.judge.activity = self.other_activity
        with self.assertRaises(ValidationError):
            self.judge.save()

    def test_queryset_update_rejects_singer_and_judge_ownership_changes(self):
        for model, field, value in (
            (SingerRegistration, "activity_id", self.other_activity.pk),
            (SingerRegistration, "user_id", self.other_user.pk),
            (Judge, "activity_id", self.other_activity.pk),
        ):
            with (
                self.subTest(model=model.__name__, field=field),
                self.assertRaises(ValidationError),
            ):
                model.objects.filter(
                    pk=self.singer.pk if model is SingerRegistration else self.judge.pk
                ).update(**{field: value})

    def test_base_manager_update_rejects_singer_and_judge_ownership_changes(self):
        for model, field, value in (
            (SingerRegistration, "activity_id", self.other_activity.pk),
            (SingerRegistration, "user_id", self.other_user.pk),
            (Judge, "activity_id", self.other_activity.pk),
        ):
            with (
                self.subTest(model=model.__name__, field=field),
                self.assertRaises(ValidationError),
            ):
                model._base_manager.filter(
                    pk=self.singer.pk if model is SingerRegistration else self.judge.pk
                ).update(**{field: value})

    def test_bulk_update_rejects_singer_and_judge_ownership_changes(self):
        self.singer.activity = self.other_activity
        with self.assertRaises(ValidationError):
            SingerRegistration.objects.bulk_update([self.singer], ["activity"])

        self.singer.refresh_from_db()
        self.singer.user = self.other_user
        with self.assertRaises(ValidationError):
            SingerRegistration.objects.bulk_update([self.singer], ["user"])

        self.judge.activity = self.other_activity
        with self.assertRaises(ValidationError):
            Judge.objects.bulk_update([self.judge], ["activity"])

    def test_profile_and_judge_active_changes_remain_allowed(self):
        self.singer.name = "更正选手"
        self.singer.phone = "13100000000"
        self.singer.song_name = "更正曲目"
        self.singer.save(update_fields=["name", "phone", "song_name"])
        self.singer.refresh_from_db()
        self.assertEqual(self.singer.name, "更正选手")
        self.assertEqual(self.singer.phone, "13100000000")
        self.assertEqual(self.singer.song_name, "更正曲目")

        self.judge.name = "更正评委"
        self.judge.is_active = False
        self.judge.save(update_fields=["name", "is_active"])
        self.judge.refresh_from_db()
        self.assertEqual(self.judge.name, "更正评委")
        self.assertFalse(self.judge.is_active)

    def test_existing_identity_fields_are_readonly_in_admin(self):
        singer_admin = SingerRegistrationAdmin(SingerRegistration, admin.site)
        judge_admin = JudgeAdmin(Judge, admin.site)
        self.assertEqual(singer_admin.get_readonly_fields(None, self.singer), ("activity", "user"))
        self.assertEqual(judge_admin.get_readonly_fields(None, self.judge), ("activity",))
