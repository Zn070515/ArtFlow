from django.test import TestCase

from ruleset.models import RulesetTemplate
from ruleset.schema import parse_definition
from ruleset.templates import (
    FIRST_BATCH,
    GOLDEN_SCHIDUI,
    GOLDEN_XIAOFENG,
    seed_ruleset_templates,
)


class TemplateLibraryTests(TestCase):
    def test_golden_definitions_are_schema_valid(self):
        for definition in (GOLDEN_SCHIDUI, GOLDEN_XIAOFENG):
            parsed = parse_definition(definition)
            self.assertEqual(parsed["schema_version"], 1)
            self.assertTrue(parsed["nodes"])

    def test_first_batch_has_ten_unique_slots(self):
        self.assertEqual(FIRST_BATCH.__len__(), 10)
        keys = [t["key"] for t in FIRST_BATCH]
        self.assertEqual(len(keys), len(set(keys)))

    def test_first_batch_elements_are_schema_valid(self):
        for t in FIRST_BATCH:
            self.assertEqual(parse_definition(t["definition"])["schema_version"], 1)
            self.assertTrue(t["name"])

    def test_seed_is_idempotent(self):
        seed_ruleset_templates(None)
        first = RulesetTemplate.objects.count()
        self.assertEqual(first, 12)
        seed_ruleset_templates(None)
        self.assertEqual(RulesetTemplate.objects.count(), first)

    def test_seeded_templates_have_hashes(self):
        seed_ruleset_templates(None)
        for t in RulesetTemplate.objects.all():
            self.assertTrue(t.content_hash)

    def test_seed_creates_golden_templates(self):
        seed_ruleset_templates(None)
        self.assertEqual(RulesetTemplate.objects.filter(name="院十佳").count(), 1)
        self.assertEqual(RulesetTemplate.objects.filter(name="校十佳屏峰").count(), 1)
