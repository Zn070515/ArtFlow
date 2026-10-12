import json
from copy import deepcopy
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from ruleset.business_editor import business_definition_from_stages, infer_business_stages
from ruleset.resolver import ResolveInput, resolve
from ruleset.templates import golden_schidui


def _stage(**overrides):
    value = {
        "key": "stage1",
        "name": "初赛",
        "round_key": "r1",
        "round_name": "第一轮",
        "advance_count": 10,
        "judge_weight": "0.6",
        "previous_weight": "0",
        "audience_weight": "0.4",
        "vote_source": "audience1",
    }
    value.update(overrides)
    return value


class BusinessDefinitionGenerationTests(SimpleTestCase):
    def test_empty_stages_keep_only_a_roster_node(self):
        nodes, checkpoints, context = business_definition_from_stages([])

        self.assertEqual(nodes, [{"key": "roster", "type": "ROSTER"}])
        self.assertEqual(checkpoints, [])
        self.assertEqual(context["business"]["stages"], [])

    def test_one_stage_generates_score_rank_select_and_checkpoint(self):
        nodes, checkpoints, context = business_definition_from_stages(
            [_stage(judge_weight="1", audience_weight="0", vote_source="")]
        )

        self.assertEqual(
            [node["type"] for node in nodes],
            ["ASSESS", "AGGREGATE", "RANK", "SELECT"],
        )
        self.assertEqual(checkpoints, [{"key": "stage1", "output": "top10"}])
        self.assertEqual(nodes[0]["round"], "r1")
        self.assertEqual(
            nodes[1]["aggregate"]["components"], [{"source": "assess_r1", "weight": 1}]
        )
        self.assertEqual(context["business"]["stages"][0]["key"], "stage1")

    def test_two_stages_can_inherit_the_previous_composite_score(self):
        nodes, checkpoints, _ = business_definition_from_stages(
            [
                _stage(judge_weight="1", audience_weight="0", vote_source=""),
                _stage(
                    key="stage2",
                    name="决赛",
                    round_key="r2",
                    round_name="第二轮",
                    advance_count=3,
                    judge_weight="0.4",
                    previous_weight="0.6",
                    audience_weight="0",
                    vote_source="",
                ),
            ]
        )

        self.assertEqual(
            checkpoints, [{"key": "stage1", "output": "top10"}, {"key": "stage2", "output": "top3"}]
        )
        stage2 = next(node for node in nodes if node["key"] == "stage2")
        self.assertEqual(
            stage2["aggregate"]["components"],
            [{"source": "stage1", "weight": 0.6}, {"source": "assess_r2", "weight": 0.4}],
        )
        self.assertEqual(
            next(node for node in nodes if node["key"] == "assess_r2")["source"], "top10"
        )

    def test_judge_and_audience_weights_are_explicit_and_deterministic(self):
        stages = [_stage()]
        original = deepcopy(stages)
        first = business_definition_from_stages(stages)
        second = business_definition_from_stages(stages)

        self.assertEqual(first, second)
        self.assertEqual(stages, original)
        self.assertEqual(
            next(node for node in first[0] if node["type"] == "AGGREGATE")["aggregate"][
                "components"
            ],
            [
                {"source": "assess_r1", "weight": 0.6},
                {"source": "assess_audience1", "weight": 0.4},
            ],
        )

    def test_weights_must_sum_to_one(self):
        with self.assertRaises(ValidationError):
            business_definition_from_stages([_stage(judge_weight="0.7")])

    def test_drop_high_low_generates_trimmed_mean_assess_nodes(self):
        nodes, _, _ = business_definition_from_stages(
            [
                _stage(
                    judge_weight="1",
                    audience_weight="0",
                    vote_source="",
                    scoring_mode="drop_high_low",
                )
            ]
        )

        assess = next(node for node in nodes if node["type"] == "ASSESS")
        self.assertEqual(assess["mode"], "trimmed_mean")
        self.assertEqual(assess["trim_high"], 1)
        self.assertEqual(assess["trim_low"], 1)

    def test_drop_high_low_generated_definition_executes_trimmed_mean(self):
        nodes, checkpoints, _ = business_definition_from_stages(
            [
                _stage(
                    judge_weight="1",
                    audience_weight="0",
                    vote_source="",
                    scoring_mode="drop_high_low",
                )
            ]
        )

        result = resolve(
            {"schema_version": 1, "nodes": nodes, "checkpoints": checkpoints},
            ResolveInput(
                roster=("c1",),
                round_scores={
                    "r1": {"c1": (Decimal("10"), Decimal("8"), Decimal("9"), Decimal("7"))}
                },
            ),
        )

        self.assertEqual(result.composites[0].value, Decimal("8.5"))

    def test_changed_stage_quota_remaps_historical_roster_sources(self):
        projection = infer_business_stages(golden_schidui())
        stages = deepcopy(projection["stages"])
        stages[0]["advance_count"] = 8

        nodes, checkpoints, _context = business_definition_from_stages(stages)

        r3 = next(node for node in nodes if node.get("round") == "r3")
        self.assertEqual(r3["source"], "top8")
        self.assertNotIn(
            "top10",
            [node.get("source") for node in nodes if node["type"] == "ASSESS"],
        )

    def test_stage_roster_sources_follow_stable_stage_keys(self):
        nodes, _, _ = business_definition_from_stages(
            [
                _stage(judge_weight="1", audience_weight="0", vote_source=""),
                _stage(
                    key="stage2",
                    name="复赛",
                    round_key="r2",
                    judge_weight="1",
                    audience_weight="0",
                    vote_source="",
                    source_stage_key="stage1",
                ),
                _stage(
                    key="stage3",
                    name="决赛",
                    round_key="r3",
                    judge_weight="1",
                    audience_weight="0",
                    vote_source="",
                    source_stage_key="stage1",
                ),
            ]
        )

        self.assertEqual(
            next(node for node in nodes if node.get("round") == "r3")["source"],
            "top10",
        )

    def test_audience_source_pool_round_trips_and_remaps(self):
        definition = {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
                {
                    "key": "assess_a1",
                    "type": "ASSESS",
                    "source": "entry",
                    "vote_source": "audience1",
                    "vote_purpose": "SCORE_COMPONENT",
                },
                {
                    "key": "stage1",
                    "type": "AGGREGATE",
                    "within": "entry",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "assess_r1", "weight": 0.6},
                            {"source": "assess_a1", "weight": 0.4},
                        ],
                    },
                },
                {"key": "rank1", "type": "RANK", "source": "stage1", "descending": True},
                {"key": "top10", "type": "SELECT", "source": "rank1", "count": 10},
                {"key": "assess_r2", "type": "ASSESS", "source": "top10", "round": "r2"},
                {
                    "key": "assess_a2",
                    "type": "ASSESS",
                    "source": "entry",
                    "vote_source": "audience2",
                    "vote_purpose": "SCORE_COMPONENT",
                },
                {
                    "key": "stage2",
                    "type": "AGGREGATE",
                    "within": "top10",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "assess_r2", "weight": 0.6},
                            {"source": "assess_a2", "weight": 0.4},
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
        }

        projection = infer_business_stages(definition)
        self.assertEqual(projection["stages"][1]["audience_source"], "entry")
        self.assertEqual(projection["stages"][1]["audience_source_stage_key"], "entry")

        stages = deepcopy(projection["stages"])
        stages[0]["advance_count"] = 8
        nodes, checkpoints, _context = business_definition_from_stages(stages)

        audience = next(node for node in nodes if node.get("vote_source") == "audience2")
        self.assertEqual(audience["source"], "entry")
        inputs = ResolveInput(
            roster=tuple(f"c{index}" for index in range(1, 16)),
            round_scores={
                "r1": {f"c{index}": (Decimal("100"),) for index in range(1, 16)},
                "r2": {f"c{index}": (Decimal("90"),) for index in range(1, 11)},
            },
            vote_scores={
                "audience1": {f"c{index}": Decimal("50") for index in range(1, 16)},
                "audience2": {f"c{index}": Decimal("40") for index in range(1, 11)},
            },
        )
        before = resolve(definition, inputs)
        after = resolve({"schema_version": 1, "nodes": nodes, "checkpoints": checkpoints}, inputs)
        self.assertEqual(before.status, after.status)


