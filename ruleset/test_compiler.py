"""Tests for the M1-D ruleset compiler (§16) and the freeze service (§8.2).

Covers the pure, DB-free compiler split into two parts:
  * VALID corpus — the §8.8 acceptance structures and a fully-annotated clean
    definition compile with ``report.passes()`` (no ERROR).
  * INVALID corpus — each D1–D8 violation surfaces its canonical error code and
    fails ``passes()``, including the golden dependency-completeness error.

And the freeze service: the transaction only freezes a clean DRAFT version,
demotes the prior current through the base manager (the immutable-guard trap),
and audits via FINALIZE_RULESET.
"""

import json

from accounts.models import User
from common.authority import RULESET_FREEZE, STAGE_RESULT_CONFIRM, authority_write
from common.models import AuditLog
from django.contrib import admin
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import RequestFactory, SimpleTestCase

from ruleset.compiler import (
    ExecutionPlan,
    compile_definition,
)
from ruleset.models import ContestRuleset, RulesetTemplate, RulesetVersion
from ruleset.schema import ENTRY_KEY, content_hash
from ruleset.services import (
    RulesetInvalidError,
    create_ruleset_version,
    freeze_ruleset_version,
    supersede_ruleset_version,
    validate_binding,
)
from ruleset.templates import (
    golden_schidui,
    historical_xiaofeng_fallback_unresolved,
)
from ruleset.test_schema import (
    DEF,
    _def,
    _RulesetModelBase,
    partition_subtract_repechage_merge,
    weighted_composite_topn,
    weighted_previous_composite_topn,
    xiaofeng_chain,
)


def _ctx(**kw):
    return kw


class RulesetAdminAuthoritySurfaceTests(SimpleTestCase):
    def setUp(self):
        self.request = RequestFactory().get("/admin/ruleset/")
        self.request.user = User(username="ruleset-admin", is_active=True, is_superuser=True)

    def test_ruleset_versions_are_observation_only(self):
        model_admin = admin.site._registry[RulesetVersion]
        self.assertTrue(model_admin.has_view_permission(self.request))
        self.assertFalse(model_admin.has_add_permission(self.request))
        self.assertFalse(model_admin.has_change_permission(self.request))
        self.assertFalse(model_admin.has_delete_permission(self.request))

    def test_ruleset_containers_preserve_only_safe_maintenance_metadata(self):
        template_admin = admin.site._registry[RulesetTemplate]
        ruleset_admin = admin.site._registry[ContestRuleset]

        self.assertFalse(template_admin.has_add_permission(self.request))
        self.assertTrue(template_admin.has_change_permission(self.request))
        self.assertFalse(template_admin.has_delete_permission(self.request))
        self.assertEqual(
            set(template_admin.get_readonly_fields(self.request)),
            {
                "schema_version",
                "definition",
                "status",
                "builtin_key",
                "capability_status",
                "content_hash",
                "created_by",
                "frozen_by",
                "frozen_at",
                "created_at",
                "updated_at",
            },
        )
        self.assertFalse(ruleset_admin.has_add_permission(self.request))
        self.assertTrue(ruleset_admin.has_change_permission(self.request))
        self.assertFalse(ruleset_admin.has_delete_permission(self.request))
        self.assertEqual(
            set(ruleset_admin.get_readonly_fields(self.request)),
            {
                "activity",
                "source_template",
                "is_test_data",
                "stage_key",
                "round_keys",
                "announcement_blocks",
                "announcement_blocks_by_checkpoint",
                "vote_keys",
                "group_keys",
                "audience_keys",
                "created_by",
                "created_at",
                "updated_at",
            },
        )


class CompilerValidCorpusTests(SimpleTestCase):
    """§8.8 structures and a fully-annotated clean definition compile with no ERROR."""

    def _expect_green(self, definition, *_, **__):
        report, plan = compile_definition(definition)
        self.assertTrue(report.passes(), report.by_code("MISSING_SCORE_DEPENDENCY"))
        self.assertIsNotNone(plan)
        return report, plan

    def test_weighted_composite_topn_compiles(self):
        report, plan = self._expect_green(weighted_composite_topn())
        self.assertGreater(len(plan.nodes), 0)
        # The M1-C structures carry no semantic annotations, so scale is unresolved
        # and count checks are unverifiable — but never a hard ERROR.
        self.assertEqual(report.counts().get("error", 0), 0)

    def test_weighted_previous_composite_topn_compiles(self):
        self._expect_green(weighted_previous_composite_topn())

    def test_xiaofeng_chain_compiles(self):
        # The 校十佳屏峰 control flow (group-direct / remainder / repechage / merge /
        # manual group decision / conditional fill) is expressible with generic nodes.
        report, plan = self._expect_green(xiaofeng_chain())
        self.assertIsNotNone(plan)
        self.assertEqual(report.counts().get("error", 0), 0)
        codes = report.codes()
        self.assertNotIn("MISSING_SCORE_DEPENDENCY", codes)

    def test_partition_subtract_repechage_merge_compiles(self):
        self._expect_green(partition_subtract_repechage_merge())

    def test_golden_schidui_bound_compiles_with_audience_score(self):
        # §11.3 院十佳 must freezable as a SCORE_COMPONENT audience composite: the two
        # audience ASSESS nodes carry vote_purpose, and the bound context supplies a
        # hundred-scale audience over hundred-mark judge rounds. The compiler must not
        # report VOTE_PURPOSE_REQUIRED, SCALE_MIXED ("100" vs "hundred"), or any
        # ASSESS_SCALE_BINDING_MISMATCH. This is the regression that proves a worker can
        # actually freeze the 院十佳 ruleset (M1-INTEGRATION-CLOSE Item 1).
        ctx = {
            "entry_size": 15,
            "rounds": {
                "r1": {"judge_count": 5, "scope": "full", "scale": "100"},
                "r2": {"judge_count": 5, "scope": "full", "scale": "100"},
                "r3": {"judge_count": 5, "scope": "subset", "scale": "100"},
                "r4": {"judge_count": 5, "scope": "subset", "scale": "100"},
            },
            "votes": {
                "audience1": {"scale": "hundred"},
                "audience4": {"scale": "hundred"},
            },
            "groups": {},
        }
        report, plan = compile_definition(golden_schidui(), context=ctx, bound=True)
        self.assertTrue(report.passes(), report.codes())
        self.assertIsNotNone(plan)
        self.assertNotIn("VOTE_PURPOSE_REQUIRED", report.codes())
        self.assertNotIn("SCALE_MIXED", report.codes())
        self.assertNotIn("ASSESS_SCALE_BINDING_MISMATCH", report.codes())
        self.assertNotIn("VOTE_SCORE_COMPONENT_RAW", report.codes())

    def test_within_scoped_composite_compiles(self):
        # Mixing a full source (a1) with a subset source (a3) would normally be a
        # MISSING_SCORE_DEPENDENCY error; scoping the aggregate to the advance roster
        # (within=top10) declares that intent and must compile clean.
        definition = _def(
            [
                {"key": "a1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank1", "type": "RANK", "source": "a1", "descending": True},
                {"key": "top10", "type": "SELECT", "source": "rank1", "count": 10},
                {"key": "a3", "type": "ASSESS", "source": "top10", "round": "r3"},
                {
                    "key": "agg",
                    "type": "AGGREGATE",
                    "within": "top10",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "a1", "weight": 0.6},
                            {"source": "a3", "weight": 0.4},
                        ],
                    },
                },
            ]
        )
        report, plan = self._expect_green(definition)
        self.assertNotIn("MISSING_SCORE_DEPENDENCY", report.codes())
        self.assertIsNotNone(plan)

    def _annotated_clean(self):
        return _def(
            [
                {
                    "key": "a1",
                    "type": "ASSESS",
                    "source": ENTRY_KEY,
                    "round": "r1",
                    "scale": "hundred",
                    "mode": "mean",
                },
                {
                    "key": "a2",
                    "type": "ASSESS",
                    "source": ENTRY_KEY,
                    "round": "r2",
                    "scale": "hundred",
                    "mode": "mean",
                },
                {
                    "key": "comp",
                    "type": "AGGREGATE",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "a1", "weight": 0.4},
                            {"source": "a2", "weight": 0.6},
                        ],
                    },
                },
                {
                    "key": "ranked",
                    "type": "RANK",
                    "source": "comp",
                    "descending": True,
                    "tie_policy": "auto_break",
                    "tie_break_source": "a1",
                },
                {
                    "key": "winners",
                    "type": "SELECT",
                    "source": "ranked",
                    "count": 5,
                    "tie_policy": "auto_break",
                    "tie_break_source": "a1",
                },
            ],
            context={
                "entry_size": 20,
                "rounds": {
                    "r1": {"scale": "hundred", "judge_count": 7, "scope": "all"},
                    "r2": {"scale": "hundred", "judge_count": 7, "scope": "all"},
                },
            },
        )

    def test_fully_annotated_clean_has_zero_error(self):
        report, plan = self._expect_green(self._annotated_clean())
        self.assertEqual(report.counts().get("error", 0), 0)
        # The decisive cutoffs declare a tie policy, so no REVIEW either.
        self.assertEqual(report.counts().get("review", 0), 0)
        self.assertEqual(plan.summary["total_nodes"], 5)
        self.assertEqual(plan.policies["tie"]["winners"], "auto_break")

    def test_plan_summary_structures_populated(self):
        _, plan = compile_definition(self._annotated_clean())
        self.assertIn("final_outputs", plan.summary)  # type: ignore[union-attr]
        self.assertIn("candidate_pool_sizes", plan.summary)  # type: ignore[union-attr]
        self.assertIn("missing_score_paths", plan.summary)  # type: ignore[union-attr]
        self.assertEqual(plan.summary["missing_score_paths"], [])  # type: ignore[union-attr]


