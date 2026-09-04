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
    CONTEST_ROUND_STATE,
    RULESET_FREEZE,
    STAGE_RESULT_CONFIRM,
    authority_write,
)
from core.models import Activity
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.utils import timezone
from ruleset.models import ContestRuleset, RulesetVersion

from .models import (
    CompositeResult,
    ContestRound,
    Judge,
    ManualDecision,
    RoundEntry,
    RoundJudge,
    SingerRegistration,
    StageDecision,
    StageResult,
)
from .services import _authorized_manual_write, apply_scores, recompute_activity_result


class AuthorityClosureAcceptanceTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="closure", password="pass")
        self.activity = Activity.objects.create(
            title="closure",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
            is_test_mode=True,
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
