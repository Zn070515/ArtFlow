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
from common.models import AuditLog
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import SimpleTestCase

from ruleset.compiler import (
    ExecutionPlan,
    compile_definition,
)
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.schema import ENTRY_KEY, content_hash
from ruleset.services import (
    RulesetInvalidError,
    create_ruleset_version,
    freeze_ruleset_version,
    supersede_ruleset_version,
)
from ruleset.templates import (
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
                },
                {
                    "key": "winners",
                    "type": "SELECT",
                    "source": "ranked",
                    "count": 5,
                    "tie_policy": "auto_break",
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
        self.assertIn("final_outputs", plan.summary)
        self.assertIn("candidate_pool_sizes", plan.summary)
        self.assertIn("missing_score_paths", plan.summary)
        self.assertEqual(plan.summary["missing_score_paths"], [])


class CompilerDeterminismTests(SimpleTestCase):
    def test_round_trip_reproduces(self):
        _, plan = compile_definition(weighted_composite_topn())
        self.assertEqual(ExecutionPlan.from_dict(plan.to_dict()).to_dict(), plan.to_dict())

    def test_to_dict_stable_across_calls(self):
        _, plan = compile_definition(weighted_composite_topn())
        self.assertEqual(plan.to_dict(), plan.to_dict())
        self.assertEqual(plan.to_dict()["plan_version"], 1)

    def test_plan_hash_matches_schema_content_hash(self):
        definition = weighted_composite_topn()
        _, plan = compile_definition(definition)
        self.assertEqual(plan.content_hash, content_hash(definition))

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
                [{"key": "pair", "type": "PAIR", "source": ENTRY_KEY}], context={"entry_size": 21}
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

    def test_tie_auto_break_is_supported(self):
        report, plan = compile_definition(
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
            )
        )
        self.assertTrue(report.passes())
        self.assertIn("auto_break", plan.policies["tie"].values())

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

    def test_award_is_unsupported_runtime(self):
        self._assert_invalid(
            _def(
                [
                    {"key": "a", "type": "ASSESS", "source": ENTRY_KEY},
                    {"key": "w", "type": "AWARD", "source": "a", "award": "best"},
                ],
                context={"entry_size": 20},
            ),
            "NODE_UNSUPPORTED_RUNTIME",
        )

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

    def test_vote_not_ready(self):
        self._assert_invalid(
            _def(
                [{"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "vote_source": "pop"}],
                context={"votes": {"pop": {"result_ready": False}}},
            ),
            "VOTE_NOT_READY",
        )

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
                context={"votes": {"pop": {"result_ready": True, "scale": "hundred"}}},
            ),
            "VOTE_PURPOSE",
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
                context={"votes": {"pop": {"result_ready": True, "scale": "ten"}}},
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
                            "result_ready": True,
                            "scale": "ten",
                            "normalization": {"method": "minmax"},
                        }
                    }
                },
            )
        )
        self.assertTrue(report.passes())

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
        """§24.2 — the named historical 30/50/20 fallback template is NOT executable:
        its direct winners never reach R2/R3, so the validator must FAIL with
        MISSING_SCORE_DEPENDENCY rather than the resolver guessing a score."""
        report, plan = self._assert_invalid(
            historical_xiaofeng_fallback_unresolved(),
            "MISSING_SCORE_DEPENDENCY",
        )
        golden = report.by_code("MISSING_SCORE_DEPENDENCY")[0]
        self.assertIn(golden.context["missing_round"], ("r2", "r3"))

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
        is_current=True,
        status=RulesetVersion.Status.DRAFT,
    ):
        ruleset = ruleset or self.make_ruleset()
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
        self.assertEqual(ctx.exception.report.counts().get("error", 0), 1)
        self.assertFalse(
            AuditLog.objects.filter(action_type=AuditLog.ActionType.FINALIZE_RULESET).exists()
        )


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

    def _draft_on(self, ruleset, *, version=1, is_current=True, status=RulesetVersion.Status.DRAFT):
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
                "announcement_blocks": [{"label": "晋级", "outcome_codes": ["direct"]}],
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
        self.assertFalse(frozen.is_current)
        self.assertTrue(successor.is_current)
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
        self.assertTrue(second.is_current)
        self.assertFalse(first.is_current)
        self.assertEqual(
            RulesetVersion._base_manager.filter(ruleset=ruleset, is_current=True).count(), 1
        )

    def test_contestruleset_rejects_non_singer_activity(self):
        from core.models import Activity

        farewell = Activity.objects.create(
            title="毕晚",
            activity_type=Activity.Type.FAREWELL_SHOW,
            is_test_mode=True,
        )
        with self.assertRaises(ValidationError):
            ContestRuleset.objects.create(activity=farewell, name="规则", is_test_data=True)
