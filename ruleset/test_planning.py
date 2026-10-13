import json
from decimal import Decimal

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
from singer_contest.models import ContestRound
from singer_contest.services import configure_draft_round_from_planning

from ruleset.models import ContestRuleset, RulesetPlanningDraft, RulesetVersion
from ruleset.planning import (
    PlanningResolution,
    PlanningSeverity,
    default_planning_payload,
    parse_percentage,
    planning_field,
    prepare_planning_compile,
    validate_planning_draft,
)
from ruleset.services import (
    apply_planning_to_ruleset,
    load_planning_draft,
    planning_projection_from_definition,
    prepare_planning_compile_for_version,
    save_planning_draft,
)
from ruleset.templates import golden_schidui


class PercentageParsingTests(SimpleTestCase):
    def test_plain_number_is_percentage_not_coefficient(self):
        parsed = parse_percentage("50")

        self.assertEqual(parsed.percent, Decimal("50"))
        self.assertEqual(parsed.coefficient, Decimal("0.5"))
        self.assertFalse(parsed.requires_confirmation)
        self.assertFalse(parsed.had_percent_sign)

    def test_percent_suffix_keeps_percentage_meaning(self):
        parsed = parse_percentage("50%")

        self.assertEqual(parsed.percent, Decimal("50"))
        self.assertEqual(parsed.coefficient, Decimal("0.5"))
        self.assertTrue(parsed.had_percent_sign)

    def test_fraction_without_suffix_requires_confirmation(self):
        parsed = parse_percentage("0.5")

        self.assertEqual(parsed.percent, Decimal("0.5"))
        self.assertEqual(parsed.coefficient, Decimal("0.005"))
        self.assertTrue(parsed.requires_confirmation)

    def test_invalid_percentage_values_are_rejected(self):
        for value in ("-1", "100.01", "NaN", "Infinity", "50%%"):
            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    parse_percentage(value)


class PlanningValidationTests(SimpleTestCase):
    def test_missing_participant_count_is_saveable_but_blocks_apply(self):
        payload = {
            "schema_version": 1,
            "stages": [
                {
                    "business_id": "stage-1",
                    "participants": {"source": "all_finalists", "count": None},
                }
            ],
        }

        issue = next(
            issue
            for issue in validate_planning_draft(payload)
            if issue.code == "MISSING_PARTICIPANT_COUNT"
        )

        self.assertEqual(issue.severity, PlanningSeverity.MISSING_INFORMATION)
        self.assertTrue(issue.blocks_apply)
        self.assertEqual(issue.stage_id, "stage-1")

    def test_confirmed_false_is_not_missing(self):
        value = planning_field(
            False,
            PlanningResolution.CONFIRMED,
            "老师确认不计观众分",
            "score",
        )

        self.assertIs(value["value"], False)

    def test_conflicting_evidence_is_a_business_conflict(self):
        payload = {
            "schema_version": 1,
            "stages": [
                {
                    "business_id": "stage-1",
                    "name": {
                        "value": "初赛",
                        "resolution": "conflict",
                        "evidence": "两份材料分别写 30% 和 40%",
                        "unit": "text",
                    },
                }
            ],
        }

        issues = validate_planning_draft(payload)

        self.assertEqual(issues[0].severity, PlanningSeverity.BUSINESS_CONFLICT)
        self.assertEqual(issues[0].code, "CONFLICTING_EVIDENCE")


class PlanningDraftAuthorityTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.operator = User.objects.create_user(
                username="planning-authority-user",
                password="pass",
                role=User.Role.STAFF,
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="规划草稿活动",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="规划草稿规则",
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

    def test_direct_draft_save_is_rejected_outside_planning_service(self):
        draft = RulesetPlanningDraft(
            ruleset_version=self.version,
            payload=default_planning_payload(),
        )

        with self.assertRaises(ValidationError):
            draft.save()

    def test_draft_cannot_attach_to_frozen_version(self):
        self.version.status = RulesetVersion.Status.FROZEN
        with authority_write(RULESET_FREEZE):
            self.version.save(update_fields=["status"])

        with self.assertRaises(ValidationError):
            RulesetPlanningDraft(
                ruleset_version=self.version,
                payload=default_planning_payload(),
            ).full_clean()


class PlanningDraftServiceTests(PlanningDraftAuthorityTests):
    def test_load_initializes_a_blank_draft_without_creating_rounds(self):
        before_rounds = ContestRound.objects.filter(activity=self.activity).count()

        draft = load_planning_draft(self.version)

        self.assertEqual(draft.revision, 0)
        self.assertEqual(draft.payload, default_planning_payload())
        self.assertEqual(draft.source, "manual")
        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), before_rounds)

    def test_saving_participant_count_does_not_create_round_or_change_definition(self):
        before_definition = self.version.definition
        before_rounds = ContestRound.objects.filter(activity=self.activity).count()
        payload = {
            "schema_version": 1,
            "stages": [
                {
                    "business_id": "stage-1",
                    "participants": {
                        "source": "all_finalists",
                        "count": planning_field(
                            15,
                            PlanningResolution.CONFIRMED,
                            "报名汇总表",
                            "person",
                        ),
                    },
                }
            ],
        }

        saved = save_planning_draft(
            self.version,
            payload=payload,
            operator=self.operator,
            expected_revision=0,
        )

        self.assertEqual(saved.revision, 1)
        self.version.refresh_from_db()
        self.assertEqual(self.version.definition, before_definition)
        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), before_rounds)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.UPDATE_RULESET_PLANNING,
                target=f"RulesetPlanningDraft:{saved.pk}",
            ).exists()
        )

    def test_stale_revision_is_rejected_without_overwriting_payload(self):
        first_payload = {"schema_version": 1, "stages": []}
        second_payload = {
            "schema_version": 1,
            "stages": [{"business_id": "other"}],
        }
        save_planning_draft(
            self.version,
            payload=first_payload,
            operator=self.operator,
            expected_revision=0,
        )

        with self.assertRaises(ValidationError):
            save_planning_draft(
                self.version,
                payload=second_payload,
                operator=self.operator,
                expected_revision=0,
            )

        draft = RulesetPlanningDraft.objects.get(ruleset_version=self.version)
        self.assertEqual(draft.revision, 1)
        self.assertEqual(draft.payload, first_payload)


class PlanningProjectionTests(SimpleTestCase):
    def test_golden_linear_definition_projects_to_editable_business_stages(self):
        projection = planning_projection_from_definition(golden_schidui())

        self.assertTrue(projection.editable)
        self.assertFalse(projection.read_only)
        self.assertEqual(
            [stage["advance_count"] for stage in projection.stages],
            [10, 5, 3],
        )
        self.assertEqual(projection.source, "historical_projection")

    def test_historical_projection_contains_a_complete_editable_stage_shape(self):
        projection = planning_projection_from_definition(golden_schidui())

        stage = projection.payload["stages"][0]
        self.assertEqual(stage["result_method"]["value"], "top_n")
        self.assertEqual(stage["judge_sources"][0]["weight"]["value"], "30")
        self.assertEqual(stage["audience_weight"]["value"], "10")

    def test_historical_projection_can_prepare_without_losing_previous_score_weight(self):
        projection = planning_projection_from_definition(golden_schidui())

        result = prepare_planning_compile(projection.payload, golden_schidui())

        self.assertTrue(result.can_apply)
        self.assertEqual(result.business_stages[1]["previous_weight"], "0.6")

    def test_complex_definition_is_read_only_and_keeps_manual_node_information(self):
        definition = {
            "schema_version": 1,
            "nodes": [
                {"key": "roster", "type": "ROSTER"},
                {
                    "key": "groups",
                    "type": "PARTITION",
                    "source": "entry",
                    "by": "g",
                },
                {
                    "key": "manual",
                    "type": "MANUAL_SELECT",
                    "source": "groups",
                    "groups": 1,
                    "quota": 3,
                },
            ],
            "checkpoints": [{"key": "final", "output": "manual"}],
        }

        projection = planning_projection_from_definition(definition)

        self.assertFalse(projection.editable)
        self.assertTrue(projection.read_only)
        self.assertIn("人工", projection.notice)


