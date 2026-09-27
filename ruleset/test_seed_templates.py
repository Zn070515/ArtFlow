from decimal import Decimal
from typing import cast

from django.test import TestCase

from ruleset.compiler import compile_definition
from ruleset.models import RulesetTemplate
from ruleset.resolver import ResolveInput, ResolverState, resolve
from ruleset.schema import parse_definition
from ruleset.templates import (
    FIRST_BATCH,
    GOLDEN_SCHIDUI,
    GOLDEN_SCHIDUI_BUILTIN_KEY,
    GOLDEN_XIAOFENG,
    HISTORICAL_SCHIDUI_NAME,
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

    def test_first_batch_has_ten_unique_slots(self):
        self.assertEqual(FIRST_BATCH.__len__(), 10)
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

    def test_independent_popularity_award_is_seeded_as_production_template(self):
        seed_ruleset_templates(None)
        template = RulesetTemplate.objects.get(name="独立人气奖")
        self.assertTrue(template.is_available)
        self.assertIn('"type": "AWARD"', template.definition)

    def test_removed_builtins_are_retired_and_not_cloneable(self):
        RulesetTemplate.objects.create(
            name="独立人气奖", definition=GOLDEN_SCHIDUI, is_available=True
        )
        seed_ruleset_templates(None)
        current = RulesetTemplate.objects.get(name="独立人气奖")
        self.assertTrue(current.is_available)
        self.assertIn('"type": "AWARD"', current.definition)
        fallback = RulesetTemplate.objects.get(name="校十佳屏峰_历史未决回退")
        self.assertFalse(fallback.is_available)

    def test_seeded_pk_template_resolves_pair_winners(self):
        template = next(t for t in FIRST_BATCH if t["key"] == "seeded_pk_wildcard")
        scores = {str(i): (Decimal(str(100 - i)),) for i in range(1, 9)}
        result = resolve(
            template["definition"],
            ResolveInput(
                roster=tuple(str(i) for i in range(1, 9)),
                round_scores={"r1": scores},
                duel_decisions={"duel": {"1|2": "1", "3|4": "4", "5|6": "5", "7|8": "8"}},
            ),
        )
        self.assertEqual(result.status, ResolverState.READY)
        duel = cast(dict, result.node_values["duel"])
        self.assertEqual(duel["winners"], ["1", "4", "5", "8"])

    def test_first_batch_elements_are_schema_valid(self):
        for t in FIRST_BATCH:
            self.assertEqual(parse_definition(t["definition"])["schema_version"], 1)
            self.assertTrue(t["name"])

    def test_seed_is_idempotent(self):
        seed_ruleset_templates(None)
        first = RulesetTemplate.objects.count()
        # 2 golden + 3 historical/synthetic scenarios + 10 production templates.
        self.assertEqual(first, 15)
        seed_ruleset_templates(None)
        self.assertEqual(RulesetTemplate.objects.count(), first)

    def test_seeded_templates_have_hashes(self):
        seed_ruleset_templates(None)
        for t in RulesetTemplate.objects.all():
            self.assertTrue(t.content_hash)

    def test_seed_creates_golden_templates(self):
        seed_ruleset_templates(None)
        self.assertEqual(RulesetTemplate.objects.filter(name=HISTORICAL_SCHIDUI_NAME).count(), 1)
        self.assertEqual(RulesetTemplate.objects.filter(name="合成_分组逐组补足演示").count(), 1)

    def test_fresh_seed_creates_exactly_one_golden_schidui(self):
        seed_ruleset_templates(None)
        rows = RulesetTemplate.objects.filter(builtin_key=GOLDEN_SCHIDUI_BUILTIN_KEY)
        self.assertEqual(rows.count(), 1)
        row = rows.get()
        self.assertEqual(row.name, HISTORICAL_SCHIDUI_NAME)
        self.assertIn("2025", row.description)
        self.assertEqual(row.capability_status, RulesetTemplate.CapabilityStatus.PRODUCTION)
        self.assertTrue(row.is_available)

    def test_reseeding_renames_a_builtin_row_in_place(self):
        seed_ruleset_templates(None)
        row = RulesetTemplate.objects.get(builtin_key=GOLDEN_SCHIDUI_BUILTIN_KEY)
        RulesetTemplate.objects.filter(pk=row.pk).update(name="院十佳", description="旧描述")

        seed_ruleset_templates(None)

        self.assertEqual(
            RulesetTemplate.objects.filter(builtin_key=GOLDEN_SCHIDUI_BUILTIN_KEY).count(), 1
        )
        row.refresh_from_db()
        self.assertEqual(row.name, HISTORICAL_SCHIDUI_NAME)
        self.assertIn("历史模板", row.description)
        self.assertFalse(RulesetTemplate.objects.filter(name="院十佳").exists())

    def test_keyless_legacy_row_is_adopted_instead_of_duplicated(self):
        # A pre-builtin_key database holds 院十佳 with an empty key; seeding must adopt that
        # row (exact name match, single row) rather than fork a second built-in template.
        RulesetTemplate.objects.create(
            name="院十佳", definition=GOLDEN_SCHIDUI, description="legacy", is_available=True
        )

        seed_ruleset_templates(None)

        self.assertEqual(
            RulesetTemplate.objects.filter(builtin_key=GOLDEN_SCHIDUI_BUILTIN_KEY).count(), 1
        )
        self.assertEqual(RulesetTemplate.objects.filter(name="院十佳 2025（历史模板）").count(), 1)
        self.assertEqual(RulesetTemplate.objects.count(), 15)

    def test_2025_definition_content_is_unchanged(self):
        # §11.3: renaming the template must not touch the historical 2025 rules.
        seed_ruleset_templates(None)
        row = RulesetTemplate.objects.get(builtin_key=GOLDEN_SCHIDUI_BUILTIN_KEY)
        self.assertEqual(row.definition, GOLDEN_SCHIDUI)
        weights = [
            component["weight"]
            for node in parse_definition(row.definition)["nodes"]
            if node["type"] == "AGGREGATE"
            for component in node["aggregate"]["components"]
        ]
        self.assertIn(0.3, weights)
        self.assertIn(0.6, weights)
        self.assertIn(0.1, weights)
        self.assertIn(0.5, weights)
        self.assertIn(0.2, weights)
        self.assertIn(0.4, weights)

    def test_xiaofeng_demo_is_not_passed_off_as_historical_golden(self):
        # §23: the each_group control-flow demo must not claim to be the verified
        # 2025 校十佳屏峰 Golden — that is what historical_xiaofeng_control_flow is for.
        import ruleset.templates as _templates

        entry = next(e for e in _templates._catalog() if e[0] == "合成_分组逐组补足演示")
        description = entry[2]
        self.assertIn("演示", description)
        self.assertNotIn("2025 校十佳屏峰：", description)
