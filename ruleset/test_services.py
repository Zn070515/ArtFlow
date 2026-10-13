import json
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    CONTEST_ROUND_STATE,
    RULESET_FREEZE,
    authority_write,
)
from common.models import AuditLog
from core.models import Activity
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import SimpleTestCase, TestCase
from django.utils import timezone
from singer_contest.models import ContestRound, RubricCriterion, ScoringRubric
from voting.models import VoteSession

from ruleset.business_editor import infer_business_stages
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.resolver import ResolveInput, resolve, resolve_to_checkpoint
from ruleset.services import (
    business_round_configuration_signature,
    save_business_ruleset,
    validate_definition_completeness,
)
from ruleset.templates import golden_schidui


class DefinitionCompletenessTests(SimpleTestCase):
    def test_roster_only_definition_is_incomplete(self):
        issues = validate_definition_completeness(
            {
                "schema_version": 1,
                "nodes": [{"key": "roster", "type": "ROSTER"}],
            }
        )

        self.assertEqual({issue.code for issue in issues}, {"RULESET_INCOMPLETE"})

    def test_scoring_graph_without_checkpoints_is_complete_enough(self):
        issues = validate_definition_completeness(
            {
                "schema_version": 1,
                "nodes": [
                    {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
                    {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
                    {"key": "top10", "type": "SELECT", "source": "rank1", "count": 10},
                ],
            }
        )

        self.assertEqual(issues, ())


def _business_stage(**overrides):
    stage = {
        "key": "stage1",
        "name": "初赛",
        "round_key": "r1",
        "round_name": "第一轮",
        "advance_count": 10,
        "judge_weight": "1",
        "previous_weight": "0",
        "audience_weight": "0",
        "vote_source": "",
        "create_round": True,
        "scoring_mode": ContestRound.ScoringMode.AVERAGE,
    }
    stage.update(overrides)
    return stage


class BusinessRulesetSaveTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.operator = User.objects.create_user(
                username="business-editor-admin", password="pass", role=User.Role.ADMIN
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="业务编辑器活动",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_OPEN,
                is_test_mode=True,
            )
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="业务规则",
            is_test_data=True,
            created_by=self.operator,
        )
        self.version = RulesetVersion.objects.create(
            ruleset=self.ruleset,
            definition=json.dumps(
                {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]}
            ),
            created_by=self.operator,
        )

    def test_save_creates_and_binds_an_explicit_draft_round(self):
        old_definition = self.version.definition
        saved = self._save(
            self.version,
            stages=[_business_stage()],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
        )

        round_ = ContestRound.objects.get(activity=self.activity)
        self.assertEqual(round_.status, ContestRound.Status.DRAFT)
        self.assertEqual(round_.advance_count, 10)
        self.ruleset.refresh_from_db()
        self.assertEqual(self.ruleset.round_keys, {"r1": round_.pk})
        self.assertEqual(
            json.loads(saved.definition)["checkpoints"], [{"key": "stage1", "output": "top10"}]
        )
        self.assertTrue(
            AuditLog.objects.filter(target=f"RulesetVersion:{self.version.pk}").exists()
        )
        audit = AuditLog.objects.get(target=f"RulesetVersion:{self.version.pk}")
        self.assertEqual(json.loads(audit.old_value)["definition"], old_definition)
        self.assertEqual(
            json.loads(audit.new_value)["definition"],
            saved.definition,
        )

    def test_save_updates_an_existing_draft_round_configuration(self):
        with authority_write(CONTEST_ROUND_STATE):
            round_ = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="旧名称",
                advance_count=10,
            )
        self.ruleset.round_keys = {"r1": round_.pk}
        self.ruleset.save(update_fields=["round_keys"])

        self._save(
            self.version,
            stages=[
                _business_stage(
                    round_name="更新后的第一轮",
                    advance_count=5,
                    scoring_mode=ContestRound.ScoringMode.DROP_HIGH_LOW,
                    scoring_mode_conflict_ack=True,
                    create_round=False,
                )
            ],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
        )

        round_.refresh_from_db()
        self.assertEqual(round_.name, "更新后的第一轮")
        self.assertEqual(round_.advance_count, 5)
        self.assertEqual(round_.scoring_mode, ContestRound.ScoringMode.DROP_HIGH_LOW)

        audit = AuditLog.objects.get(target=f"RulesetVersion:{self.version.pk}")
        old_value = json.loads(audit.old_value)
        new_value = json.loads(audit.new_value)
        self.assertIn(str(round_.pk), new_value["round_configuration"])
        self.assertEqual(old_value["round_configuration"][str(round_.pk)]["name"], "旧名称")
        self.assertEqual(
            new_value["round_configuration"][str(round_.pk)]["scoring_mode"],
            ContestRound.ScoringMode.DROP_HIGH_LOW,
        )

    def test_business_save_requires_explicit_scoring_mode_conflict_ack(self):
        with authority_write(CONTEST_ROUND_STATE):
            round_ = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="评分模式冲突",
                scoring_mode=ContestRound.ScoringMode.AVERAGE,
            )
        self.ruleset.round_keys = {"r1": round_.pk}
        self.ruleset.save(update_fields=["round_keys"])

        with self.assertRaisesRegex(ValidationError, "明确确认"):
            self._save(
                self.version,
                stages=[
                    _business_stage(
                        scoring_mode=ContestRound.ScoringMode.DROP_HIGH_LOW,
                        create_round=False,
                    )
                ],
                operator=self.operator,
                base_content_hash=self.version.content_hash,
                base_binding=self._binding_signature(),
            )

        self._save(
            self.version,
            stages=[
                _business_stage(
                    scoring_mode=ContestRound.ScoringMode.DROP_HIGH_LOW,
                    scoring_mode_conflict_ack=True,
                    create_round=False,
                )
            ],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
        )
        round_.refresh_from_db()
        self.assertEqual(round_.scoring_mode, ContestRound.ScoringMode.DROP_HIGH_LOW)

    def test_save_refuses_prepared_round_without_mutating_definition(self):
        with authority_write(CONTEST_ROUND_STATE):
            round_ = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="已准备",
                status=ContestRound.Status.PREPARED,
                advance_count=10,
            )
        self.ruleset.round_keys = {"r1": round_.pk}
        self.ruleset.save(update_fields=["round_keys"])
        before = self.version.definition

        with self.assertRaises(PermissionDenied):
            self._save(
                self.version,
                stages=[_business_stage(advance_count=5, create_round=False)],
                operator=self.operator,
                base_content_hash=self.version.content_hash,
                base_binding=self._binding_signature(),
            )

        self.version.refresh_from_db()
        self.assertEqual(self.version.definition, before)

    def test_business_save_refuses_changes_to_a_round_used_by_current_frozen_ruleset(self):
        rubric = ScoringRubric.objects.create(
            activity=self.activity,
            name="旧评分",
        )
        RubricCriterion.objects.create(rubric=rubric, name="演唱", max_score=100)
        with authority_write(CONTEST_ROUND_STATE):
            round_ = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="第一轮",
                judge_count=5,
                minimum_judge_count=4,
                rubric=rubric,
                advance_count=10,
                roster_source=ContestRound.RosterSource.APPROVED,
            )
        self.ruleset.round_keys = {"r1": round_.pk}
        self.ruleset.save(update_fields=["round_keys"])
        with authority_write(RULESET_FREEZE):
            self.version.status = RulesetVersion.Status.FROZEN
            self.version.is_current = True
            self.version.binding = {"round_keys": {"r1": round_.pk}}
            self.version.save(update_fields=["status", "is_current", "binding"])
        successor = RulesetVersion.objects.create(
            ruleset=self.ruleset,
            version=2,
            definition=self.version.definition,
            created_by=self.operator,
        )

        changed_source = {
            "round_key": "r1",
            "round_name": "第一轮",
            "weight": "1",
            "scoring_mode": ContestRound.ScoringMode.AVERAGE,
            "source": "entry",
            "source_stage_key": "entry",
            "format": "solo",
            "judge_count": 6,
            "minimum_judge_count": 5,
            "rubric": {"name": "新评分"},
            "round_id": round_.pk,
            "create_round": False,
        }
        before_definition = successor.definition

        with self.assertRaises(PermissionDenied):
            self._save(
                successor,
                stages=[_business_stage(advance_count=10, judge_sources=[changed_source])],
                operator=self.operator,
                base_content_hash=successor.content_hash,
                base_binding=self._binding_signature(),
            )

        round_.refresh_from_db()
        successor.refresh_from_db()
        self.assertEqual(round_.judge_count, 5)
        self.assertEqual(round_.minimum_judge_count, 4)
        self.assertEqual(round_.rubric_id, rubric.pk)
        self.assertEqual(successor.definition, before_definition)

    def test_stale_hashes_reject_the_whole_business_save(self):
        with self.assertRaises(ValidationError):
            self._save(
                self.version,
                stages=[_business_stage()],
                operator=self.operator,
                base_content_hash="0" * 64,
                base_binding=self._binding_signature(),
            )
        self.assertFalse(ContestRound.objects.filter(activity=self.activity).exists())

    def test_stale_binding_rejects_the_whole_business_save(self):
        from ruleset.services import _binding_signature

        stale_binding = _binding_signature(self.ruleset)
        self.ruleset.stage_key = "changed-elsewhere"
        self.ruleset.save(update_fields=["stage_key"])

        with self.assertRaises(ValidationError):
            self._save(
                self.version,
                stages=[_business_stage()],
                operator=self.operator,
                base_content_hash=self.version.content_hash,
                base_binding=stale_binding,
            )
        self.assertFalse(ContestRound.objects.filter(activity=self.activity).exists())

    def test_business_save_requires_all_compare_and_swap_baselines(self):
        with self.assertRaises(ValidationError):
            save_business_ruleset(
                self.version,
                stages=[_business_stage()],
                operator=self.operator,
                base_content_hash=self.version.content_hash,
                base_binding=self._binding_signature(),
            )

        self.assertFalse(ContestRound.objects.filter(activity=self.activity).exists())

    def test_business_save_refuses_a_lossy_existing_definition(self):
        root = json.loads(self.version.definition)
        root["nodes"] = [
            {
                "key": "assess_r1",
                "type": "ASSESS",
                "source": "entry",
                "round": "r1",
                "min_judges": 3,
            },
            {
                "key": "score",
                "type": "AGGREGATE",
                "within": "entry",
                "aggregate": {
                    "type": "weighted_sum",
                    "components": [{"source": "assess_r1", "weight": 1}],
                },
            },
            {"key": "rank", "type": "RANK", "source": "score", "descending": True},
            {"key": "top1", "type": "SELECT", "source": "rank", "count": 1},
        ]
        root["checkpoints"] = [{"key": "stage1", "output": "top1"}]
        self.version.definition = json.dumps(root)
        self.version.save(update_fields=["definition"])

        with self.assertRaises(ValidationError):
            self._save(
                self.version,
                stages=[_business_stage()],
                operator=self.operator,
                base_content_hash=self.version.content_hash,
                base_binding=self._binding_signature(),
            )

        self.assertFalse(ContestRound.objects.filter(activity=self.activity).exists())

    def test_business_save_can_clear_all_stages_to_a_valid_blank_definition(self):
        self._save(
            self.version,
            stages=[_business_stage()],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
        )
        self.version.refresh_from_db()
        self.ruleset.refresh_from_db()

        self._save(
            self.version,
            stages=[],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
        )

        self.version.refresh_from_db()
        root = json.loads(self.version.definition)
        self.assertEqual(root["nodes"], [{"key": "roster", "type": "ROSTER"}])
        self.assertNotIn("checkpoints", root)

    def test_business_save_remaps_changed_quota_in_historical_roster_source(self):
        with authority_write(CONTEST_ROUND_STATE):
            first = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="第一轮",
                advance_count=10,
            )
            second = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.SEMI_FINAL,
                name="第二轮",
                advance_count=3,
            )
        self.ruleset.round_keys = {"r1": first.pk, "r2": second.pk}
        self.ruleset.save(update_fields=["round_keys"])
        self.version.definition = json.dumps(
            {
                "schema_version": 1,
                "nodes": [
                    {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
                    {
                        "key": "stage1",
                        "type": "AGGREGATE",
                        "within": "entry",
                        "aggregate": {
                            "type": "weighted_sum",
                            "components": [{"source": "assess_r1", "weight": 1}],
                        },
                    },
                    {"key": "rank1", "type": "RANK", "source": "stage1", "descending": True},
                    {"key": "top10", "type": "SELECT", "source": "rank1", "count": 10},
                    {"key": "assess_r2", "type": "ASSESS", "source": "top10", "round": "r2"},
                    {
                        "key": "stage2",
                        "type": "AGGREGATE",
                        "within": "top10",
                        "aggregate": {
                            "type": "weighted_sum",
                            "components": [
                                {"source": "stage1", "weight": 0.5},
                                {"source": "assess_r2", "weight": 0.5},
                            ],
                        },
                    },
                    {"key": "rank2", "type": "RANK", "source": "stage2", "descending": True},
                    {"key": "top3", "type": "SELECT", "source": "rank2", "count": 3},
                ],
                "checkpoints": [
                    {"key": "stage1", "output": "top10"},
                    {"key": "stage2", "output": "top3"},
                ],
            },
            ensure_ascii=False,
        )
        self.version.save(update_fields=["definition"])
        projection = infer_business_stages(self.version.definition)
        projection["stages"][0]["advance_count"] = 8

        saved = self._save(
            self.version,
            stages=projection["stages"],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
        )

        generated = json.loads(saved.definition)
        self.assertEqual(generated["checkpoints"][0]["output"], "top8")
        self.assertNotIn(
            "top10",
            [node.get("source") for node in generated["nodes"] if node["type"] == "ASSESS"],
        )

    def test_historical_save_preserves_existing_round_name_without_rename_request(self):
        with authority_write(CONTEST_ROUND_STATE):
            round_ = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="历史轮次名称",
                advance_count=10,
                roster_source=ContestRound.RosterSource.APPROVED,
            )
        self.ruleset.round_keys = {"r1": round_.pk}
        self.ruleset.save(update_fields=["round_keys"])

        self._save(
            self.version,
            stages=[_business_stage(round_name="", create_round=False)],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
        )

        round_.refresh_from_db()
        self.assertEqual(round_.name, "历史轮次名称")

    def test_same_round_rejects_conflicting_scoring_modes(self):
        with authority_write(CONTEST_ROUND_STATE):
            round_ = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="共享评分轮次",
            )
        self.ruleset.round_keys = {"r1": round_.pk}
        self.ruleset.save(update_fields=["round_keys"])

        with self.assertRaises(ValidationError):
            self._save(
                self.version,
                stages=[
                    _business_stage(round_name="", create_round=False),
                    _business_stage(
                        key="stage2",
                        round_name="",
                        advance_count=3,
                        round_key="r1",
                        scoring_mode=ContestRound.ScoringMode.DROP_HIGH_LOW,
                        create_round=False,
                    ),
                ],
                operator=self.operator,
                base_content_hash=self.version.content_hash,
                base_binding=self._binding_signature(),
            )

        round_.refresh_from_db()
        self.assertEqual(round_.scoring_mode, ContestRound.ScoringMode.AVERAGE)

    def test_successor_business_save_cannot_change_round_used_by_current_frozen_version(self):
        with authority_write(CONTEST_ROUND_STATE):
            round_ = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="正式轮次",
                advance_count=10,
                roster_source=ContestRound.RosterSource.APPROVED,
            )
        self.ruleset.round_keys = {"r1": round_.pk}
        self.ruleset.save(update_fields=["round_keys"])
        with authority_write(RULESET_FREEZE):
            RulesetVersion.objects.create(
                ruleset=self.ruleset,
                version=2,
                definition=self.version.definition,
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
                binding={"round_keys": {"r1": round_.pk}},
            )

        before_definition = self.version.definition
        with self.assertRaises(PermissionDenied):
            self._save(
                self.version,
                stages=[_business_stage(round_name="", advance_count=5, create_round=False)],
                operator=self.operator,
                base_content_hash=self.version.content_hash,
                base_binding=self._binding_signature(),
            )

        self.version.refresh_from_db()
        round_.refresh_from_db()
        self.assertEqual(self.version.definition, before_definition)
        self.assertEqual(round_.advance_count, 10)

        self._save(
            self.version,
            stages=[_business_stage(round_name="", advance_count=10, create_round=False)],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
        )

    def test_business_save_rejects_stale_round_configuration_snapshot(self):
        with authority_write(CONTEST_ROUND_STATE):
            round_ = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="并发轮次",
                advance_count=10,
            )
        self.ruleset.round_keys = {"r1": round_.pk}
        self.ruleset.save(update_fields=["round_keys"])
        base_round_configuration = business_round_configuration_signature(
            ContestRound.objects.filter(activity=self.activity)
        )

        with authority_write(CONTEST_ROUND_STATE):
            round_.scoring_mode = ContestRound.ScoringMode.DROP_HIGH_LOW
            round_.save(update_fields=["scoring_mode"])

        with self.assertRaises(ValidationError):
            save_business_ruleset(
                self.version,
                stages=[_business_stage(create_round=False)],
                operator=self.operator,
                base_content_hash=self.version.content_hash,
                base_binding=self._binding_signature(),
                base_round_configuration=base_round_configuration,
            )

    def test_unrelated_prepared_round_does_not_block_a_new_business_round(self):
        with authority_write(CONTEST_ROUND_STATE):
            unrelated = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                status=ContestRound.Status.PREPARED,
                name="高级编辑器轮次",
            )
        self.ruleset.round_keys = {"advanced": unrelated.pk}
        self.ruleset.save(update_fields=["round_keys"])

        self._save(
            self.version,
            stages=[_business_stage()],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
        )

        unrelated.refresh_from_db()
        self.assertEqual(unrelated.status, ContestRound.Status.PREPARED)
        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), 2)

    def test_unrelated_draft_round_configuration_change_does_not_block_business_save(self):
        with authority_write(CONTEST_ROUND_STATE):
            unrelated = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="高级编辑器草稿轮次",
                advance_count=20,
            )
        self.ruleset.round_keys = {"advanced": unrelated.pk}
        self.ruleset.save(update_fields=["round_keys"])
        base_round_configuration = business_round_configuration_signature(
            ContestRound.objects.filter(activity=self.activity)
        )

        with authority_write(CONTEST_ROUND_STATE):
            unrelated.advance_count = 18
            unrelated.save(update_fields=["advance_count"])

        self._save(
            self.version,
            stages=[_business_stage()],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
            base_round_configuration=base_round_configuration,
        )

    def test_create_round_rejects_an_existing_round_key(self):
        with authority_write(CONTEST_ROUND_STATE):
            existing = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="已有轮次",
            )
        self.ruleset.round_keys = {"r1": existing.pk}
        self.ruleset.save(update_fields=["round_keys"])
        before_definition = self.version.definition
        with self.assertRaises(ValidationError):
            self._save(
                self.version,
                stages=[_business_stage(create_round=True)],
                operator=self.operator,
                base_content_hash=self.version.content_hash,
                base_binding=self._binding_signature(),
                base_round_configuration=business_round_configuration_signature(
                    ContestRound.objects.filter(activity=self.activity)
                ),
            )

        self.version.refresh_from_db()
        self.assertEqual(self.version.definition, before_definition)
        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), 1)

    def test_business_save_rejects_middle_stage_structure_change(self):
        from ruleset.business_editor import business_definition_from_stages

        initial_stages = [
            _business_stage(create_round=False),
            _business_stage(key="stage2", round_key="r2", round_name="第二轮", create_round=False),
            _business_stage(key="stage3", round_key="r3", round_name="第三轮", create_round=False),
        ]
        nodes, checkpoints, _context = business_definition_from_stages(initial_stages)
        self.version.definition = json.dumps(
            {
                "schema_version": 1,
                "nodes": nodes,
                "checkpoints": checkpoints,
                "context": {
                    "business": {
                        "stages": [initial_stages[0]],
                    }
                },
            },
            ensure_ascii=False,
        )
        self.version.save(update_fields=["definition"])
        with authority_write(CONTEST_ROUND_STATE):
            first = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="第一轮",
            )
            second = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.SEMI_FINAL,
                name="第二轮",
            )
            third = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.SEMI_FINAL,
                name="第三轮",
            )
        self.ruleset.round_keys = {"r1": first.pk, "r2": second.pk, "r3": third.pk}
        self.ruleset.save(update_fields=["round_keys"])
        inserted = _business_stage(
            key="inserted",
            round_key="r-new",
            round_name="插入轮次",
        )

        with self.assertRaises(ValidationError):
            self._save(
                self.version,
                stages=[initial_stages[0], inserted, initial_stages[1], initial_stages[2]],
                operator=self.operator,
                base_content_hash=self.version.content_hash,
                base_binding=self._binding_signature(),
                base_round_configuration=business_round_configuration_signature(
                    ContestRound.objects.filter(activity=self.activity)
                ),
            )

    def test_new_round_uses_entry_source_for_roster_configuration(self):
        self._save(
            self.version,
            stages=[
                _business_stage(),
                _business_stage(
                    key="stage2",
                    round_key="r2",
                    round_name="第二轮",
                    source_stage_key="entry",
                ),
            ],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
        )

        self.ruleset.refresh_from_db()
        round_ = ContestRound.objects.get(pk=self.ruleset.round_keys["r2"])
        self.version.refresh_from_db()
        definition = json.loads(self.version.definition)
        assess = next(node for node in definition["nodes"] if node.get("round") == "r2")
        self.assertEqual(assess["source"], "entry")
        self.assertEqual(round_.roster_source, ContestRound.RosterSource.APPROVED)
        self.assertEqual(round_.roster_source_stage, "")

    def test_new_round_uses_explicit_stage_source_for_roster_configuration(self):
        self._save(
            self.version,
            stages=[
                _business_stage(),
                _business_stage(key="stage2", round_key="r2", round_name="第二轮"),
                _business_stage(
                    key="stage3",
                    round_key="r3",
                    round_name="第三轮",
                    source_stage_key="stage1",
                ),
            ],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
        )

        self.ruleset.refresh_from_db()
        round_ = ContestRound.objects.get(pk=self.ruleset.round_keys["r3"])
        self.assertEqual(round_.roster_source, ContestRound.RosterSource.STAGE)
        self.assertEqual(round_.roster_source_stage, "stage1")

    def test_repeated_round_reference_has_one_configuration_owner(self):
        with authority_write(CONTEST_ROUND_STATE):
            round_ = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="共享轮次",
            )
        self.ruleset.round_keys = {"r3": round_.pk}
        self.ruleset.save(update_fields=["round_keys"])

        self._save(
            self.version,
            stages=[
                _business_stage(key="stage1", round_key="r3", advance_count=5, create_round=False),
                _business_stage(key="stage2", round_key="r3", advance_count=3, create_round=False),
            ],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
        )

        round_.refresh_from_db()
        self.assertEqual(round_.advance_count, 5)
        self.assertEqual(round_.roster_source, ContestRound.RosterSource.APPROVED)
        self.assertEqual(round_.roster_source_stage, "")

    def test_same_round_id_cannot_be_reused_by_different_round_keys(self):
        with authority_write(CONTEST_ROUND_STATE):
            round_ = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="重复绑定",
            )

        with self.assertRaises(ValidationError):
            self._save(
                self.version,
                stages=[
                    _business_stage(
                        key="stage1", round_key="r1", round_id=round_.pk, create_round=False
                    ),
                    _business_stage(
                        key="stage2", round_key="r2", round_id=round_.pk, create_round=False
                    ),
                ],
                operator=self.operator,
                base_content_hash=self.version.content_hash,
                base_binding=self._binding_signature(),
            )

    def _binding_signature(self):
        from ruleset.services import _binding_signature

        return _binding_signature(self.ruleset)

    def _save(self, *args, **kwargs):
        kwargs.setdefault(
            "base_round_configuration",
            business_round_configuration_signature(
                ContestRound.objects.filter(activity=self.activity)
            ),
        )
        return save_business_ruleset(*args, **kwargs)

    def test_definition_validation_rolls_back_created_round_and_binding(self):
        from ruleset.business_editor import business_definition_from_stages

        _, _, context = business_definition_from_stages([_business_stage()])
        with patch(
            "ruleset.services.business_definition_from_stages",
            return_value=(
                [{"key": "broken", "type": "RANK", "source": "missing"}],
                [{"key": "stage1", "output": "broken"}],
                context,
            ),
        ):
            with self.assertRaises(ValidationError):
                self._save(
                    self.version,
                    stages=[_business_stage()],
                    operator=self.operator,
                    base_content_hash=self.version.content_hash,
                    base_binding=self._binding_signature(),
                )

        self.assertFalse(ContestRound.objects.filter(activity=self.activity).exists())
        self.ruleset.refresh_from_db()
        self.assertEqual(self.ruleset.round_keys, {})

    def test_business_save_preserves_unowned_context_and_questionnaire(self):
        root = json.loads(self.version.definition)
        root["context"] = {
            "business": {"legacy_flag": "keep", "other": {"x": 1}},
            "audience_rule": "keep",
        }
        root["questionnaire"] = {
            "schema_version": 1,
            "key": "q",
            "pages": [
                {
                    "key": "basic",
                    "title": "基本信息",
                    "sections": [
                        {
                            "key": "identity",
                            "title": "身份",
                            "questions": [{"key": "name", "type": "text", "label": "姓名"}],
                        }
                    ],
                }
            ],
        }
        self.version.definition = json.dumps(root, ensure_ascii=False)
        self.version.save(update_fields=["definition"])

        self._save(
            self.version,
            stages=[_business_stage()],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=self._binding_signature(),
        )

        self.version.refresh_from_db()
        stored = json.loads(self.version.definition)
        self.assertEqual(stored["context"]["audience_rule"], "keep")
        self.assertEqual(stored["context"]["business"]["legacy_flag"], "keep")
        self.assertEqual(stored["context"]["business"]["other"], {"x": 1})
        self.assertEqual(stored["questionnaire"], root["questionnaire"])

    def test_golden_business_round_trip_preserves_results_bindings_rosters_and_checkpoints(self):
        with authority_write(CONTEST_ROUND_STATE):
            rounds = {
                key: ContestRound.objects.create(
                    activity=self.activity,
                    round_type=(
                        ContestRound.RoundType.PRELIMINARY
                        if key == "r1"
                        else ContestRound.RoundType.SEMI_FINAL
                    ),
                    name=f"{key}正式名称",
                    advance_count=count,
                    roster_source=(
                        ContestRound.RosterSource.APPROVED
                        if key in {"r1", "r2"}
                        else ContestRound.RosterSource.STAGE
                    ),
                    roster_source_stage={"r3": "stage1", "r4": "stage2"}.get(key, ""),
                )
                for key, count in (("r1", 10), ("r2", 10), ("r3", 5), ("r4", 3))
            }
        start = timezone.now()
        votes = {
            key: VoteSession.objects.create(
                activity=self.activity,
                name=key,
                start_time=start,
                end_time=start + timedelta(hours=1),
                purpose=VoteSession.Purpose.SCORE_COMPONENT,
                is_test_data=True,
            )
            for key in ("audience1", "audience4")
        }
        self.ruleset.round_keys = {key: round_.pk for key, round_ in rounds.items()}
        self.ruleset.vote_keys = {key: vote.pk for key, vote in votes.items()}
        self.ruleset.save(update_fields=["round_keys", "vote_keys"])
        original_definition = golden_schidui()
        self.version.definition = original_definition
        self.version.save(update_fields=["definition"])
        original_binding = self._binding_signature()
        original_rounds = {
            key: (
                round_.name,
                round_.scoring_mode,
                round_.roster_source,
                round_.roster_source_stage,
                round_.advance_count,
            )
            for key, round_ in rounds.items()
        }
        contestants = tuple(f"c{index}" for index in range(1, 16))
        inputs = ResolveInput(
            roster=contestants,
            round_scores={
                key: {
                    contestant: (Decimal(str(value)),)
                    for contestant, value in zip(contestants, values)
                }
                for key, values in {
                    "r1": tuple(100 - index for index in range(15)),
                    "r2": tuple(95 - index for index in range(15)),
                    "r3": tuple(90 - index for index in range(15)),
                    "r4": tuple(85 - index for index in range(15)),
                }.items()
            },
            vote_scores={
                "audience1": {
                    key: Decimal(str(value)) for key, value in zip(contestants, range(15, 0, -1))
                },
                "audience4": {
                    key: Decimal(str(value)) for key, value in zip(contestants, range(1, 16))
                },
            },
        )
        before = resolve(original_definition, inputs)
        before_stages = {
            key: resolve_to_checkpoint(original_definition, inputs, key)
            for key in ("stage1", "stage2", "stage3")
        }
        projection = infer_business_stages(original_definition)
        saved = self._save(
            self.version,
            stages=projection["stages"],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
            base_binding=original_binding,
        )
        after_definition = saved.definition
        after = resolve(after_definition, inputs)
        after_stages = {
            key: resolve_to_checkpoint(after_definition, inputs, key)
            for key in ("stage1", "stage2", "stage3")
        }

        self.assertEqual(before.status, after.status)
        self.assertEqual(
            [
                (item.contestant, item.outcome_code, item.rank, item.score)
                for item in before.decisions
            ],
            [
                (item.contestant, item.outcome_code, item.rank, item.score)
                for item in after.decisions
            ],
        )
        self.assertEqual(
            [(item.contestant, item.value) for item in before.composites],
            [(item.contestant, item.value) for item in after.composites],
        )
        for key in before_stages:
            self.assertEqual(
                [
                    (item.contestant, item.outcome_code, item.rank, item.score)
                    for item in before_stages[key].decisions
                ],
                [
                    (item.contestant, item.outcome_code, item.rank, item.score)
                    for item in after_stages[key].decisions
                ],
            )
            self.assertEqual(
                [(item.contestant, item.value) for item in before_stages[key].composites],
                [(item.contestant, item.value) for item in after_stages[key].composites],
            )
        self.ruleset.refresh_from_db()
        self.assertEqual(self._binding_signature(), original_binding)
        self.assertEqual(
            json.loads(after_definition)["checkpoints"],
            json.loads(original_definition)["checkpoints"],
        )
        self.assertEqual(
            {
                key: (
                    ContestRound.objects.get(pk=round_.pk).name,
                    ContestRound.objects.get(pk=round_.pk).scoring_mode,
                    ContestRound.objects.get(pk=round_.pk).roster_source,
                    ContestRound.objects.get(pk=round_.pk).roster_source_stage,
                    ContestRound.objects.get(pk=round_.pk).advance_count,
                )
                for key, round_ in rounds.items()
            },
            original_rounds,
        )

    def test_deleting_a_middle_stage_that_a_later_stage_keeps_is_rejected(self):
        from ruleset.business_editor import business_definition_from_stages

        initial_stages = [
            _business_stage(key="stage1", round_key="r1", create_round=False),
            _business_stage(key="stage2", round_key="r2", advance_count=5, create_round=False),
            _business_stage(key="stage3", round_key="r3", advance_count=3, create_round=False),
        ]
        nodes, checkpoints, context = business_definition_from_stages(initial_stages)
        with authority_write(CONTEST_ROUND_STATE):
            first = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="第一轮",
                advance_count=10,
            )
            second = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.SEMI_FINAL,
                name="第二轮",
                advance_count=5,
            )
            third = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.SEMI_FINAL,
                name="第三轮",
                advance_count=3,
            )
        self.ruleset.round_keys = {"r1": first.pk, "r2": second.pk, "r3": third.pk}
        self.ruleset.save(update_fields=["round_keys"])
        root = json.loads(self.version.definition)
        root["nodes"] = nodes
        root["checkpoints"] = checkpoints
        root["context"] = context
        self.version.definition = json.dumps(root, ensure_ascii=False)
        self.version.save(update_fields=["definition"])

        with self.assertRaisesRegex(ValidationError, "stage2"):
            self._save(
                self.version,
                stages=[
                    _business_stage(key="stage1", round_key="r1", create_round=False),
                    _business_stage(
                        key="stage3", round_key="r3", advance_count=3, create_round=False
                    ),
                ],
                operator=self.operator,
                base_content_hash=self.version.content_hash,
                base_binding=self._binding_signature(),
            )