def _planning_stage(**overrides):
    stage: dict[str, object] = {
        "business_id": "stage-1",
        "name": planning_field("初赛", PlanningResolution.CONFIRMED, "比赛方案", "text"),
        "participants": {
            "source": "all_finalists",
            "count": planning_field(15, PlanningResolution.CONFIRMED, "报名汇总表", "person"),
        },
        "advance_count": planning_field(10, PlanningResolution.CONFIRMED, "比赛方案", "person"),
        "judge_sources": [
            {
                "business_id": "round-1",
                "format": "solo",
                "weight": planning_field(
                    "100", PlanningResolution.CONFIRMED, "比赛方案", "percent"
                ),
            }
        ],
        "audience_source": planning_field("", PlanningResolution.CONFIRMED, "无观众计分", "vote"),
        "audience_weight": planning_field(
            "0", PlanningResolution.CONFIRMED, "无观众计分", "percent"
        ),
        "result_method": planning_field("top_n", PlanningResolution.CONFIRMED, "比赛方案", "text"),
    }
    stage.update(overrides)
    return stage


def _planning_payload(stage: dict[str, object] | None = None) -> dict[str, object]:
    return {
        "schema_version": 1,
        "stages": [stage or _planning_stage()],
        "execution_refs": {},
    }


def _golden_planning_payload(
    weights: tuple[str, str] = ("30", "60"), audience_weight: str = "10"
) -> dict[str, object]:
    stage = _planning_stage(
        judge_sources=[
            {
                "business_id": "round-1",
                "format": "solo",
                "weight": planning_field(
                    weights[0], PlanningResolution.CONFIRMED, "比赛方案", "percent"
                ),
            },
            {
                "business_id": "round-2",
                "format": "solo",
                "weight": planning_field(
                    weights[1], PlanningResolution.CONFIRMED, "比赛方案", "percent"
                ),
            },
        ],
        audience_source=planning_field(
            "audience1", PlanningResolution.CONFIRMED, "投票方案", "vote"
        ),
        audience_weight=planning_field(
            audience_weight, PlanningResolution.CONFIRMED, "比赛方案", "percent"
        ),
    )
    return _planning_payload(stage)