class CompilerDeterminismTests(SimpleTestCase):
    def test_round_trip_reproduces(self):
        _, plan = compile_definition(weighted_composite_topn())
        self.assertEqual(ExecutionPlan.from_dict(plan.to_dict()).to_dict(), plan.to_dict())  # type: ignore[union-attr]

    def test_to_dict_stable_across_calls(self):
        _, plan = compile_definition(weighted_composite_topn())
        self.assertEqual(plan.to_dict(), plan.to_dict())  # type: ignore[union-attr]
        self.assertEqual(plan.to_dict()["plan_version"], 1)  # type: ignore[union-attr]

    def test_plan_hash_matches_schema_content_hash(self):
        definition = weighted_composite_topn()
        _, plan = compile_definition(definition)
        self.assertEqual(plan.content_hash, content_hash(definition))  # type: ignore[union-attr]

    def test_report_round_trip(self):
        report, _ = compile_definition(weighted_composite_topn())
        self.assertIsNotNone(report)
        from ruleset.compiler import ValidationReport

        self.assertEqual(ValidationReport.from_dict(report.to_dict()).to_dict(), report.to_dict())


class CompilerInvalidCorpusTests(SimpleTestCase):
    """Each D1–D8 violation surfaces its canonical code and fails passes()."""

    def _assert_invalid(self, definition, expected_code, *, expect_plan=True):
        report, plan = compile_definition(definition)
        self.assertIn(expected_code, report.codes())
        self.assertFalse(report.passes())
        if expect_plan:
            self.assertIsNotNone(plan)
        return report, plan

    def test_wght_not_normalized(self):
        self._assert_invalid(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY},
                    {
                        "key": "agg",
                        "type": "AGGREGATE",
                        "aggregate": {
                            "type": "weighted_sum",
                            "components": [{"source": "a", "weight": 0.3}],
                        },
                    },
                ],
                context={"entry_size": 20},
            ),
            "WGHT_NOT_NORMALIZED",
        )

    def test_wght_duplicate_source(self):
        # Schema rejects at parse time; the compiler maps it to the WGHT code.
        self._assert_invalid(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY},
                    {
                        "key": "agg",
                        "type": "AGGREGATE",
                        "aggregate": {
                            "type": "weighted_sum",
                            "components": [
                                {"source": "a", "weight": 0.5},
                                {"source": "a", "weight": 0.5},
                            ],
                        },
                    },
                ]
            ),
            "WGHT_DUPLICATE_SOURCE",
            expect_plan=False,
        )

    def test_scale_mixed_without_conversion(self):
        self._assert_invalid(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "scale": "hundred"},
                    {"key": "b", "type": "ASSESS", "source": ENTRY_KEY, "scale": "ten"},
                    {
                        "key": "agg",
                        "type": "AGGREGATE",
                        "aggregate": {
                            "type": "weighted_sum",
                            "components": [
                                {"source": "a", "weight": 0.5},
                                {"source": "b", "weight": 0.5},
                            ],
                        },
                    },
                ]
            ),
            "SCALE_MIXED",
        )

    def test_conversion_declared_is_forbidden(self):
        # §29-30: conversion is schema-approved but unimplemented by the resolver
        # (which does w*v), so a declared conversion must be a hard ERROR, not silently
        # skipped as it was before.
        self._assert_invalid(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "scale": "hundred"},
                    {"key": "b", "type": "ASSESS", "source": ENTRY_KEY, "scale": "ten"},
                    {
                        "key": "agg",
                        "type": "AGGREGATE",
                        "aggregate": {
                            "type": "weighted_sum",
                            "components": [
                                {"source": "a", "weight": 0.5},
                                {"source": "b", "weight": 0.5},
                            ],
                        },
                        "conversion": {
                            "to": "hundred",
                            "conversions": [{"from": "ten", "method": "factor", "factor": 10}],
                        },
                    },
                ]
            ),
            "CONVERSION_UNSUPPORTED",
        )

    def test_scale_undeclared_is_warn_not_error(self):
        report, _ = compile_definition(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY},
                    {"key": "b", "type": "ASSESS", "source": ENTRY_KEY},
                    {
                        "key": "agg",
                        "type": "AGGREGATE",
                        "aggregate": {
                            "type": "weighted_sum",
                            "components": [
                                {"source": "a", "weight": 0.5},
                                {"source": "b", "weight": 0.5},
                            ],
                        },
                    },
                ]
            )
        )
        self.assertIn("SCALE_UNDECLARED", report.codes())
        self.assertTrue(report.passes())

    def test_judge_insufficient(self):
        self._assert_invalid(
            _def(
                [
                    {
                        "key": "a",
                        "type": "ASSESS",
                        "source": ENTRY_KEY,
                        "round": "r1",
                        "mode": "trimmed_mean",
                        "trim_high": 1,
                        "trim_low": 1,
                    }
                ],
                context={"entry_size": 20, "rounds": {"r1": {"judge_count": 2}}},
            ),
            "JUDGE_INSUFFICIENT",
        )

    def test_quota_exceeded(self):
        self._assert_invalid(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY},
                    {"key": "r", "type": "RANK", "source": "a"},
                    {"key": "s", "type": "SELECT", "source": "r", "count": 30},
                ],
                context={"entry_size": 20},
            ),
            "QUOTA_EXCEEDED",
        )

    def test_pool_insufficient(self):
        self._assert_invalid(
            _def(
                [
                    {"key": "p", "type": "PARTITION", "source": ENTRY_KEY, "by": "c"},
                    {
                        "key": "f",
                        "type": "FILL_TO_QUOTA",
                        "from": ENTRY_KEY,
                        "into": "p",
                        "quota": 25,
                    },
                ],
                context={"entry_size": 20},
            ),
            "POOL_INSUFFICIENT",
        )

    def test_group_quota_exceeded(self):
        self._assert_invalid(
            _def(
                [
                    {"key": "p", "type": "PARTITION", "source": ENTRY_KEY, "by": "c"},
                    {"key": "m", "type": "MANUAL_SELECT", "source": "p", "groups": 5, "quota": 2},
                ],
                context={"entry_size": 20, "groups": {"c": {"capacity": [7, 7, 6]}}},
            ),
            "GROUP_QUOTA_EXCEEDED",
        )

    def test_manual_limit_invalid(self):
        self._assert_invalid(
            _def(
                [
                    {"key": "p", "type": "PARTITION", "source": ENTRY_KEY, "by": "c"},
                    {"key": "m", "type": "MANUAL_SELECT", "source": "p", "groups": 0, "quota": 2},
                ]
            ),
            "MANUAL_LIMIT_INVALID",
        )

    def test_odd_no_policy(self):
        self._assert_invalid(
            _def(
                [
                    {
                        "key": "pair",
                        "type": "PAIR",
                        "source": ENTRY_KEY,
                        "pairing_policy": "ADJACENT",
                    }
                ],
                context={"entry_size": 21},
            ),
            "ODD_NO_POLICY",
        )

    def test_tie_policy_unsupported(self):
        self._assert_invalid(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY},
                    {"key": "r", "type": "RANK", "source": "a"},
                    {
                        "key": "s",
                        "type": "SELECT",
                        "source": "r",
                        "count": 5,
                        "tie_policy": "extra_round",
                    },
                ],
                context={"entry_size": 20},
            ),
            "TIE_POLICY_UNSUPPORTED",
        )

    def test_tie_auto_break_without_source_is_invalid(self):
        # §M1-R8: a generic auto_break silently falls back to roster order — an
        # implicit rule. It must be a compile error unless a real tie_break_source
        # (a prior ScoreMap node) is declared.
        self._assert_invalid(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY},
                    {"key": "r", "type": "RANK", "source": "a"},
                    {
                        "key": "s",
                        "type": "SELECT",
                        "source": "r",
                        "count": 5,
                        "tie_policy": "auto_break",
                    },
                ],
                context={"entry_size": 20},
            ),
            "TIE_AUTO_BREAK_NO_SOURCE",
        )

    def test_tie_auto_break_with_source_is_supported(self):
        # A declared tie_break_source makes auto_break deterministic and honest.
        report, plan = compile_definition(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY},
                    {"key": "tb", "type": "ASSESS", "source": ENTRY_KEY},
                    {"key": "r", "type": "RANK", "source": "a", "tie_break_source": "tb"},
                    {
                        "key": "s",
                        "type": "SELECT",
                        "source": "r",
                        "count": 5,
                        "tie_policy": "auto_break",
                        "tie_break_source": "tb",
                    },
                ],
                context={"entry_size": 20},
            )
        )
        self.assertTrue(report.passes())
        self.assertIn("auto_break", plan.policies["tie"].values())  # type: ignore[union-attr]

    def test_tie_select_source_mismatch_rejected(self):
        # M1-R9-Final: a SELECT auto_break's tie_break_source must equal its source RANK's.
        # A divergent source forms an independent tie-break that omits re-ordering, letting
        # A(100,5)/B(100,8) both advance if the SELECT breaks on a different field.
        self._assert_invalid(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY},
                    {"key": "tb", "type": "ASSESS", "source": ENTRY_KEY},
                    {"key": "r", "type": "RANK", "source": "a", "tie_break_source": "tb"},
                    {
                        "key": "s",
                        "type": "SELECT",
                        "source": "r",
                        "count": 5,
                        "tie_policy": "auto_break",
                        "tie_break_source": "a",
                    },
                ],
                context={"entry_size": 20},
            ),
            "TIE_SELECT_SOURCE_MISMATCH",
        )

    def test_branch_is_unsupported_runtime(self):
        # §27-28: BRANCH is not executable by the resolver, so the compiler must refuse
        # to validate/freeze it — otherwise a definition validates, freezes, then blows
        # up on-stage (Compiler says executable, Runtime says no).
        self._assert_invalid(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY},
                    {
                        "key": "b",
                        "type": "BRANCH",
                        "source": "a",
                        "branches": [{"when": {"gte": 60}, "into": "x"}],
                    },
                ],
                context={"entry_size": 20},
            ),
            "NODE_UNSUPPORTED_RUNTIME",
        )

    def test_independent_award_is_supported_runtime(self):
        report, plan = compile_definition(
            _def(
                [
                    {
                        "key": "a",
                        "type": "ASSESS",
                        "source": ENTRY_KEY,
                        "vote_source": "pop",
                        "vote_purpose": "POPULARITY",
                    },
                    {"key": "w", "type": "AWARD", "source": "a", "award": "best"},
                ],
                context={"entry_size": 20, "votes": {"pop": {"scale": "hundred"}}},
            )
        )
        self.assertTrue(report.passes(), report.codes())
        self.assertIsNotNone(plan)

    def test_tie_review_is_nonblocking(self):
        report, _ = compile_definition(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY},
                    {"key": "r", "type": "RANK", "source": "a"},
                    {"key": "s", "type": "SELECT", "source": "r", "count": 5},
                ],
                context={"entry_size": 20},
            )
        )
        self.assertIn("TIE_REVIEW", report.codes())
        self.assertTrue(report.passes(), "TIE_REVIEW must not block a freeze")

    def test_vote_unbound_blocks(self):
        self._assert_invalid(
            _def(
                [{"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "vote_source": "pop"}],
                context={"votes": {"other": {"scale": "hundred"}}},
            ),
            "VOTE_NOT_READY",
        )

    def test_vote_without_runtime_ready_does_not_block(self):
        # M1-R8 (P0-2): a bound freeze validates vote CONFIG, not runtime readiness.
        # A configured VoteSession that has not yet received a ballot must not raise
        # VOTE_NOT_READY — 0 ballots is a freeze-legal pre-contest state, and any
        # "no result yet" is a runtime resolver HOLD condition.
        report, _ = compile_definition(
            _def(
                [
                    {
                        "key": "a",
                        "type": "ASSESS",
                        "source": ENTRY_KEY,
                        "vote_source": "pop",
                        "vote_purpose": "SCORE_COMPONENT",
                    }
                ],
                context={"votes": {"pop": {"scale": "hundred", "normalization": True}}},
            )
        )
        self.assertTrue(report.passes(), [i.to_dict() for i in report.issues])

    def test_vote_purpose(self):
        self._assert_invalid(
            _def(
                [
                    {
                        "key": "a",
                        "type": "ASSESS",
                        "source": ENTRY_KEY,
                        "vote_source": "pop",
                        "vote_purpose": "POPULARITY",
                    }
                ],
                context={"votes": {"pop": {"scale": "hundred"}}},
            ),
            "VOTE_PURPOSE",
        )

    def test_bound_vote_session_purpose_must_match_award_purpose(self):
        self._assert_invalid(
            _def(
                [
                    {
                        "key": "a",
                        "type": "ASSESS",
                        "source": ENTRY_KEY,
                        "vote_source": "pop",
                        "vote_purpose": "POPULARITY",
                    },
                    {"key": "w", "type": "AWARD", "source": "a", "award": "best"},
                ],
                context={
                    "votes": {"pop": {"scale": "votes", "purpose": "selection"}},
                },
            ),
            "VOTE_PURPOSE_MISMATCH",
        )

    def test_vote_no_norm(self):
        self._assert_invalid(
            _def(
                [
                    {
                        "key": "a",
                        "type": "ASSESS",
                        "source": ENTRY_KEY,
                        "vote_source": "pop",
                        "vote_purpose": "SCORE_COMPONENT",
                    }
                ],
                context={"votes": {"pop": {"scale": "ten"}}},
            ),
            "VOTE_NO_NORM",
        )

    def test_vote_with_normalization_is_ok(self):
        report, _ = compile_definition(
            _def(
                [
                    {
                        "key": "a",
                        "type": "ASSESS",
                        "source": ENTRY_KEY,
                        "vote_source": "pop",
                        "vote_purpose": "SCORE_COMPONENT",
                    }
                ],
                context={
                    "votes": {
                        "pop": {
                            "scale": "ten",
                            "normalization": {"method": "minmax"},
                        }
                    }
                },
            )
        )
        self.assertTrue(report.passes())

    def test_vote_score_component_raw_is_rejected(self):
        # M1-R9 (§三): a SCORE_COMPONENT consumer on a raw ``votes`` unit must be a hard
        # error. With no VoteScoringRule to convert votes->points, mixing raw counts into a
        # weighted sum as if they were a pre-normalized score is the "looks legal but wrong"
        # bug this milestone closes.
        self._assert_invalid(
            _def(
                [
                    {
                        "key": "a",
                        "type": "ASSESS",
                        "source": ENTRY_KEY,
                        "vote_source": "pop",
                        "vote_purpose": "SCORE_COMPONENT",
                    }
                ],
                context={"votes": {"pop": {"scale": "votes"}}},
            ),
            "VOTE_SCORE_COMPONENT_RAW",
        )

    def test_vote_purpose_required(self):
        # M1-R9-Final (§8.1): a bound vote_source ASSESS must declare vote_purpose.
        # Omitting it used to dodge both VOTE_PURPOSE and the raw-vote SCORE_COMPONENT
        # rejection, letting a node-declared scale slip raw votes into a composite.
        self._assert_invalid(
            _def(
                [{"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "vote_source": "pop"}],
                context={"votes": {"pop": {"scale": "hundred", "normalization": True}}},
            ),
            "VOTE_PURPOSE_REQUIRED",
        )

    def test_assess_scale_binding_mismatch(self):
        # M1-R9-Final: the bound actual scale is authoritative over a node-declared
        # "expected" scale. A definition claiming ``hundred`` over a real 50-mark sheet
        # is a hard error rather than silently mis-reading the units.
        self._assert_invalid(
            _def(
                [
                    {
                        "key": "a",
                        "type": "ASSESS",
                        "source": ENTRY_KEY,
                        "round": "r1",
                        "scale": "hundred",
                    },
                ],
                context={"rounds": {"r1": {"scale": "50"}}},
            ),
            "ASSESS_SCALE_BINDING_MISMATCH",
        )

    def test_numeric_scale_mixed_rejected(self):
        # M1-R9 (§25): a 50-mark sheet and a 10-mark sheet are distinct units (score_max
        # 50 != 10), so a direct weighted sum must be a SCALE_MIXED error — the old
        # "non-100 is ten" bucket collapsed both to "ten" and let them be summed.
        self._assert_invalid(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                    {"key": "b", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
                    {
                        "key": "agg",
                        "type": "AGGREGATE",
                        "aggregate": {
                            "type": "weighted_sum",
                            "components": [
                                {"source": "a", "weight": 0.5},
                                {"source": "b", "weight": 0.5},
                            ],
                        },
                    },
                ],
                context={
                    "entry_size": 20,
                    "rounds": {"r1": {"scale": "50"}, "r2": {"scale": "10"}},
                },
            ),
            "SCALE_MIXED",
        )

    def test_xiaofeng_fallback_invalid_aggregate_rejected(self):
        """§12.4 — the historical 校十佳 fallback references R1+R2+R3, but the group
        top-1 direct winners never reach R2/R3. The aggregate mixes a full-roster R1
        (all 20) with subset R2/R3 (15 leftover), so the Validator must FAIL with
        MISSING_SCORE_DEPENDENCY instead of the resolver guessing a score."""
        report, plan = self._assert_invalid(
            _def(
                [
                    {"key": "groups", "type": "PARTITION", "source": ENTRY_KEY, "by": "initial"},
                    {"key": "r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                    {"key": "rank1", "type": "RANK", "source": "r1", "descending": True},
                    {
                        "key": "direct",
                        "type": "SELECT",
                        "source": "rank1",
                        "count": 1,
                        "by": "groups",
                    },
                    {
                        "key": "leftover",
                        "type": "SUBTRACT",
                        "minuend": ENTRY_KEY,
                        "subtrahend": "direct",
                    },
                    {"key": "r2", "type": "ASSESS", "source": "leftover", "round": "r2"},
                    {"key": "r3", "type": "ASSESS", "source": "leftover", "round": "r3"},
                    {
                        "key": "fallback",
                        "type": "AGGREGATE",
                        "aggregate": {
                            "type": "weighted_sum",
                            "components": [
                                {"source": "r1", "weight": 0.3},
                                {"source": "r2", "weight": 0.5},
                                {"source": "r3", "weight": 0.2},
                            ],
                        },
                    },
                ],
                context={
                    "entry_size": 20,
                    "rounds": {
                        "r1": {"scope": "all"},
                        "r2": {"scope": "subset"},
                        "r3": {"scope": "subset"},
                    },
                },
            ),
            "MISSING_SCORE_DEPENDENCY",
        )
        golden = report.by_code("MISSING_SCORE_DEPENDENCY")[0]
        # The guard fires on whichever subset round (R2 or R3) it reaches first; the
        # §12.4 requirement is that the mixed full/subset fallback is rejected at all.
        self.assertIn(golden.context["missing_round"], ("r2", "r3"))

    def test_historical_xiaofeng_fallback_unresolved_rejected(self):
        """§24.2 — the named historical 20/30/50 fallback template is NOT executable:
        its direct winners never reach R2/R3, so the validator must FAIL with
        MISSING_SCORE_DEPENDENCY rather than the resolver guessing a score."""
        report, plan = self._assert_invalid(
            historical_xiaofeng_fallback_unresolved(),
            "MISSING_SCORE_DEPENDENCY",
        )
        golden = report.by_code("MISSING_SCORE_DEPENDENCY")[0]
        self.assertEqual(golden.context["missing_round"], "r2")

    def test_missing_score_dependency_golden(self):
        report, plan = self._assert_invalid(
            _def(
                [
                    {"key": "a1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                    {"key": "a2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
                    {
                        "key": "agg",
                        "type": "AGGREGATE",
                        "aggregate": {
                            "type": "weighted_sum",
                            "components": [
                                {"source": "a1", "weight": 0.4},
                                {"source": "a2", "weight": 0.6},
                            ],
                        },
                    },
                ],
                context={
                    "entry_size": 20,
                    "rounds": {"r1": {"scope": "all"}, "r2": {"scope": "subset"}},
                },
            ),
            "MISSING_SCORE_DEPENDENCY",
        )
        golden = report.by_code("MISSING_SCORE_DEPENDENCY")[0]
        self.assertIn("r2", golden.message)
        self.assertEqual(golden.context["missing_round"], "r2")
        self.assertEqual(plan.summary["missing_score_paths"][0]["missing_round"], "r2")

    def test_graph_forward_ref(self):
        self._assert_invalid(
            _def(
                [
                    {
                        "key": "agg",
                        "type": "AGGREGATE",
                        "aggregate": {
                            "type": "weighted_sum",
                            "components": [{"source": "later", "weight": 1.0}],
                        },
                    }
                ]
            ),
            "GRAPH_FORWARD_REF",
            expect_plan=False,
        )

    def test_graph_parse_error(self):
        from ruleset.compiler import compile_definition as cd

        report, plan = cd("not json")
        self.assertIn("GRAPH_PARSE_ERROR", report.codes())
        self.assertIsNone(plan)

    def test_checkpoint_output_must_be_real_node(self):
        definition = weighted_composite_topn()
        definition["checkpoints"] = [{"key": "stage1", "output": "ghost"}]
        self._assert_invalid(definition, "GRAPH_CHECKPOINT", expect_plan=False)


class BoundCompileTests(SimpleTestCase):
    """§38-39: a bound activity freeze escalates "unverifiable until bound" to ERROR."""

    def test_bound_escalates_unverifiable_quota(self):
        # DEF (ASSESS/RANK/SELECT count=1) without an entry_size can only WARN the quota;
        # a bound freeze must escalate that to an ERROR and refuse to compile.
        report, plan = compile_definition(DEF, bound=True)
        self.assertFalse(report.passes())
        self.assertIn("QUOTA_UNVERIFIABLE", report.codes())
        self.assertEqual(report.by_code("QUOTA_UNVERIFIABLE")[0].severity.value, "error")

    def test_template_level_allows_warn(self):
        report, plan = compile_definition(DEF, bound=False)
        self.assertTrue(report.passes())
        self.assertIn("QUOTA_UNVERIFIABLE", report.codes())
        self.assertEqual(report.by_code("QUOTA_UNVERIFIABLE")[0].severity.value, "warn")

    def test_bound_passes_with_full_context(self):
        report, plan = compile_definition(
            DEF,
            context={
                "entry_size": 5,
                "rounds": {"r1": {"judge_count": 3, "scale": "hundred", "scope": "full"}},
            },
            bound=True,
        )
        self.assertTrue(report.passes(), [i.to_dict() for i in report.issues])
        self.assertIsNotNone(plan)


class RulesetFreezeServiceTests(_RulesetModelBase):
    def _admin(self):
        user = self.make_user("ruleset-admin")
        user.role = User.Role.ADMIN
        user.save()
        return user

    def _draft(
        self,
        ruleset=None,
        definition=DEF,
        version=1,
        *,
        is_current=False,
        status=RulesetVersion.Status.DRAFT,
    ):
        ruleset = ruleset or self.make_ruleset()
        with authority_write(RULESET_FREEZE):
            return RulesetVersion.objects.create(
                ruleset=ruleset,
                version=version,
                definition=definition,
                is_current=is_current,
                status=status,
            )

    def test_freeze_success(self):
        admin = self._admin()
        version = self._draft()
        frozen = freeze_ruleset_version(version, admin)
        frozen.refresh_from_db()
        self.assertEqual(frozen.status, RulesetVersion.Status.FROZEN)
        self.assertEqual(frozen.frozen_by, admin)
        self.assertIsNotNone(frozen.frozen_at)
        self.assertTrue(frozen.is_current)
        self.assertTrue(frozen.execution_plan)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.FINALIZE_RULESET,
                target=f"RulesetVersion:{frozen.pk}",
            ).exists()
        )

    def test_freeze_demotes_prior_current(self):
        admin = self._admin()
        ruleset = self.make_ruleset()
        prior = self._draft(
            ruleset=ruleset,
            version=1,
            status=RulesetVersion.Status.FROZEN,
            is_current=True,
        )
        new = self._draft(ruleset=ruleset, version=2, is_current=False)
        frozen = freeze_ruleset_version(new, admin)
        prior.refresh_from_db()
        # The prior current was FROZEN (immutable); demotion must have bypassed the
        # guarded manager, otherwise it would have raised. Regression for the trap.
        self.assertFalse(prior.is_current)
        self.assertTrue(frozen.is_current)
        self.assertEqual(
            RulesetVersion._base_manager.filter(ruleset=ruleset, is_current=True).count(),
            1,
        )

    def test_freeze_rejects_when_current_has_confirmed_result(self):
        """M1-R9 (§五): a normal successor Freeze demotes the running FROZEN authority. That
        is illegal once a result grounded in it is CONFIRMED — the confirmed handcard must
        stay attributable to the authority it was frozen under."""
        from django.utils import timezone
        from singer_contest.models import StageResult

        admin = self._admin()
        ruleset = self.make_ruleset(is_test_mode=True)
        prior = self._draft(
            ruleset=ruleset,
            version=1,
            status=RulesetVersion.Status.FROZEN,
            is_current=True,
        )
        with authority_write(STAGE_RESULT_CONFIRM):
            StageResult.objects.create(
                activity=ruleset.activity,
                ruleset_version=prior,
                created_by=admin,
                stage_key="选拔",
                status=StageResult.Status.CONFIRMED,
                reasons=[],
                is_test_data=True,
                confirmed_at=timezone.now(),
                confirmed_by=admin,
            )
        successor = self._draft(ruleset=ruleset, version=2, is_current=False)
        with self.assertRaises(ValidationError):
            freeze_ruleset_version(successor, admin)

    def test_freeze_rejects_already_frozen(self):
        admin = self._admin()
        version = self._draft()
        freeze_ruleset_version(version, admin)
        with self.assertRaises(ValidationError):
            freeze_ruleset_version(version, admin)

    def test_freeze_rejects_non_admin(self):
        user = self.make_user("ruleset-nonadmin")
        version = self._draft()
        with self.assertRaises(PermissionDenied):
            freeze_ruleset_version(version, user)

    def test_freeze_aborts_on_error(self):
        admin = self._admin()
        bad = json.dumps(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                    {
                        "key": "agg",
                        "type": "AGGREGATE",
                        "aggregate": {
                            "type": "weighted_sum",
                            "components": [{"source": "a", "weight": 0.5}],
                        },
                    },
                ]
            ),
            ensure_ascii=False,
        )
        version = self._draft(definition=bad)
        with self.assertRaises(RulesetInvalidError) as ctx:
            freeze_ruleset_version(version, admin)
        version.refresh_from_db()
        self.assertEqual(version.status, RulesetVersion.Status.DRAFT)
        # Bound freeze also escalates SCALE_UNDECLARED / SCORE_DEPENDENCY_UNVERIFIABLE
        # from WARN to ERROR, so the error count is >= the un-normalized weight error.
        self.assertGreaterEqual(ctx.exception.report.counts().get("error", 0), 1)
        self.assertFalse(
            AuditLog.objects.filter(action_type=AuditLog.ActionType.FINALIZE_RULESET).exists()
        )

    def test_bound_freeze_refuses_unverifiable_quota(self):
        # A rule needing 5 candidates cannot freeze while only 1 singer is approved:
        # the DB-derived entry_size turns QUOTA_EXCEEDED into a hard error.
        admin = self._admin()
        too_big = json.dumps(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                    {"key": "r", "type": "RANK", "source": "a"},
                    {"key": "s", "type": "SELECT", "source": "r", "count": 5},
                ]
            ),
            ensure_ascii=False,
        )
        version = self._draft(definition=too_big)
        with self.assertRaises(RulesetInvalidError):
            freeze_ruleset_version(version, admin)
        version.refresh_from_db()
        self.assertEqual(version.status, RulesetVersion.Status.DRAFT)

    def test_bound_freeze_passes_with_adequate_context(self):
        # A bound freeze of an adequate rule succeeds once the activity has an approved
        # entry so the compiler can verify the quota instead of escalating to ERROR.
        admin = self._admin()
        version = self._draft()
        frozen = freeze_ruleset_version(version, admin)
        frozen.refresh_from_db()
        self.assertEqual(frozen.status, RulesetVersion.Status.FROZEN)
        self.assertTrue(frozen.execution_plan)

    def _seed_2025_yuan_compe(self, *, consumer="SCORE_COMPONENT"):
        """Seed a 2025 院十佳-shaped activity: 12 approved singers, r1-r4 rubrics, and a
        bound 0-ballot audience VoteSession. Return (admin, ruleset, round_keys, definition)."""
        from django.utils import timezone
        from singer_contest.models import (
            ContestRound,
            RubricCriterion,
            ScoringRubric,
            SingerRegistration,
        )
        from voting.models import VoteSession

        admin = self._admin()
        activity = self.make_activity(is_test_mode=True)
        ruleset = ContestRuleset.objects.create(activity=activity, name="院十佳", is_test_data=True)
        for i in range(12):
            self.make_singer(
                activity,
                username=f"rj-entry-{i}",
                student_id=f"9{i:03d}",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            )
        round_keys = {}
        for key, crits in (
            ("r1", [30, 30, 20, 20]),
            ("r2", [60, 40]),
            ("r3", [100]),
            ("r4", [70, 30]),
        ):
            rubric = ScoringRubric.objects.create(
                activity=activity, name=f"{key}评分", is_test_data=True
            )
            for i, m in enumerate(crits):
                RubricCriterion.objects.create(
                    rubric=rubric, name=f"标准{i}", max_score=m, is_test_data=True
                )
            round_ = ContestRound.objects.create(
                activity=activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name=key,
            )
            round_.rubric = rubric
            round_.save(update_fields=["rubric"])
            round_keys[key] = round_.pk

        audience = VoteSession.objects.create(
            activity=activity,
            name="观众投票",
            passcode="0000",
            start_time=timezone.now(),
            end_time=timezone.now() + timezone.timedelta(hours=1),  # type: ignore[attr-defined]
            is_test_data=True,
        )
        ruleset.round_keys = round_keys
        ruleset.vote_keys = {"audience1": audience.pk}
        ruleset.save(update_fields=["round_keys", "vote_keys"])

        nodes = [
            {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            {"key": "assess_r2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
        ]
        aggregate_comps = [
            {"source": "assess_r1", "weight": 0.4},
            {"source": "assess_r2", "weight": 0.6},
        ]
        if consumer is not None:
            audience_node = {
                "key": "assess_a1",
                "type": "ASSESS",
                "source": ENTRY_KEY,
                "vote_source": "audience1",
                "vote_purpose": consumer,
            }
            nodes.insert(2, audience_node)
            aggregate_comps = [
                {"source": "assess_r1", "weight": 0.30},
                {"source": "assess_r2", "weight": 0.60},
                {"source": "assess_a1", "weight": 0.10},
            ]
        nodes.extend(
            [
                {
                    "key": "stage1",
                    "type": "AGGREGATE",
                    "within": ENTRY_KEY,
                    "aggregate": {"type": "weighted_sum", "components": aggregate_comps},  # type: ignore[dict-item]
                },
                {"key": "rank1", "type": "RANK", "source": "stage1", "descending": True},  # type: ignore[dict-item]
                {"key": "top10", "type": "SELECT", "source": "rank1", "count": 10},  # type: ignore[dict-item]
            ]
        )
        definition = json.dumps(_def(nodes), ensure_ascii=False)
        return admin, ruleset, round_keys, definition

    def test_bound_freeze_2025_yuan_compe_zero_ballots(self):
        """M1-R9: binding a 0-ballot audience VoteSession is freeze-legal — and a ruleset
        that never consumes the vote as a score freezes cleanly.

        0 ballots is a freeze-legal pre-contest state: whether a VoteSession has votes is a
        runtime resolver HOLD condition, never a Freeze gate. The bound session still yields
        a ``votes`` binding, so the composite (R1+R2, both a numeric 100-mark sheet from the
        30+30+20+20 / 60+40 rubrics) must freeze with a verifiable quota.
        """
        admin, ruleset, _, definition = self._seed_2025_yuan_compe(consumer=None)
        version = self._draft(ruleset=ruleset, definition=definition)
        frozen = freeze_ruleset_version(version, admin)
        frozen.refresh_from_db()
        self.assertEqual(frozen.status, RulesetVersion.Status.FROZEN)
        self.assertTrue(frozen.is_current)
        self.assertTrue(frozen.execution_plan)

    def test_bound_freeze_rejects_score_component_raw_vote(self):
        """M1-R9 (§三/验收 "raw vote 无换算规则进入综合分"): a SCORE_COMPONENT consumer on a
        bound raw ``votes`` source must refuse to freeze — there is no VoteScoringRule to
        convert votes -> points, so mixing raw counts into a weighted sum as if they were a
        0-100 score would produce a "looks legal but wrong" result.
        """
        admin, ruleset, _, definition = self._seed_2025_yuan_compe(consumer="SCORE_COMPONENT")
        version = self._draft(ruleset=ruleset, definition=definition)
        with self.assertRaises(RulesetInvalidError) as ctx:
            freeze_ruleset_version(version, admin)
        self.assertIn("VOTE_SCORE_COMPONENT_RAW", ctx.exception.report.codes())
        version.refresh_from_db()
        self.assertEqual(version.status, RulesetVersion.Status.DRAFT)


class RulesetFrozenAuthorityTests(_RulesetModelBase):
    """M1-R1: a frozen version is self-authoritative (definition + binding + hash).

    The binding snapshot (stage_key / round_keys / announcement_blocks) is captured at
    freeze, the runtime reads it from the version (never the still-mutable ContestRuleset
    fields), and superseding / cloning preserve the one-current invariant.
    """

    def _admin(self):
        user = self.make_user("r1-admin")
        user.role = User.Role.ADMIN
        user.save()
        return user

    def _ruleset_with_binding(self):
        ruleset = self.make_ruleset()
        from core.models import Activity
        from singer_contest.models import ContestRound

        assert ruleset.activity.activity_type == Activity.Type.SINGER_CONTEST
        round_ = ContestRound.objects.create(
            activity=ruleset.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            advance_count=10,
        )
        ruleset.stage_key = "院十佳"
        ruleset.round_keys = {"r1": round_.pk}
        ruleset.announcement_blocks = [{"label": "晋级", "outcome_codes": ["direct"]}]
        ruleset.save()
        return ruleset, round_

    def _draft_on(
        self, ruleset, *, version=1, is_current=False, status=RulesetVersion.Status.DRAFT
    ):
        return RulesetVersion.objects.create(
            ruleset=ruleset,
            version=version,
            definition=DEF,
            is_current=is_current,
            status=status,
        )

    def test_freeze_snapshots_binding_from_ruleset(self):
        ruleset, round_ = self._ruleset_with_binding()
        admin = self._admin()
        version = self._draft_on(ruleset)
        frozen = freeze_ruleset_version(version, admin)
        frozen.refresh_from_db()
        self.assertEqual(
            frozen.binding,
            {
                "stage_key": "院十佳",
                "round_keys": {"r1": round_.pk},
                "vote_keys": {},
                "group_keys": {},
                "audience_keys": {},
                "announcement_blocks": [{"label": "晋级", "outcome_codes": ["direct"]}],
                "announcement_blocks_by_checkpoint": {},
            },
        )

    def test_freeze_accepts_explicit_binding(self):
        from singer_contest.models import ContestRound

        ruleset = self.make_ruleset()
        round_ = ContestRound.objects.create(
            activity=ruleset.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            advance_count=10,
        )
        admin = self._admin()
        version = self._draft_on(ruleset)
        frozen = freeze_ruleset_version(
            version,
            admin,
            binding={
                "stage_key": "快速赛段",
                "round_keys": {"r1": round_.pk},
                "announcement_blocks": [],
            },
        )
        frozen.refresh_from_db()
        self.assertEqual(frozen.binding["stage_key"], "快速赛段")
        self.assertEqual(frozen.binding["round_keys"], {"r1": round_.pk})

    def test_freeze_rejects_binding_with_foreign_round(self):
        from singer_contest.models import ContestRound

        ruleset = self.make_ruleset()
        other_activity_ruleset = self.make_ruleset()
        foreign_round = ContestRound.objects.create(
            activity=other_activity_ruleset.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            advance_count=5,
        )
        admin = self._admin()
        version = self._draft_on(ruleset)
        with self.assertRaises(ValidationError):
            freeze_ruleset_version(
                version,
                admin,
                binding={"stage_key": "院十佳", "round_keys": {"r1": foreign_round.pk}},
            )

    def test_frozen_binding_is_immutable(self):
        ruleset, round_ = self._ruleset_with_binding()
        admin = self._admin()
        version = self._draft_on(ruleset)
        frozen = freeze_ruleset_version(version, admin)
        frozen.binding = {"stage_key": "改", "round_keys": {}, "announcement_blocks": []}
        with self.assertRaises(ValidationError):
            frozen.save()

    def test_supersede_creates_next_draft(self):
        ruleset, round_ = self._ruleset_with_binding()
        admin = self._admin()
        version = self._draft_on(ruleset)
        frozen = freeze_ruleset_version(version, admin)
        successor = supersede_ruleset_version(frozen, created_by=admin)
        frozen.refresh_from_db()
        self.assertEqual(successor.status, RulesetVersion.Status.DRAFT)
        self.assertEqual(successor.version, 2)
        self.assertEqual(successor.definition, frozen.definition)
        self.assertEqual(successor.binding, frozen.binding)
        # is_current = current official authority: issuing a Draft editor never demotes
        # the running FROZEN authority (M1-R8 gate #1).
        self.assertTrue(frozen.is_current)
        self.assertFalse(successor.is_current)
        self.assertEqual(
            RulesetVersion._base_manager.filter(ruleset=ruleset, is_current=True).count(), 1
        )

    def test_supersede_rejects_draft(self):
        admin = self._admin()
        ruleset = self.make_ruleset()
        version = self._draft_on(ruleset, version=1)
        with self.assertRaises(ValidationError):
            supersede_ruleset_version(version, created_by=admin)

    def test_create_ruleset_version_avoids_collision(self):
        ruleset = self.make_ruleset()
        admin = self._admin()
        first = create_ruleset_version(ruleset, definition=DEF, created_by=admin)
        second = create_ruleset_version(ruleset, definition=DEF, created_by=admin)
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual(first.version, 1)
        self.assertEqual(second.version, 2)
        # A DRAFT is never the official authority (M1-R8): two DRAFTs leave no current
        # version, and a running FROZEN authority would not be demoted by either.
        self.assertFalse(second.is_current)
        self.assertFalse(first.is_current)
        self.assertEqual(
            RulesetVersion._base_manager.filter(ruleset=ruleset, is_current=True).count(), 0
        )

    def test_supersede_keeps_frozen_authority_until_next_freeze(self):
        """M1-R8 gate #1: issuing a Draft editor never demotes the running FROZEN
        authority; authority flips atomically only when the successor is itself frozen."""
        ruleset, round_ = self._ruleset_with_binding()
        admin = self._admin()
        v1 = freeze_ruleset_version(self._draft_on(ruleset, version=1), admin)
        v1.refresh_from_db()
        self.assertTrue(v1.is_current)  # v1 is the official authority
        successor = supersede_ruleset_version(v1, created_by=admin)
        v1.refresh_from_db()
        self.assertTrue(v1.is_current)  # drafts never demote a running authority
        self.assertFalse(successor.is_current)
        v2 = freeze_ruleset_version(successor, admin)
        v1.refresh_from_db()
        v2.refresh_from_db()
        self.assertFalse(v1.is_current)  # authority flipped on freeze
        self.assertTrue(v2.is_current)
        self.assertEqual(
            RulesetVersion._base_manager.filter(ruleset=ruleset, is_current=True).count(), 1
        )

    def test_freeze_sets_authority_hash_bound_aware(self):
        # R5-3: the authority hash captures definition + frozen binding, so it differs
        # from the definition-only content_hash when a binding surface is present.
        ruleset, round_ = self._ruleset_with_binding()
        admin = self._admin()
        version = self._draft_on(ruleset)
        frozen = freeze_ruleset_version(version, admin)
        frozen.refresh_from_db()
        self.assertTrue(frozen.authority_hash)
        self.assertNotEqual(frozen.authority_hash, frozen.content_hash)

    def test_authority_hash_distinguishes_binding_change(self):
        # R5-3: two frozen versions with the identical definition but different binding
        # must hash differently (this is what formerly collided in the StageResult
        # identity before R5-4 moved it to the immutable RulesetVersion).
        admin = self._admin()
        ruleset = self.make_ruleset()
        from singer_contest.models import ContestRound

        round_ = ContestRound.objects.create(
            activity=ruleset.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            advance_count=10,
        )
        v1 = self._draft_on(ruleset, version=1)
        f1 = freeze_ruleset_version(
            v1,
            admin,
            binding={
                "stage_key": "院十佳",
                "round_keys": {"r1": round_.pk},
                "announcement_blocks": [],
            },
        )
        v2 = supersede_ruleset_version(f1, created_by=admin)
        f2 = freeze_ruleset_version(
            v2,
            admin,
            binding={
                "stage_key": "院十佳",
                "round_keys": {"r1": round_.pk},
                "announcement_blocks": [{"label": "晋级", "outcome_codes": ["direct"]}],
            },
        )
        self.assertNotEqual(f1.authority_hash, f2.authority_hash)

    def test_contestruleset_rejects_non_singer_activity(self):
        from core.models import Activity

        farewell = Activity.objects.create(
            title="毕晚",
            activity_type=Activity.Type.FAREWELL_SHOW,
            is_test_mode=True,
        )
        with self.assertRaises(ValidationError):
            ContestRuleset.objects.create(activity=farewell, name="规则", is_test_data=True)


class BindingValidationTests(_RulesetModelBase):
    """§32 binding normalization: round/vote/group key maps normalize and stay in-activity."""

    def _singer_round(self, ruleset):
        from singer_contest.models import ContestRound

        return ContestRound.objects.create(
            activity=ruleset.activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            advance_count=10,
        )

    def _vote_session(self, ruleset, *, is_test_data=False):
        from django.utils import timezone
        from voting.models import VoteSession

        return VoteSession.objects.create(
            activity=ruleset.activity,
            name="大众投票",
            passcode="0000",
            start_time=timezone.now(),
            end_time=timezone.now() + timezone.timedelta(hours=1),  # type: ignore[attr-defined]
            is_test_data=is_test_data,
        )

    def test_accepts_and_normalizes_pk_map(self):

        ruleset = self.make_ruleset()
        round_ = self._singer_round(ruleset)
        vote = self._vote_session(ruleset)
        normalized = validate_binding(
            ruleset,
            {
                "stage_key": "院十佳",
                "round_keys": {"r1": str(round_.pk), "r2": ""},
                "vote_keys": {"audience1": str(vote.pk)},
                "group_keys": {"by1": str(round_.pk)},
                "announcement_blocks": [],
                "announcement_blocks_by_checkpoint": {
                    "stage2": [{"label": "直接晋级", "outcome_codes": ["advanced"]}]
                },
            },
        )
        self.assertEqual(normalized["round_keys"], {"r1": round_.pk})
        self.assertEqual(normalized["vote_keys"], {"audience1": vote.pk})
        self.assertEqual(normalized["group_keys"], {"by1": round_.pk})
        self.assertEqual(
            normalized["announcement_blocks_by_checkpoint"]["stage2"],
            [{"label": "直接晋级", "outcome_codes": ["advanced"]}],
        )
        self.assertIsInstance(normalized["round_keys"]["r1"], int)
        self.assertIsInstance(normalized["vote_keys"]["audience1"], int)

    def test_rejects_bad_checkpoint_blocks(self):
        ruleset = self.make_ruleset()
        with self.assertRaises(ValidationError):
            validate_binding(ruleset, {"announcement_blocks_by_checkpoint": "not-a-map"})
        with self.assertRaises(ValidationError):
            validate_binding(
                ruleset, {"announcement_blocks_by_checkpoint": {"stage2": "not-a-list"}}
            )

    def test_rejects_foreign_round(self):
        ruleset = self.make_ruleset()
        foreign = self.make_ruleset()
        foreign_round = self._singer_round(foreign)
        with self.assertRaises(ValidationError):
            validate_binding(ruleset, {"round_keys": {"r1": foreign_round.pk}})

    def test_rejects_foreign_vote_session(self):
        ruleset = self.make_ruleset()
        foreign = self.make_ruleset()
        foreign_vote = self._vote_session(foreign)
        with self.assertRaises(ValidationError):
            validate_binding(ruleset, {"vote_keys": {"audience1": foreign_vote.pk}})

    def test_rejects_foreign_group_round(self):
        ruleset = self.make_ruleset()
        foreign = self.make_ruleset()
        foreign_round = self._singer_round(foreign)
        with self.assertRaises(ValidationError):
            validate_binding(ruleset, {"group_keys": {"by1": foreign_round.pk}})

    def test_rejects_non_dict_key_map(self):
        ruleset = self.make_ruleset()
        with self.assertRaises(ValidationError):
            validate_binding(ruleset, {"round_keys": ["not-a-map"]})

    def test_rejects_vote_and_audience_key_overlap(self):
        # A source_key bound as both a raw-count vote and a staff audience score would be
        # silently overwritten in the vote channel, so the binding must reject it.
        ruleset = self.make_ruleset()
        vote = self._vote_session(ruleset)
        with self.assertRaises(ValidationError):
            validate_binding(
                ruleset,
                {
                    "vote_keys": {"shared": str(vote.pk)},
                    "audience_keys": {"shared": "stage1"},
                },
            )
