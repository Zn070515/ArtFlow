import json
from decimal import Decimal

from django.test import SimpleTestCase

from ruleset.editor import (
    available_sources,
    definition_nodes,
    human_ruleset_summary,
    nodes_from_form,
    preview_definition,
    synthetic_resolve_input,
)
from ruleset.schema import ENTRY_KEY, parse_definition
from ruleset.templates import golden_schidui


class HumanRulesetSummaryTests(SimpleTestCase):
    def test_summary_projects_checkpoints_into_human_stages(self):
        summary = human_ruleset_summary(golden_schidui())

        self.assertTrue(summary["supported"])
        self.assertEqual(summary["flow_label"], "全部选手 → 10 强 → 5 强 → 3 强")
        self.assertEqual(
            [stage["advance_count"] for stage in summary["stages"]],
            [10, 5, 3],
        )
        self.assertEqual(
            [
                [component["weight_label"] for component in stage["components"]]
                for stage in summary["stages"]
            ],
            [["30%", "60%", "10%"], ["60%", "40%"], ["30%", "50%", "20%"]],
        )
        self.assertEqual(summary["stages"][1]["components"][0]["label"], "上一阶段综合成绩")
        self.assertEqual(summary["stages"][0]["components"][2]["kind"], "audience")
        self.assertEqual(summary["node_titles"]["stage1"], "第一阶段综合成绩")
        self.assertEqual(summary["node_titles"]["top10"], "第一阶段晋级名单（10人）")

    def test_summary_uses_bound_labels_without_changing_technical_keys(self):
        summary = human_ruleset_summary(
            golden_schidui(),
            round_labels={"r1": "第一轮 · 小组合唱"},
            vote_labels={"audience1": "第一阶段现场投票"},
        )

        components = summary["stages"][0]["components"]
        self.assertEqual(components[0]["label"], "第一轮 · 小组合唱评委成绩")
        self.assertEqual(components[2]["label"], "第一阶段现场投票")
        self.assertEqual(components[0]["source_key"], "assess_r1")

    def test_summary_marks_manual_decisions_for_conditional_ui(self):
        definition = {
            "schema_version": 1,
            "nodes": [
                {"key": "groups", "type": "PARTITION", "source": ENTRY_KEY, "by": "group"},
                {
                    "key": "manual",
                    "type": "MANUAL_SELECT",
                    "source": "groups",
                    "groups": 2,
                    "quota": 1,
                },
            ],
        }

        summary = human_ruleset_summary(definition)

        self.assertFalse(summary["supported"])
        self.assertTrue(summary["has_manual_decision"])


class EditorSerializeTests(SimpleTestCase):
    def test_available_sources_only_lists_prior_keys_plus_entry(self):
        nodes = [
            {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            {"key": "b", "type": "RANK", "source": "a", "descending": True},
        ]
        self.assertEqual(available_sources(nodes, 0), [ENTRY_KEY])
        self.assertEqual(available_sources(nodes, 1), [ENTRY_KEY, "a"])

    def test_definition_nodes_reads_the_raw_root(self):
        """The editor round-trips what was written, not ``parse_definition``'s normalized view."""
        raw = {
            "schema_version": 1,
            "nodes": [{"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"}],
            "context": {"kept": True},
        }
        self.assertEqual(definition_nodes(json.dumps(raw)), raw["nodes"])
        self.assertEqual(definition_nodes(raw), raw["nodes"])

    def test_definition_nodes_rejects_a_root_without_nodes(self):
        self.assertRaises(Exception, definition_nodes, '{"schema_version": 1}')
        self.assertRaises(Exception, definition_nodes, "not json")

    def test_nodes_from_form_roundtrips_an_assess_node(self):
        form = {
            "schema_version": "1",
            "node_0_key": "assess_r1",
            "node_0_type": "ASSESS",
            "node_0_source": ENTRY_KEY,
            "node_0_round": "r1",
            "node_0_scale": "hundred",
            "node_0_mode": "mean",
            "node_0_descending": "",
            "node_order": "node_0",
        }
        nodes = nodes_from_form(form)
        self.assertIsInstance(nodes, list)
        self.assertEqual(parse_definition({"nodes": nodes})["schema_version"], 1)
        self.assertEqual(nodes[0]["round"], "r1")
        self.assertEqual(nodes[0]["scale"], "hundred")

    def test_nodes_from_form_roundtrips_aggregate_within_node_level(self):
        form = {
            "schema_version": "1",
            "node_0_key": "assess_r1",
            "node_0_type": "ASSESS",
            "node_0_source": ENTRY_KEY,
            "node_0_round": "r1",
            "node_1_key": "comp",
            "node_1_type": "AGGREGATE",
            "node_1_aggregate_type": "weighted_sum",
            "node_1_aggregate_component_0_source": "assess_r1",
            "node_1_aggregate_component_0_weight": "0.4",
            "node_1_within": ENTRY_KEY,
            "node_order": "node_0,node_1",
        }
        nodes = nodes_from_form(form)
        node = nodes[1]
        self.assertEqual(node["within"], ENTRY_KEY)
        self.assertEqual(node["aggregate"]["type"], "weighted_sum")
        self.assertEqual(node["aggregate"]["components"][0]["source"], "assess_r1")

    def test_nodes_from_form_rejects_forward_reference(self):
        form = {
            "schema_version": "1",
            "node_0_key": "a",
            "node_0_type": "RANK",
            "node_0_source": "b",
            "node_order": "node_0",
        }
        self.assertRaises(Exception, nodes_from_form, form)

    def test_synthetic_resolve_input_has_scores_for_each_round(self):
        definition = {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "assess_r2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
            ],
        }
        inputs = synthetic_resolve_input(definition)
        self.assertIn("r1", inputs.round_scores)
        self.assertIn("r2", inputs.round_scores)
        self.assertEqual(len(inputs.roster), 16)
        self.assertIsInstance(inputs.round_scores["r1"]["1"][0], Decimal)

    def test_preview_definition_returns_report_plan_result(self):
        definition = {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "assess_r2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
                {
                    "key": "comp",
                    "type": "AGGREGATE",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "assess_r1", "weight": 0.4},
                            {"source": "assess_r2", "weight": 0.6},
                        ],
                    },
                },
                {"key": "rank", "type": "RANK", "source": "comp", "descending": True},
                {"key": "top", "type": "SELECT", "source": "rank", "count": 10},
            ],
        }
        report, plan, result = preview_definition(definition)
        self.assertTrue(report.passes())
        self.assertIsNotNone(plan)
        self.assertIsNotNone(result)
