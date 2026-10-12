from copy import deepcopy

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from ruleset.business_editor import business_definition_from_stages, infer_business_stages
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
        self.assertEqual(nodes[1]["aggregate"]["components"], [{"source": "assess_r1", "weight": 1}])
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

        self.assertEqual(checkpoints, [{"key": "stage1", "output": "top10"}, {"key": "stage2", "output": "top3"}])
        stage2 = next(node for node in nodes if node["key"] == "stage2")
        self.assertEqual(
            stage2["aggregate"]["components"],
            [{"source": "stage1", "weight": 0.6}, {"source": "assess_r2", "weight": 0.4}],
        )
        self.assertEqual(next(node for node in nodes if node["key"] == "assess_r2")["source"], "top10")

    def test_judge_and_audience_weights_are_explicit_and_deterministic(self):
        stages = [_stage()]
        original = deepcopy(stages)
        first = business_definition_from_stages(stages)
        second = business_definition_from_stages(stages)

        self.assertEqual(first, second)
        self.assertEqual(stages, original)
        self.assertEqual(
            next(node for node in first[0] if node["type"] == "AGGREGATE")["aggregate"]["components"],
            [
                {"source": "assess_r1", "weight": 0.6},
                {"source": "assess_audience1", "weight": 0.4},
            ],
        )

    def test_weights_must_sum_to_one(self):
        with self.assertRaises(ValidationError):
            business_definition_from_stages([_stage(judge_weight="0.7")])


class BusinessDefinitionInferenceTests(SimpleTestCase):
    def test_golden_linear_definition_is_editable_without_mutating_it(self):
        definition = golden_schidui()
        result = infer_business_stages(definition)

        self.assertTrue(result["supported"])
        self.assertTrue(result["editable"])
        self.assertEqual([stage["key"] for stage in result["stages"]], ["stage1", "stage2", "stage3"])
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
                    {"key": "manual", "type": "MANUAL_SELECT", "source": "groups", "groups": 2, "quota": 1},
                ],
            }
        )

        self.assertFalse(result["supported"])
        self.assertFalse(result["editable"])
        self.assertIn("分组", result["reason"])