class PlanningCompileTests(SimpleTestCase):
    def test_two_rounds_contribute_to_one_stage_result(self):
        result = prepare_planning_compile(
            _golden_planning_payload(),
            {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
        )

        self.assertTrue(result.can_apply)
        self.assertEqual(
            [source["weight"] for source in result.business_stages[0]["judge_sources"]],
            ["0.3", "0.6"],
        )
        self.assertEqual(result.business_stages[0]["audience_weight"], "0.1")

    def test_missing_weight_or_conversion_blocks_candidate_but_does_not_raise(self):
        incomplete = _planning_payload(
            _planning_stage(
                judge_sources=[
                    {
                        "business_id": "round-1",
                        "format": "solo",
                        "weight": planning_field(
                            None,
                            PlanningResolution.PENDING,
                            "待确认",
                            "percent",
                        ),
                    }
                ]
            )
        )

        result = prepare_planning_compile(
            incomplete,
            {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
        )

        self.assertFalse(result.can_apply)
        self.assertIn("WEIGHTS_INCOMPLETE", {issue.code for issue in result.issues})

    def test_collaboration_groups_do_not_create_group_selection(self):
        collaboration = _planning_payload(
            _planning_stage(
                collaboration_group=planning_field(
                    "同组演唱、每人单独评分",
                    PlanningResolution.CONFIRMED,
                    "比赛方案",
                    "group",
                ),
                judge_sources=[
                    {
                        "business_id": "round-1",
                        "format": "collaboration",
                        "weight": planning_field(
                            "100", PlanningResolution.CONFIRMED, "比赛方案", "percent"
                        ),
                    }
                ],
            )
        )

        result = prepare_planning_compile(
            collaboration,
            {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
        )

        self.assertTrue(result.can_apply)
        self.assertNotIn(
            "PARTITION",
            {node["type"] for node in result.candidate_definition["nodes"]},
        )

    def test_non_linear_result_method_is_blocked_without_professional_graph(self):
        manual = _planning_payload(
            _planning_stage(
                result_method=planning_field(
                    "manual",
                    PlanningResolution.CONFIRMED,
                    "负责人决定",
                    "text",
                )
            )
        )

        result = prepare_planning_compile(
            manual,
            {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
        )

        self.assertFalse(result.can_apply)
        self.assertIn("UNSUPPORTED_RESULT_METHOD", {issue.code for issue in result.issues})


class PlanningRoundConfigurationTests(PlanningDraftAuthorityTests):
    def test_planning_can_configure_only_an_unlocked_draft_round(self):
        with authority_write(CONTEST_ROUND_STATE):
            contest_round = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                status=ContestRound.Status.DRAFT,
                is_locked=False,
            )

        configured = configure_draft_round_from_planning(
            contest_round,
            operator=self.operator,
            configuration={
                "name": "第一轮小组演唱",
                "judge_count": 5,
                "scoring_mode": ContestRound.ScoringMode.AVERAGE,
                "advance_count": 10,
                "roster_source": ContestRound.RosterSource.APPROVED,
                "roster_source_stage": "",
                "rubric": None,
            },
        )

        self.assertEqual(configured.judge_count, 5)

    def test_planning_rejects_a_prepared_round(self):
        with authority_write(CONTEST_ROUND_STATE):
            contest_round = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                status=ContestRound.Status.PREPARED,
                is_locked=False,
            )

        with self.assertRaises(PermissionDenied):
            configure_draft_round_from_planning(
                contest_round,
                operator=self.operator,
                configuration={"name": "修改"},
            )


class PlanningApplyServiceTests(PlanningDraftAuthorityTests):
    def _complete_payload(self):
        return _planning_payload(
            _planning_stage(
                judge_sources=[
                    {
                        "business_id": "round-1",
                        "format": "solo",
                        "weight": planning_field(
                            "100", PlanningResolution.CONFIRMED, "比赛方案", "percent"
                        ),
                    }
                ],
                audience_source=planning_field(
                    "", PlanningResolution.CONFIRMED, "无观众计分", "vote"
                ),
                audience_weight=planning_field(
                    "0", PlanningResolution.CONFIRMED, "无观众计分", "percent"
                ),
            )
        )

    def test_prepare_for_version_reads_the_current_draft_without_mutation(self):
        payload = self._complete_payload()
        save_planning_draft(
            self.version,
            payload=payload,
            operator=self.operator,
            expected_revision=0,
        )
        before_definition = self.version.definition

        result = prepare_planning_compile_for_version(self.version)

        self.assertTrue(result.can_apply)
        self.version.refresh_from_db()
        self.assertEqual(self.version.definition, before_definition)
        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), 0)

    def test_apply_planning_materializes_only_a_draft_round_and_definition(self):
        payload = self._complete_payload()
        draft = save_planning_draft(
            self.version,
            payload=payload,
            operator=self.operator,
            expected_revision=0,
        )

        saved = apply_planning_to_ruleset(
            self.version,
            operator=self.operator,
            expected_revision=draft.revision,
        )

        self.assertEqual(saved.status, RulesetVersion.Status.DRAFT)
        self.assertEqual(
            ContestRound.objects.filter(
                activity=self.activity,
                status=ContestRound.Status.DRAFT,
            ).count(),
            1,
        )
        self.assertIn("checkpoints", json.loads(saved.definition))