class BusinessDefinitionInferenceTests(SimpleTestCase):
    def test_roster_only_definition_is_an_editable_blank(self):
        result = infer_business_stages(
            {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]}
        )

        self.assertTrue(result["supported"])
        self.assertTrue(result["editable"])
        self.assertEqual(result["stages"], [])

    def test_business_context_metadata_is_projected_from_the_raw_definition(self):
        definition = json.loads(golden_schidui())
        definition["context"] = {
            "business": {
                "stages": [
                    {"key": "stage1", "name": "保留的初赛名称"},
                    {"key": "stage2", "name": "保留的复赛名称"},
                    {"key": "stage3", "name": "保留的决赛名称"},
                ]
            }
        }

        result = infer_business_stages(json.dumps(definition, ensure_ascii=False))

        self.assertEqual(
            [stage["name"] for stage in result["stages"]],
            ["保留的初赛名称", "保留的复赛名称", "保留的决赛名称"],
        )

    def test_inference_rejects_semantics_the_business_form_cannot_preserve(self):
        for field, value in (("min_judges", 3), ("scale", "hundred")):
            with self.subTest(field=field):
                definition = {
                    "schema_version": 1,
                    "nodes": [
                        {
                            "key": "assess_r1",
                            "type": "ASSESS",
                            "source": "entry",
                            "round": "r1",
                            field: value,
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
                    ],
                    "checkpoints": [{"key": "stage1", "output": "top1"}],
                }

                result = infer_business_stages(definition)

                self.assertFalse(result["editable"])
                self.assertIn("无损", result["reason"])

    def test_inference_rejects_explicit_aggregate_conversion(self):
        definition = json.loads(golden_schidui())
        stage1 = next(node for node in definition["nodes"] if node["key"] == "stage1")
        stage1["conversion"] = {
            "to": 100,
            "conversions": [
                {"source": "assess_r1", "from": 100, "to": 100, "method": "factor", "factor": 1}
            ],
        }

        result = infer_business_stages(definition)

        self.assertFalse(result["editable"])
        self.assertIn("换算", result["reason"])

    def test_inference_rejects_tie_policy_and_disconnected_nodes(self):
        definition = json.loads(golden_schidui())
        next(node for node in definition["nodes"] if node["key"] == "rank1")["tie_policy"] = (
            "review"
        )
        definition["nodes"].append(
            {"key": "orphan", "type": "ASSESS", "source": "entry", "round": "unused"}
        )

        result = infer_business_stages(definition)

        self.assertFalse(result["editable"])
        self.assertIn("无损", result["reason"])

    def test_golden_linear_definition_is_editable_without_mutating_it(self):
        definition = golden_schidui()
        result = infer_business_stages(definition)

        self.assertTrue(result["supported"])
        self.assertTrue(result["editable"])
        self.assertEqual(
            [stage["key"] for stage in result["stages"]], ["stage1", "stage2", "stage3"]
        )
        self.assertEqual([stage["advance_count"] for stage in result["stages"]], [10, 5, 3])
        self.assertEqual(result["stages"][0]["judge_weight"], "0.9")
        self.assertEqual(
            [source["weight"] for source in result["stages"][0]["judge_sources"]],
            ["0.3", "0.6"],
        )
        self.assertEqual(result["stages"][0]["audience_weight"], "0.1")

    def test_manual_or_group_graph_is_read_only(self):
        result = infer_business_stages(
            {
                "schema_version": 1,
                "nodes": [
                    {"key": "groups", "type": "PARTITION", "source": "entry", "by": "group"},
                    {
                        "key": "manual",
                        "type": "MANUAL_SELECT",
                        "source": "groups",
                        "groups": 2,
                        "quota": 1,
                    },
                ],
            }
        )

        self.assertFalse(result["supported"])
        self.assertFalse(result["editable"])
        self.assertIn("分组", result["reason"])
