"""Characterization tests for the M1-C versioned typed ruleset schema (§8).

M1-C is schema-only: it must *parse* a typed definition JSON and express the §8.8
acceptance structures (weighted composite → TopN; partition → group direct → subtract →
repechage → merge → manual group selection → fill quota). It must NOT execute anything.
These tests pin the schema contracts so M1-D (the compiler/validator) cannot silently
regress them. Acceptance structures are *representative* — no hardcoded 2025 values.
"""

import json

from common.test_characterization import _CharacterizationBase
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.test import SimpleTestCase

from ruleset.models import ContestRuleset, RulesetTemplate, RulesetVersion
from ruleset.schema import (
    ENTRY_KEY,
    OutputType,
    canonical_json,
    content_hash,
    parse_definition,
)


def _def(nodes, context=None):
    definition = {"schema_version": 1, "nodes": nodes}
    if context is not None:
        definition["context"] = context
    return definition


# --- §8.8 acceptance structures -------------------------------------------


def weighted_composite_topn():
    """R1→R2: weighted composite → TopN."""
    return _def(
        [
            {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            {"key": "assess_r2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
            {
                "key": "composite",
                "type": "AGGREGATE",
                "aggregate": {
                    "type": "weighted_sum",
                    "components": [
                        {"source": "assess_r1", "weight": 0.4},
                        {"source": "assess_r2", "weight": 0.6},
                    ],
                },
            },
            {"key": "ranked", "type": "RANK", "source": "composite", "descending": True},
            {"key": "winners", "type": "SELECT", "source": "ranked", "count": 10},
        ]
    )


def weighted_previous_composite_topn():
    """R3: weighted previous composite → TopN."""
    return _def(
        [
            {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            {"key": "assess_r2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
            {
                "key": "prev_composite",
                "type": "AGGREGATE",
                "aggregate": {
                    "type": "weighted_sum",
                    "components": [
                        {"source": "assess_r1", "weight": 0.5},
                        {"source": "assess_r2", "weight": 0.5},
                    ],
                },
            },
            {"key": "assess_r3", "type": "ASSESS", "source": ENTRY_KEY, "round": "r3"},
            {
                "key": "final",
                "type": "AGGREGATE",
                "aggregate": {
                    "type": "weighted_sum",
                    "components": [
                        {"source": "prev_composite", "weight": 0.6},
                        {"source": "assess_r3", "weight": 0.4},
                    ],
                },
            },
            {"key": "ranked", "type": "RANK", "source": "final", "descending": True},
            {"key": "winners", "type": "SELECT", "source": "ranked", "count": 10},
        ]
    )


def partition_subtract_repechage_merge():
    """partition → group direct → subtract → repechage → merge → manual → fill quota."""
    return _def(
        [
            {"key": "groups", "type": "PARTITION", "source": ENTRY_KEY, "by": "class"},
            {"key": "scored", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            {"key": "ranked", "type": "RANK", "source": "scored", "descending": True},
            {"key": "advanced", "type": "SELECT", "source": "ranked", "count": 8},
            {
                "key": "leftover",
                "type": "SUBTRACT",
                "minuend": ENTRY_KEY,
                "subtrahend": "advanced",
            },
            {"key": "repech_scored", "type": "ASSESS", "source": "leftover", "round": "r1"},
            {"key": "repech_ranked", "type": "RANK", "source": "repech_scored"},
            {"key": "repech_winners", "type": "SELECT", "source": "repech_ranked", "count": 2},
            {"key": "merged", "type": "MERGE", "sources": ["advanced", "repech_winners"]},
            {"key": "manual", "type": "MANUAL_SELECT", "source": "merged", "groups": 3, "quota": 5},
            {
                "key": "filled",
                "type": "FILL_TO_QUOTA",
                "from": "merged",
                "into": "manual",
                "quota": 5,
            },
        ]
    )


def xiaofeng_chain():
    """2025 校十佳屏峰: 20 -> 5 groups x 4 -> top1/group -> 15 -> R1 top12 -> R2 top7
    -> merge 12 -> 3 groups x 4 -> manual 0~2/group -> fill to total 6.

    Generic example of the group-direct / remainder / repechage / merge / manual
    group decision / conditional-fill control flow. No dedicated resolver; only the
    M1-E linear nodes plus a `by`-scoped SELECT. No hardcoded 2025 values.
    """
    return _def(
        [
            {
                "key": "groups_initial",
                "type": "PARTITION",
                "source": ENTRY_KEY,
                "by": "initial_group",
            },
            {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            {"key": "rank_r1", "type": "RANK", "source": "assess_r1", "descending": True},
            {
                "key": "direct",
                "type": "SELECT",
                "source": "rank_r1",
                "count": 1,
                "by": "groups_initial",
            },
            {"key": "leftover", "type": "SUBTRACT", "minuend": ENTRY_KEY, "subtrahend": "direct"},
            {"key": "repech_r1", "type": "ASSESS", "source": "leftover", "round": "r1"},
            {"key": "repech_rank", "type": "RANK", "source": "repech_r1", "descending": True},
            {"key": "top12", "type": "SELECT", "source": "repech_rank", "count": 12},
            {"key": "repech_r2", "type": "ASSESS", "source": "top12", "round": "r2"},
            {"key": "repech_rank2", "type": "RANK", "source": "repech_r2", "descending": True},
            {"key": "top7", "type": "SELECT", "source": "repech_rank2", "count": 7},
            {"key": "merged", "type": "MERGE", "sources": ["direct", "top7"]},
            {"key": "final_groups", "type": "PARTITION", "source": "merged", "by": "final_group"},
            {
                "key": "manual",
                "type": "MANUAL_SELECT",
                "source": "final_groups",
                "groups": 3,
                "quota": 2,
            },
            {
                "key": "filled",
                "type": "FILL_TO_QUOTA",
                "from": "merged",
                "into": "manual",
                "quota": 2,
                "mode": "each_group",
            },
        ]
    )


# Simple, valid definition reused by the model-level tests.
DEF = json.dumps(
    _def(
        [
            {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            {"key": "r", "type": "RANK", "source": "a"},
            {"key": "s", "type": "SELECT", "source": "r", "count": 1},
        ]
    ),
    ensure_ascii=False,
)
OTHER_DEF = json.dumps(
    _def(
        [
            {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            {"key": "r", "type": "RANK", "source": "a"},
            {"key": "s", "type": "SELECT", "source": "r", "count": 2},
        ]
    ),
    ensure_ascii=False,
)


class SchemaAcceptanceStructureParsingTests(SimpleTestCase):
    """§8.8 — the schema can parse the target contest structures."""

    def test_weighted_composite_topn_parses(self):
        parsed = parse_definition(weighted_composite_topn())
        outputs = parsed["outputs"]
        self.assertEqual(outputs["assess_r1"], OutputType.SCOREMAP)
        self.assertEqual(outputs["assess_r2"], OutputType.SCOREMAP)
        self.assertEqual(outputs["composite"], OutputType.SCOREMAP)
        self.assertEqual(outputs["ranked"], OutputType.RANKED_ROSTER)
        self.assertEqual(outputs["winners"], OutputType.ROSTER)

    def test_weighted_previous_composite_topn_parses(self):
        parsed = parse_definition(weighted_previous_composite_topn())
        outputs = parsed["outputs"]
        self.assertEqual(outputs["prev_composite"], OutputType.SCOREMAP)
        self.assertEqual(outputs["assess_r3"], OutputType.SCOREMAP)
        self.assertEqual(outputs["final"], OutputType.SCOREMAP)
        self.assertEqual(outputs["ranked"], OutputType.RANKED_ROSTER)
        self.assertEqual(outputs["winners"], OutputType.ROSTER)

    def test_partition_subtract_repechage_merge_parses(self):
        parsed = parse_definition(partition_subtract_repechage_merge())
        outputs = parsed["outputs"]
        self.assertEqual(outputs["groups"], OutputType.GROUP_MAP)
        self.assertEqual(outputs["advanced"], OutputType.ROSTER)
        self.assertEqual(outputs["leftover"], OutputType.ROSTER)
        self.assertEqual(outputs["repech_winners"], OutputType.ROSTER)
        self.assertEqual(outputs["merged"], OutputType.ROSTER)
        self.assertEqual(outputs["manual"], OutputType.GROUP_MAP)
        self.assertEqual(outputs["filled"], OutputType.GROUP_MAP)

    def test_parses_json_string_too(self):
        parsed = parse_definition(json.dumps(weighted_composite_topn(), ensure_ascii=False))
        self.assertEqual(parsed["nodes"][-1]["key"], "winners")

    def test_group_scoped_select_parses(self):
        definition = _def(
            [
                {"key": "groups", "type": "PARTITION", "source": ENTRY_KEY, "by": "class"},
                {"key": "scored", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "ranked", "type": "RANK", "source": "scored", "descending": True},
                {
                    "key": "top1_each_group",
                    "type": "SELECT",
                    "source": "ranked",
                    "count": 1,
                    "by": "groups",
                },
            ]
        )
        parsed = parse_definition(definition)
        outputs = parsed["outputs"]
        self.assertEqual(outputs["groups"], OutputType.GROUP_MAP)
        self.assertEqual(outputs["top1_each_group"], OutputType.ROSTER)


class SchemaRejectionTests(SimpleTestCase):
    def test_unknown_node_type_rejected(self):
        bad = _def([{"key": "x", "type": "BLAH", "source": ENTRY_KEY}])
        with self.assertRaises(ValidationError):
            parse_definition(bad)

    def test_reserved_replace_rejected(self):
        bad = _def([{"key": "x", "type": "REPLACE"}])
        with self.assertRaises(ValidationError):
            parse_definition(bad)

    def test_entry_is_reserved(self):
        bad = _def([{"key": ENTRY_KEY, "type": "ROSTER"}])
        with self.assertRaises(ValidationError):
            parse_definition(bad)

    def test_duplicate_key_rejected(self):
        bad = _def(
            [
                {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "a", "type": "RANK", "source": "a"},
            ]
        )
        with self.assertRaises(ValidationError):
            parse_definition(bad)


class SchemaForwardOnlyTests(SimpleTestCase):
    """§8.6 — a node may only reference outputs emitted before it (no cycle possible)."""

    def test_forward_reference_rejected(self):
        bad = _def(
            [
                {"key": "a", "type": "ASSESS", "source": "b"},
                {"key": "b", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            ]
        )
        with self.assertRaises(ValidationError):
            parse_definition(bad)

    def test_undefined_source_rejected(self):
        bad = _def([{"key": "a", "type": "ASSESS", "source": "ghost", "round": "r1"}])
        with self.assertRaises(ValidationError):
            parse_definition(bad)

    def test_self_reference_rejected(self):
        bad = _def([{"key": "a", "type": "ASSESS", "source": "a", "round": "r1"}])
        with self.assertRaises(ValidationError):
            parse_definition(bad)

    def test_aggregate_component_forward_reference_rejected(self):
        bad = _def(
            [
                {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {
                    "key": "agg",
                    "type": "AGGREGATE",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [{"source": "b", "weight": 1.0}],
                    },
                },
                {"key": "b", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
            ]
        )
        with self.assertRaises(ValidationError):
            parse_definition(bad)


class SchemaOutputTypeMismatchTests(SimpleTestCase):
    def test_rank_on_group_map_rejected(self):
        bad = _def(
            [
                {"key": "g", "type": "PARTITION", "source": ENTRY_KEY, "by": "class"},
                {"key": "r", "type": "RANK", "source": "g"},
            ]
        )
        with self.assertRaises(ValidationError):
            parse_definition(bad)

    def test_select_on_group_map_rejected(self):
        bad = _def(
            [
                {"key": "g", "type": "PARTITION", "source": ENTRY_KEY, "by": "class"},
                {"key": "s", "type": "SELECT", "source": "g", "count": 1},
            ]
        )
        with self.assertRaises(ValidationError):
            parse_definition(bad)

    def test_assess_on_ranked_roster_rejected(self):
        bad = _def(
            [
                {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "r", "type": "RANK", "source": "a"},
                {"key": "a2", "type": "ASSESS", "source": "r", "round": "r2"},
            ]
        )
        with self.assertRaises(ValidationError):
            parse_definition(bad)

    def test_aggregate_component_type_mismatch_rejected(self):
        bad = _def(
            [
                {
                    "key": "s",
                    "type": "SUBTRACT",
                    "minuend": ENTRY_KEY,
                    "subtrahend": ENTRY_KEY,
                },
                {
                    "key": "agg",
                    "type": "AGGREGATE",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [{"source": "s", "weight": 1.0}],
                    },
                },
            ]
        )
        with self.assertRaises(ValidationError):
            parse_definition(bad)


class SchemaWeightValidationTests(SimpleTestCase):
    """§9.2 D2 — weight checks are structural (part of the typed schema)."""

    def _with_aggregate(self, components):
        return _def(
            [
                {"key": "a1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "a2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
                {
                    "key": "agg",
                    "type": "AGGREGATE",
                    "aggregate": {"type": "weighted_sum", "components": components},
                },
            ]
        )

    def test_negative_weight_rejected(self):
        bad = self._with_aggregate(
            [{"source": "a1", "weight": -0.1}, {"source": "a2", "weight": 0.6}]
        )
        with self.assertRaises(ValidationError):
            parse_definition(bad)

    def test_duplicate_source_rejected(self):
        bad = self._with_aggregate(
            [{"source": "a1", "weight": 0.5}, {"source": "a1", "weight": 0.5}]
        )
        with self.assertRaises(ValidationError):
            parse_definition(bad)

    def test_empty_components_rejected(self):
        bad = self._with_aggregate([])
        with self.assertRaises(ValidationError):
            parse_definition(bad)

    def test_zero_sum_rejected(self):
        bad = self._with_aggregate(
            [{"source": "a1", "weight": 0.0}, {"source": "a2", "weight": 0.0}]
        )
        with self.assertRaises(ValidationError):
            parse_definition(bad)

    def test_freeform_formula_rejected(self):
        bad = _def(
            [
                {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {
                    "key": "agg",
                    "type": "AGGREGATE",
                    "aggregate": {"type": "weighted_sum", "formula": "0.3 * a + ..."},
                },
            ]
        )
        with self.assertRaises(ValidationError):
            parse_definition(bad)


class SchemaVersionTests(SimpleTestCase):
    def test_default_schema_version_ok(self):
        definition = weighted_composite_topn()
        definition.pop("schema_version")
        parsed = parse_definition(definition)
        self.assertEqual(parsed["schema_version"], 1)

    def test_unsupported_schema_version_rejected(self):
        definition = weighted_composite_topn()
        definition["schema_version"] = 2
        with self.assertRaises(ValidationError):
            parse_definition(definition)


class SchemaContentHashTests(SimpleTestCase):
    def test_canonical_json_ignores_key_order_and_whitespace(self):
        first = {"a": {"b": 1, "c": [1, 2]}, "z": True}
        second = {"z": True, "a": {"c": [1, 2], "b": 1}}
        self.assertEqual(canonical_json(first), canonical_json(second))

    def test_content_hash_stable_and_sensitive(self):
        definition = weighted_composite_topn()
        self.assertEqual(
            content_hash(json.dumps(definition, ensure_ascii=False)),
            content_hash(json.dumps(definition, ensure_ascii=False, indent=2)),
        )
        changed = weighted_composite_topn()
        changed["nodes"][-1]["count"] = 20
        self.assertNotEqual(content_hash(definition), content_hash(changed))


class _RulesetModelBase(_CharacterizationBase):
    def make_ruleset(self, *, is_test_mode=False):
        return ContestRuleset.objects.create(
            activity=self.make_activity(is_test_mode=is_test_mode),
            name="RS",
            is_test_data=is_test_mode,
        )


class RulesetLifecycleInvariantTests(_RulesetModelBase):
    def test_test_marker_must_match_activity_lifecycle(self):
        formal = self.make_activity(is_test_mode=False)
        with self.assertRaises(ValidationError):
            ContestRuleset.objects.create(activity=formal, name="RS", is_test_data=True)

    def test_matching_test_marker_ok(self):
        formal = self.make_ruleset(is_test_mode=False)
        self.assertFalse(formal.is_test_data)
        test_ruleset = self.make_ruleset(is_test_mode=True)
        self.assertTrue(test_ruleset.is_test_data)


class RulesetVersionConstraintTests(_RulesetModelBase):
    def test_duplicate_version_for_ruleset_rejected(self):
        ruleset = self.make_ruleset()
        RulesetVersion.objects.create(ruleset=ruleset, version=1, definition=DEF, is_current=True)
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                RulesetVersion.objects.create(
                    ruleset=ruleset, version=1, definition=DEF, is_current=False
                )

    def test_second_current_for_ruleset_rejected(self):
        ruleset = self.make_ruleset()
        RulesetVersion.objects.create(ruleset=ruleset, version=1, definition=DEF, is_current=True)
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                RulesetVersion.objects.create(
                    ruleset=ruleset, version=2, definition=DEF, is_current=True
                )

    def test_sequential_versions_single_current_ok(self):
        ruleset = self.make_ruleset()
        RulesetVersion.objects.create(ruleset=ruleset, version=1, definition=DEF, is_current=False)
        RulesetVersion.objects.create(ruleset=ruleset, version=2, definition=DEF, is_current=True)
        self.assertEqual(RulesetVersion.objects.filter(ruleset=ruleset, is_current=True).count(), 1)
        self.assertEqual(RulesetVersion.objects.filter(ruleset=ruleset).count(), 2)

    def test_content_hash_computed_on_save(self):
        ruleset = self.make_ruleset()
        version = RulesetVersion.objects.create(
            ruleset=ruleset, version=1, definition=DEF, is_current=True
        )
        self.assertTrue(version.content_hash)
        self.assertEqual(version.content_hash, content_hash(DEF))


class RulesetTemplateIndependenceTests(_RulesetModelBase):
    def test_template_delete_nullifies_source_and_keeps_version(self):
        ruleset = self.make_ruleset()
        template = RulesetTemplate.objects.create(name="T", definition=DEF)
        ruleset.source_template = template
        ruleset.save(update_fields=["source_template"])
        version = RulesetVersion.objects.create(
            ruleset=ruleset, version=1, definition=DEF, is_current=True
        )
        template.delete()
        ruleset.refresh_from_db()
        self.assertIsNone(ruleset.source_template_id)
        self.assertTrue(RulesetVersion.objects.filter(pk=version.pk).exists())

    def test_editing_template_does_not_alter_frozen_version(self):
        ruleset = self.make_ruleset()
        template = RulesetTemplate.objects.create(name="T", definition=DEF)
        version = RulesetVersion.objects.create(
            ruleset=ruleset,
            version=1,
            definition=DEF,
            is_current=True,
            status=RulesetVersion.Status.FROZEN,
        )
        template.definition = OTHER_DEF
        template.save(update_fields=["definition"])
        version.refresh_from_db()
        self.assertEqual(version.definition, DEF)


class RulesetVersionImmutabilityTests(_RulesetModelBase):
    def make_frozen(self):
        ruleset = self.make_ruleset()
        return RulesetVersion.objects.create(
            ruleset=ruleset,
            version=1,
            definition=DEF,
            is_current=True,
            status=RulesetVersion.Status.FROZEN,
        )

    def test_frozen_version_rejects_definition_change(self):
        version = self.make_frozen()
        version.definition = OTHER_DEF
        with self.assertRaises(ValidationError):
            version.save()

    def test_frozen_version_rejects_status_change(self):
        version = self.make_frozen()
        version.status = RulesetVersion.Status.DRAFT
        with self.assertRaises(ValidationError):
            version.save()

    def test_frozen_version_delete_rejected(self):
        version = self.make_frozen()
        with self.assertRaises(ValidationError):
            version.delete()

    def test_frozen_version_queryset_update_rejected(self):
        version = self.make_frozen()
        with self.assertRaises(ValidationError):
            RulesetVersion.objects.filter(ruleset=version.ruleset).update(definition=OTHER_DEF)
