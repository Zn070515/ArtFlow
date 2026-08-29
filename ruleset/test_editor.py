from decimal import Decimal

from django.test import SimpleTestCase

from ruleset.editor import (
    available_sources,
    definition_from_form,
    preview_definition,
    synthetic_resolve_input,
)
from ruleset.schema import ENTRY_KEY, parse_definition


class EditorSerializeTests(SimpleTestCase):
    def test_available_sources_only_lists_prior_keys_plus_entry(self):
        nodes = [
            {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            {"key": "b", "type": "RANK", "source": "a", "descending": True},
        ]
        self.assertEqual(available_sources(nodes, 0), [ENTRY_KEY])
        self.assertEqual(available_sources(nodes, 1), [ENTRY_KEY, "a"])

    def test_definition_from_form_roundtrips_an_assess_node(self):
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
        definition = definition_from_form(form)
        self.assertEqual(parse_definition(definition)["schema_version"], 1)
        self.assertEqual(definition["nodes"][0]["round"], "r1")
        self.assertEqual(definition["nodes"][0]["scale"], "hundred")

    def test_definition_from_form_roundtrips_aggregate_within_node_level(self):
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
        definition = definition_from_form(form)
        node = definition["nodes"][1]
        self.assertEqual(node["within"], ENTRY_KEY)
        self.assertEqual(node["aggregate"]["type"], "weighted_sum")
        self.assertEqual(node["aggregate"]["components"][0]["source"], "assess_r1")

    def test_definition_from_form_rejects_forward_reference(self):
        form = {
            "schema_version": "1",
            "node_0_key": "a",
            "node_0_type": "RANK",
            "node_0_source": "b",
            "node_order": "node_0",
        }
        self.assertRaises(Exception, definition_from_form, form)

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
