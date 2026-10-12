import json
from unittest.mock import patch

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, CONTEST_ROUND_STATE, authority_write
from common.models import AuditLog
from core.models import Activity
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import SimpleTestCase, TestCase
from ruleset.models import ContestRuleset, RulesetVersion
from singer_contest.models import ContestRound

from ruleset.services import save_business_ruleset, validate_definition_completeness


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
            definition=json.dumps({"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]}),
            created_by=self.operator,
        )

    def test_save_creates_and_binds_an_explicit_draft_round(self):
        saved = save_business_ruleset(
            self.version,
            stages=[_business_stage()],
            operator=self.operator,
            base_content_hash=self.version.content_hash,
        )

        round_ = ContestRound.objects.get(activity=self.activity)
        self.assertEqual(round_.status, ContestRound.Status.DRAFT)
        self.assertEqual(round_.advance_count, 10)
        self.ruleset.refresh_from_db()
        self.assertEqual(self.ruleset.round_keys, {"r1": round_.pk})
        self.assertEqual(json.loads(saved.definition)["checkpoints"], [{"key": "stage1", "output": "top10"}])
        self.assertTrue(AuditLog.objects.filter(target=f"RulesetVersion:{self.version.pk}").exists())

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

        save_business_ruleset(
            self.version,
            stages=[
                _business_stage(
                    round_name="更新后的第一轮",
                    advance_count=5,
                    scoring_mode=ContestRound.ScoringMode.DROP_HIGH_LOW,
                    create_round=False,
                )
            ],
            operator=self.operator,
        )

        round_.refresh_from_db()
        self.assertEqual(round_.name, "更新后的第一轮")
        self.assertEqual(round_.advance_count, 5)
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
            save_business_ruleset(
                self.version,
                stages=[_business_stage(advance_count=5, create_round=False)],
                operator=self.operator,
            )

        self.version.refresh_from_db()
        self.assertEqual(self.version.definition, before)

    def test_stale_hashes_reject_the_whole_business_save(self):
        with self.assertRaises(ValidationError):
            save_business_ruleset(
                self.version,
                stages=[_business_stage()],
                operator=self.operator,
                base_content_hash="0" * 64,
            )
        self.assertFalse(ContestRound.objects.filter(activity=self.activity).exists())

    def test_stale_binding_rejects_the_whole_business_save(self):
        from ruleset.services import _binding_signature

        stale_binding = _binding_signature(self.ruleset)
        self.ruleset.stage_key = "changed-elsewhere"
        self.ruleset.save(update_fields=["stage_key"])

        with self.assertRaises(ValidationError):
            save_business_ruleset(
                self.version,
                stages=[_business_stage()],
                operator=self.operator,
                base_binding=stale_binding,
            )
        self.assertFalse(ContestRound.objects.filter(activity=self.activity).exists())

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
                save_business_ruleset(
                    self.version,
                    stages=[_business_stage()],
                    operator=self.operator,
                )

        self.assertFalse(ContestRound.objects.filter(activity=self.activity).exists())
        self.ruleset.refresh_from_db()
        self.assertEqual(self.ruleset.round_keys, {})

    def test_business_save_preserves_unowned_context_and_questionnaire(self):
        root = json.loads(self.version.definition)
        root["context"] = {"audience_rule": "keep", "other": {"x": 1}}
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

        save_business_ruleset(self.version, stages=[_business_stage()], operator=self.operator)

        self.version.refresh_from_db()
        stored = json.loads(self.version.definition)
        self.assertEqual(stored["context"]["audience_rule"], "keep")
        self.assertEqual(stored["context"]["other"], {"x": 1})
        self.assertEqual(stored["questionnaire"], root["questionnaire"])

    def test_deleting_a_middle_stage_that_a_later_stage_keeps_is_rejected(self):
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
        existing = {
            "business": {
                "stages": [
                    _business_stage(key="stage1", round_key="r1"),
                    _business_stage(key="stage2", round_key="r2", advance_count=5),
                    _business_stage(key="stage3", round_key="r3", advance_count=3),
                ]
            }
        }
        root = json.loads(self.version.definition)
        root["context"] = existing
        self.version.definition = json.dumps(root, ensure_ascii=False)
        self.version.save(update_fields=["definition"])

        with self.assertRaisesRegex(ValidationError, "stage2"):
            save_business_ruleset(
                self.version,
                stages=[
                    _business_stage(key="stage1", round_key="r1"),
                    _business_stage(key="stage3", round_key="r3", advance_count=3),
                ],
                operator=self.operator,
            )
