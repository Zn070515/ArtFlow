import json
from copy import deepcopy
from decimal import Decimal
from typing import Any

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
from singer_contest.models import ContestRound, RubricCriterion, ScoringRubric
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
    prepare_planning_preflight,
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

    def test_nested_pending_participant_count_blocks_apply(self):
        payload = {
            "schema_version": 1,
            "stages": [
                {
                    "business_id": "stage-1",
                    "participants": {
                        "source": "all_finalists",
                        "count": planning_field(
                            None, PlanningResolution.PENDING, "待确认", "person"
                        ),
                    },
                }
            ],
        }

        issues = validate_planning_draft(payload)

        self.assertTrue(any(issue.code == "MISSING_PARTICIPANT_COUNT" for issue in issues))

    def test_missing_audience_weight_is_not_interpreted_as_zero(self):
        stage = _planning_stage()
        stage.pop("audience_weight")

        result = prepare_planning_compile(
            _planning_payload(stage),
            {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
        )

        self.assertFalse(result.can_apply)
        self.assertIn("MISSING_AUDIENCE_WEIGHT", {issue.code for issue in result.issues})

    def test_audience_vote_conversion_is_not_invented(self):
        stage = _planning_stage(
            audience_source=planning_field(
                "audience1", PlanningResolution.CONFIRMED, "投票方案", "vote"
            ),
            audience_weight=planning_field(
                "10", PlanningResolution.CONFIRMED, "比赛方案", "percent"
            ),
        )

        result = prepare_planning_compile(
            _planning_payload(stage),
            {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
        )

        self.assertFalse(result.can_apply)
        self.assertIn("MISSING_AUDIENCE_CONVERSION", {issue.code for issue in result.issues})

    def test_audience_source_is_required_when_audience_weight_is_nonzero(self):
        stage = _planning_stage(
            audience_source=planning_field("", PlanningResolution.CONFIRMED, "待补充", "vote"),
            audience_weight=planning_field(
                "10", PlanningResolution.CONFIRMED, "比赛方案", "percent"
            ),
            audience_conversion=planning_field(
                "ballot_share_percent",
                PlanningResolution.CONFIRMED,
                "投票换算规则",
                "text",
            ),
        )

        issues = validate_planning_draft(_planning_payload(stage))

        self.assertIn("MISSING_AUDIENCE_SOURCE", {issue.code for issue in issues})

    def test_round_format_is_not_defaulted_to_solo(self):
        stage = _planning_stage()
        stage["judge_sources"][0]["format"] = ""

        issues = validate_planning_draft(_planning_payload(stage))

        self.assertIn("MISSING_ROUND_FORMAT", {issue.code for issue in issues})

    def test_optional_empty_facts_do_not_block_a_complete_stage(self):
        stage = _planning_stage()
        stage["judge_sources"][0]["minimum_judge_count"] = planning_field(
            "", PlanningResolution.CONFIRMED, "按准备名单人数", "judge"
        )
        stage["audience_conversion"] = planning_field(
            "", PlanningResolution.CONFIRMED, "无观众计分", "text"
        )

        result = prepare_planning_compile(
            _planning_payload(stage),
            {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
        )

        self.assertTrue(result.can_apply)

    def test_missing_previous_weight_is_not_interpreted_as_zero(self):
        first = _planning_stage()
        second = _planning_stage(
            business_id="stage-2",
            name=planning_field("复赛", PlanningResolution.CONFIRMED, "比赛方案", "text"),
        )
        second.pop("previous_weight", None)

        result = prepare_planning_compile(
            {"schema_version": 1, "stages": [first, second], "execution_refs": {}},
            {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
        )

        self.assertFalse(result.can_apply)
        self.assertIn("MISSING_PREVIOUS_WEIGHT", {issue.code for issue in result.issues})

    def test_missing_judge_count_and_rubric_are_not_interpreted_as_runtime_defaults(self):
        stage = _planning_stage()
        stage["judge_sources"][0].pop("judge_count")
        stage["judge_sources"][0].pop("rubric")

        result = prepare_planning_compile(
            _planning_payload(stage),
            {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
        )

        codes = {issue.code for issue in result.issues}
        self.assertFalse(result.can_apply)
        self.assertIn("MISSING_JUDGE_COUNT", codes)
        self.assertIn("MISSING_RUBRIC", codes)

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

        raw_stages = projection.payload["stages"]
        assert isinstance(raw_stages, list)
        stage = raw_stages[0]
        assert isinstance(stage, dict)
        self.assertEqual(stage["result_method"]["value"], "top_n")
        self.assertEqual(stage["judge_sources"][0]["weight"]["value"], "30")
        self.assertEqual(stage["audience_weight"]["value"], "10")

    def test_golden_projection_preserves_shared_round_identity(self):
        projection = planning_projection_from_definition(golden_schidui())

        payload_stages = projection.payload["stages"]
        assert isinstance(payload_stages, list)
        stage2 = payload_stages[1]
        stage3 = payload_stages[2]
        assert isinstance(stage2, dict)
        assert isinstance(stage3, dict)
        stage2_sources = stage2["judge_sources"]
        stage3_sources = stage3["judge_sources"]
        assert isinstance(stage2_sources, list)
        assert isinstance(stage3_sources, list)
        self.assertEqual(stage2_sources[0]["round_key"], "r3")
        self.assertEqual(stage3_sources[0]["round_key"], "r3")
        self.assertEqual(stage2_sources[0]["business_id"], "r3")
        self.assertEqual(stage3_sources[0]["business_id"], "r3")

        execution_refs = projection.payload["execution_refs"]
        assert isinstance(execution_refs, dict)
        round_refs = execution_refs["rounds"]
        assert isinstance(round_refs, dict)
        self.assertEqual(set(round_refs), {"r1", "r2", "r3", "r4"})

    def test_golden_compile_deduplicates_shared_round_configuration(self):
        projection = planning_projection_from_definition(golden_schidui())
        payload = _add_golden_execution_facts(projection.payload)

        result = prepare_planning_compile(payload, golden_schidui())

        self.assertTrue(result.can_apply)
        self.assertEqual(
            [configuration["round_key"] for configuration in result.round_configurations],
            ["r1", "r2", "r3", "r4"],
        )
        shared = result.round_configurations[2]
        self.assertEqual(shared["business_ids"], ["r3", "r3"])
        assert result.candidate_definition is not None
        self.assertEqual(
            _semantic_graph(result.candidate_definition),
            _semantic_graph(golden_schidui()),
        )

    def test_historical_projection_can_prepare_without_losing_previous_score_weight(self):
        projection = planning_projection_from_definition(golden_schidui())
        payload = _add_golden_execution_facts(projection.payload)

        result = prepare_planning_compile(payload, golden_schidui())

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


def _planning_rubric(name="演唱评分"):
    return {
        "name": planning_field(name, PlanningResolution.CONFIRMED, "评分表", "text"),
        "description": planning_field(
            "每人分别评分", PlanningResolution.CONFIRMED, "评分表", "text"
        ),
        "criteria": [
            {
                "name": planning_field("演唱表现", PlanningResolution.CONFIRMED, "评分表", "text"),
                "max_score": planning_field(100, PlanningResolution.CONFIRMED, "评分表", "score"),
            }
        ],
    }


def _planning_stage(**overrides):
    stage: dict[str, object] = {
        "business_id": "stage-1",
        "name": planning_field("初赛", PlanningResolution.CONFIRMED, "比赛方案", "text"),
        "participants": {
            "source": "all_finalists",
            "count": planning_field(15, PlanningResolution.CONFIRMED, "报名汇总表", "person"),
        },
        "advance_count": planning_field(10, PlanningResolution.CONFIRMED, "比赛方案", "person"),
        "previous_weight": planning_field(
            "0", PlanningResolution.CONFIRMED, "第一阶段无上一阶段成绩", "percent"
        ),
        "judge_sources": [
            {
                "business_id": "round-1",
                "format": "solo",
                "scoring_mode": planning_field(
                    "average", PlanningResolution.CONFIRMED, "比赛方案", "text"
                ),
                "judge_count": planning_field(5, PlanningResolution.CONFIRMED, "评委名单", "judge"),
                "rubric": _planning_rubric(),
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
                "scoring_mode": planning_field(
                    "average", PlanningResolution.CONFIRMED, "比赛方案", "text"
                ),
                "judge_count": planning_field(5, PlanningResolution.CONFIRMED, "评委名单", "judge"),
                "rubric": _planning_rubric("第一轮评分"),
                "weight": planning_field(
                    weights[0], PlanningResolution.CONFIRMED, "比赛方案", "percent"
                ),
            },
            {
                "business_id": "round-2",
                "format": "solo",
                "scoring_mode": planning_field(
                    "average", PlanningResolution.CONFIRMED, "比赛方案", "text"
                ),
                "judge_count": planning_field(5, PlanningResolution.CONFIRMED, "评委名单", "judge"),
                "rubric": _planning_rubric("第二轮评分"),
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
        audience_conversion=planning_field(
            "ballot_share_percent", PlanningResolution.CONFIRMED, "投票换算规则", "text"
        ),
    )
    return _planning_payload(stage)


def _add_golden_execution_facts(payload):
    payload = deepcopy(payload)
    for stage in payload["stages"]:
        if stage.get("audience_weight", {}).get("value") not in (None, "0", 0):
            stage["audience_conversion"] = planning_field(
                "ballot_share_percent", PlanningResolution.CONFIRMED, "投票换算规则", "text"
            )
        for source in stage["judge_sources"]:
            source["judge_count"] = planning_field(
                5, PlanningResolution.CONFIRMED, "评委名单", "judge"
            )
            source["rubric"] = _planning_rubric(f"{source['round_key']}评分")
    return payload


def _semantic_graph(definition):
    root = json.loads(definition) if isinstance(definition, str) else definition
    nodes = {node["key"]: node for node in root["nodes"]}
    cache: dict[str, Any] = {}

    def canonical(key: str) -> Any:
        if key == "entry":
            return ("ENTRY",)
        if key in cache:
            return cache[key]
        node = nodes[key]
        node_type = node["type"]
        value: Any
        if node_type == "ASSESS":
            value = (
                "ASSESS",
                canonical(node["source"]),
                str(node.get("round") or ""),
                str(node.get("vote_source") or ""),
                str(node.get("vote_purpose") or ""),
                str(node.get("mode") or "mean"),
                int(node.get("trim_high") or 0),
                int(node.get("trim_low") or 0),
            )
        elif node_type == "AGGREGATE":
            aggregate = node["aggregate"]
            value = (
                "AGGREGATE",
                canonical(node.get("within") or "entry"),
                aggregate["type"],
                tuple(
                    (canonical(component["source"]), str(Decimal(str(component["weight"]))))
                    for component in aggregate["components"]
                ),
            )
        elif node_type == "RANK":
            value = ("RANK", canonical(node["source"]), bool(node.get("descending")))
        elif node_type == "SELECT":
            value = ("SELECT", canonical(node["source"]), int(node["count"]))
        else:
            raise AssertionError(f"unexpected golden node type: {node_type}")
        cache[key] = value
        return value

    return tuple(
        (checkpoint["key"], canonical(checkpoint["output"])) for checkpoint in root["checkpoints"]
    )


class PlanningCompileTests(SimpleTestCase):
    def test_two_rounds_contribute_to_one_stage_result(self):
        result = prepare_planning_compile(
            _golden_planning_payload(),
            {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
        )

        self.assertTrue(result.can_apply)
        raw_sources = result.business_stages[0]["judge_sources"]
        assert isinstance(raw_sources, list)
        sources = [source for source in raw_sources if isinstance(source, dict)]
        self.assertEqual(len(sources), len(raw_sources))
        self.assertEqual(
            [source["weight"] for source in sources],
            ["0.3", "0.6"],
        )
        self.assertEqual(result.business_stages[0]["audience_weight"], "0.1")

    def test_round_configuration_preserves_explicit_execution_facts(self):
        stage = _planning_stage(
            participants={
                "source": "all_finalists",
                "count": planning_field(15, PlanningResolution.CONFIRMED, "报名汇总表", "person"),
                "group_count": planning_field(5, PlanningResolution.CONFIRMED, "分组方案", "group"),
                "group_size": planning_field(3, PlanningResolution.CONFIRMED, "分组方案", "person"),
            },
            judge_sources=[
                {
                    "business_id": "round-1",
                    "format": "collaboration",
                    "scoring_mode": planning_field(
                        "drop_high_low", PlanningResolution.CONFIRMED, "比赛方案", "text"
                    ),
                    "judge_count": planning_field(
                        5, PlanningResolution.CONFIRMED, "评委名单", "judge"
                    ),
                    "minimum_judge_count": planning_field(
                        4, PlanningResolution.CONFIRMED, "比赛方案", "judge"
                    ),
                    "rubric": {
                        "name": planning_field(
                            "演唱评分", PlanningResolution.CONFIRMED, "评分表", "text"
                        ),
                        "description": planning_field(
                            "每人单独评分", PlanningResolution.CONFIRMED, "评分表", "text"
                        ),
                        "criteria": [
                            {
                                "name": planning_field(
                                    "演唱", PlanningResolution.CONFIRMED, "评分表", "text"
                                ),
                                "max_score": planning_field(
                                    "100", PlanningResolution.CONFIRMED, "评分表", "score"
                                ),
                            }
                        ],
                    },
                    "weight": planning_field(
                        "100", PlanningResolution.CONFIRMED, "比赛方案", "percent"
                    ),
                }
            ],
            audience_weight=planning_field(
                "0", PlanningResolution.CONFIRMED, "无观众计分", "percent"
            ),
            audience_source=planning_field("", PlanningResolution.CONFIRMED, "无观众计分", "vote"),
        )

        result = prepare_planning_compile(
            _planning_payload(stage),
            {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]},
        )

        self.assertTrue(result.can_apply)
        configuration = result.round_configurations[0]
        self.assertEqual(configuration["scoring_mode"], "drop_high_low")
        self.assertEqual(configuration["judge_count"], 5)
        self.assertEqual(configuration["minimum_judge_count"], 4)
        rubric = configuration["rubric"]
        assert isinstance(rubric, dict)
        self.assertEqual(rubric["name"], "演唱评分")

    def test_missing_weight_or_conversion_blocks_candidate_but_does_not_raise(self):
        incomplete = _planning_payload(
            _planning_stage(
                judge_sources=[
                    {
                        "business_id": "round-1",
                        "format": "solo",
                        "scoring_mode": planning_field(
                            "average", PlanningResolution.CONFIRMED, "比赛方案", "text"
                        ),
                        "judge_count": planning_field(
                            5, PlanningResolution.CONFIRMED, "评委名单", "judge"
                        ),
                        "rubric": _planning_rubric(),
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
                participants={
                    "source": "报名汇总",
                    "count": planning_field(15, PlanningResolution.CONFIRMED, "报名汇总", "person"),
                    "group_count": planning_field(
                        5, PlanningResolution.CONFIRMED, "比赛方案", "group"
                    ),
                    "group_size": planning_field(
                        3, PlanningResolution.CONFIRMED, "比赛方案", "person"
                    ),
                },
                judge_sources=[
                    {
                        "business_id": "round-1",
                        "format": "collaboration",
                        "scoring_mode": planning_field(
                            "average", PlanningResolution.CONFIRMED, "比赛方案", "text"
                        ),
                        "judge_count": planning_field(
                            5, PlanningResolution.CONFIRMED, "评委名单", "judge"
                        ),
                        "rubric": _planning_rubric(),
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
        participants = result.business_stages[0]["participants"]
        assert isinstance(participants, dict)
        self.assertEqual(participants["group_count"], 5)
        self.assertEqual(participants["group_size"], 3)
        candidate_definition = result.candidate_definition
        assert candidate_definition is not None
        raw_nodes = candidate_definition["nodes"]
        assert isinstance(raw_nodes, list)
        nodes = [node for node in raw_nodes if isinstance(node, dict)]
        self.assertEqual(len(nodes), len(raw_nodes))
        self.assertNotIn(
            "PARTITION",
            {node["type"] for node in nodes},
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

    def test_planning_rejects_changes_to_a_round_used_by_current_frozen_ruleset(self):
        with authority_write(CONTEST_ROUND_STATE):
            contest_round = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="第一轮",
            )
        self.ruleset.round_keys = {"r1": contest_round.pk}
        self.ruleset.save(update_fields=["round_keys"])
        with authority_write(RULESET_FREEZE):
            self.version.status = RulesetVersion.Status.FROZEN
            self.version.is_current = True
            self.version.binding = {"round_keys": {"r1": contest_round.pk}}
            self.version.save(update_fields=["status", "is_current", "binding"])

        with self.assertRaises(PermissionDenied):
            configure_draft_round_from_planning(
                contest_round,
                operator=self.operator,
                configuration={"name": "冻结后修改"},
            )

        contest_round.refresh_from_db()
        self.assertEqual(contest_round.name, "第一轮")


class PlanningApplyServiceTests(PlanningDraftAuthorityTests):
    def _complete_payload(self):
        return _planning_payload(
            _planning_stage(
                judge_sources=[
                    {
                        "business_id": "round-1",
                        "format": "solo",
                        "scoring_mode": planning_field(
                            "average", PlanningResolution.CONFIRMED, "比赛方案", "text"
                        ),
                        "judge_count": planning_field(
                            5, PlanningResolution.CONFIRMED, "评委名单", "judge"
                        ),
                        "rubric": _planning_rubric(),
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

    def test_preflight_distinguishes_business_binding_and_freeze_states(self):
        payload = self._complete_payload()

        result = prepare_planning_preflight(self.version, payload)

        self.assertTrue(result.business_complete)
        self.assertTrue(result.binding_ready)
        self.assertTrue(result.freeze_ready)
        self.assertTrue(result.safe_to_apply)
        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), 0)

    def test_preflight_blocks_apply_when_audience_source_is_not_bound(self):
        payload = self._complete_payload()
        source = payload["stages"][0]["judge_sources"][0]
        source["weight"] = planning_field(90, "confirmed", "比赛方案", "percent")
        payload["stages"][0]["audience_source"] = planning_field(
            "audience1", "confirmed", "投票方案", "vote"
        )
        payload["stages"][0]["audience_weight"] = planning_field(
            10, "confirmed", "比赛方案", "percent"
        )
        payload["stages"][0]["audience_conversion"] = planning_field(
            "ballot_share_percent", "confirmed", "投票换算规则", "text"
        )

        result = prepare_planning_preflight(self.version, payload)

        self.assertTrue(result.business_complete)
        self.assertFalse(result.binding_ready)
        self.assertFalse(result.safe_to_apply)
        self.assertFalse(result.freeze_ready)
        self.assertIn("MISSING_VOTE_BINDING", {issue.code for issue in result.issues})

    def test_apply_rejects_execution_ref_owned_by_another_activity_before_creating_round(self):
        with authority_write(ACTIVITY_STATE):
            other_activity = Activity.objects.create(
                title="其他活动",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        with authority_write(CONTEST_ROUND_STATE):
            other_round = ContestRound.objects.create(
                activity=other_activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                status=ContestRound.Status.DRAFT,
            )
        payload = self._complete_payload()
        payload["execution_refs"] = {
            "rounds": {
                "round-1": {
                    "round_key": "round-1",
                    "round_id": other_round.pk,
                }
            }
        }
        draft = save_planning_draft(
            self.version,
            payload=payload,
            operator=self.operator,
            expected_revision=0,
        )

        with self.assertRaises(PermissionDenied):
            apply_planning_to_ruleset(
                self.version,
                operator=self.operator,
                expected_revision=draft.revision,
            )

        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), 0)

    def test_apply_rejects_changes_to_a_round_used_by_current_frozen_ruleset(self):
        rubric = ScoringRubric.objects.create(
            activity=self.activity,
            name="旧评分",
        )
        RubricCriterion.objects.create(rubric=rubric, name="演唱", max_score=100)
        with authority_write(CONTEST_ROUND_STATE):
            contest_round = ContestRound.objects.create(
                activity=self.activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="第1轮",
                judge_count=5,
                minimum_judge_count=4,
                rubric=rubric,
                advance_count=10,
                roster_source=ContestRound.RosterSource.APPROVED,
            )
        self.ruleset.round_keys = {"round-1": contest_round.pk}
        self.ruleset.save(update_fields=["round_keys"])
        with authority_write(RULESET_FREEZE):
            self.version.status = RulesetVersion.Status.FROZEN
            self.version.is_current = True
            self.version.binding = {"round_keys": {"round-1": contest_round.pk}}
            self.version.save(update_fields=["status", "is_current", "binding"])
        successor = RulesetVersion.objects.create(
            ruleset=self.ruleset,
            version=2,
            definition=self.version.definition,
            created_by=self.operator,
        )

        payload = self._complete_payload()
        source = payload["stages"][0]["judge_sources"][0]
        source["judge_count"] = planning_field(6, "confirmed", "评委名单", "judge")
        source["minimum_judge_count"] = planning_field(5, "confirmed", "比赛方案", "judge")
        source["rubric"]["name"] = planning_field(
            "新评分", "confirmed", "评分表", "text"
        )
        payload["execution_refs"] = {
            "rounds": {
                "round-1": {
                    "round_key": "round-1",
                    "round_id": contest_round.pk,
                }
            }
        }

        preflight = prepare_planning_preflight(successor, payload)
        self.assertFalse(preflight.safe_to_apply)
        self.assertIn("FROZEN_ROUND_CONFIGURATION", {issue.code for issue in preflight.issues})
        draft = save_planning_draft(
            successor,
            payload=payload,
            operator=self.operator,
            expected_revision=0,
        )
        before_definition = successor.definition

        with self.assertRaises(ValidationError):
            apply_planning_to_ruleset(
                successor,
                operator=self.operator,
                expected_revision=draft.revision,
            )

        contest_round.refresh_from_db()
        successor.refresh_from_db()
        self.assertEqual(contest_round.judge_count, 5)
        self.assertEqual(contest_round.minimum_judge_count, 4)
        self.assertEqual(contest_round.rubric_id, rubric.pk)
        self.assertEqual(ScoringRubric.objects.filter(activity=self.activity).count(), 1)
        self.assertEqual(successor.definition, before_definition)
        self.assertEqual(self.version.binding, {"round_keys": {"round-1": contest_round.pk}})

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

    def test_apply_materializes_explicit_judge_and_rubric_configuration(self):
        payload = self._complete_payload()
        source = payload["stages"][0]["judge_sources"][0]
        source["judge_count"] = planning_field(5, "confirmed", "评委名单", "judge")
        source["minimum_judge_count"] = planning_field(4, "confirmed", "比赛方案", "judge")
        source["rubric"] = {
            "name": planning_field("演唱评分", "confirmed", "评分表", "text"),
            "description": planning_field("每人单独评分", "confirmed", "评分表", "text"),
            "criteria": [
                {
                    "name": planning_field("演唱", "confirmed", "评分表", "text"),
                    "max_score": planning_field("100", "confirmed", "评分表", "score"),
                }
            ],
        }
        draft = save_planning_draft(
            self.version,
            payload=payload,
            operator=self.operator,
            expected_revision=0,
        )

        apply_planning_to_ruleset(
            self.version,
            operator=self.operator,
            expected_revision=draft.revision,
        )

        contest_round = ContestRound.objects.get(activity=self.activity)
        self.assertEqual(contest_round.judge_count, 5)
        self.assertEqual(contest_round.minimum_judge_count, 4)
        self.assertIsNotNone(contest_round.rubric_id)
        rubric = contest_round.rubric
        assert rubric is not None
        self.assertEqual(rubric.name, "演唱评分")
        self.assertEqual(rubric.criteria.get().max_score, 100)

        draft.refresh_from_db()
        apply_planning_to_ruleset(
            self.version,
            operator=self.operator,
            expected_revision=draft.revision,
        )

        self.assertEqual(
            ScoringRubric.objects.filter(activity=self.activity).count(),
            1,
        )
