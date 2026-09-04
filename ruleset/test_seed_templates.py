from django.test import TestCase

from ruleset.compiler import compile_definition
from ruleset.models import RulesetTemplate
from ruleset.schema import parse_definition
from ruleset.templates import (
    FIRST_BATCH,
    GOLDEN_SCHIDUI,
    GOLDEN_XIAOFENG,
    HISTORICAL_XIAOFENG_CONTROL_FLOW,
    HISTORICAL_XIAOFENG_FALLBACK_UNRESOLVED,
    SYNTHETIC_FILL_TO_QUOTA_DEMO,
    seed_ruleset_templates,
)


class TemplateLibraryTests(TestCase):
    @staticmethod
    def _bound_context():
        return {
            "entry_size": 20,
            "rounds": {
                "r1": {"judge_count": 5, "scope": "full", "scale": "100"},
                "r2": {"judge_count": 5, "scope": "full", "scale": "100"},
            },
            "votes": {"audience1": {"scale": "hundred"}},
            "groups": {
                "groups_initial": {"capacity": [4, 4, 4, 4, 4]},
                "tracks": {"capacity": [10, 10]},
                "venues": {"capacity": [10, 10]},
            },
        }

    def test_golden_definitions_are_schema_valid(self):
        for definition in (
            GOLDEN_SCHIDUI,
            GOLDEN_XIAOFENG,
            HISTORICAL_XIAOFENG_CONTROL_FLOW,
            HISTORICAL_XIAOFENG_FALLBACK_UNRESOLVED,
            SYNTHETIC_FILL_TO_QUOTA_DEMO,
        ):
            parsed = parse_definition(definition)
            self.assertEqual(parsed["schema_version"], 1)
            self.assertTrue(parsed["nodes"])

    def test_first_batch_has_nine_unique_slots(self):
        self.assertEqual(FIRST_BATCH.__len__(), 9)
        keys = [t["key"] for t in FIRST_BATCH]
        self.assertEqual(len(keys), len(set(keys)))

    def test_first_batch_templates_are_bound_freeze_capable(self):
        for template in FIRST_BATCH:
            with self.subTest(template=template["key"]):
                report, plan = compile_definition(
                    template["definition"], context=self._bound_context(), bound=True
                )
                self.assertTrue(report.passes(), report.codes())
                self.assertIsNotNone(plan)

    def test_judge_audience_composite_declares_score_component(self):
        template = next(t for t in FIRST_BATCH if t["key"] == "judge_audience_composite")
        audience_node = next(
            node
            for node in parse_definition(template["definition"])["nodes"]
            if node["key"] == "assess_a1"
        )
        self.assertEqual(audience_node["vote_purpose"], "SCORE_COMPONENT")

    def test_independent_popularity_award_is_not_seeded_as_production_template(self):
        seed_ruleset_templates(None)
        self.assertFalse(RulesetTemplate.objects.filter(name="独立人气奖").exists())

    def test_first_batch_elements_are_schema_valid(self):
        for t in FIRST_BATCH:
            self.assertEqual(parse_definition(t["definition"])["schema_version"], 1)
            self.assertTrue(t["name"])

    def test_seed_is_idempotent(self):
        seed_ruleset_templates(None)
        first = RulesetTemplate.objects.count()
        # 2 golden + 3 historical/synthetic scenarios + 9 production templates.
        self.assertEqual(first, 14)
        seed_ruleset_templates(None)
        self.assertEqual(RulesetTemplate.objects.count(), first)

    def test_seeded_templates_have_hashes(self):
        seed_ruleset_templates(None)
        for t in RulesetTemplate.objects.all():
            self.assertTrue(t.content_hash)

    def test_seed_creates_golden_templates(self):
        seed_ruleset_templates(None)
        self.assertEqual(RulesetTemplate.objects.filter(name="院十佳").count(), 1)
        self.assertEqual(RulesetTemplate.objects.filter(name="合成_分组逐组补足演示").count(), 1)

    def test_xiaofeng_demo_is_not_passed_off_as_historical_golden(self):
        # §23: the each_group control-flow demo must not claim to be the verified
        # 2025 校十佳屏峰 Golden — that is what historical_xiaofeng_control_flow is for.
        import ruleset.templates as _templates

        entry = next(e for e in _templates._catalog() if e[0] == "合成_分组逐组补足演示")
        description = entry[2]
        self.assertIn("演示", description)
        self.assertNotIn("2025 校十佳屏峰：", description)
