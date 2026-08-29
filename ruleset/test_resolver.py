"""M1-E deterministic StageResolver tests (DB-free, SimpleTestCase).

The resolver must replay a frozen ruleset over raw facts and publish deterministic
per-contestant StageDecisions with a HOLD/REVIEW/READY state. Everything here is a
pure function of ``(definition, inputs)``: no DB, no clock, no unordered queryset.
"""

import time
from decimal import Decimal
from types import SimpleNamespace

from django.test import SimpleTestCase

from ruleset.resolver import (
    OutcomeCode,
    ResolveInput,
    ResolveResult,
    ResolverState,
    UnsupportedNodeError,
    resolve,
)
from ruleset.schema import ENTRY_KEY
from ruleset.test_schema import (
    _def,
    partition_subtract_repechage_merge,
    weighted_composite_topn,
)


def _rs(table):
    """round -> {contestant: [judge scores]} -> canonical round_scores field."""
    return {
        round_key: {
            contestant: tuple(Decimal(str(v)) for v in scores)
            for contestant, scores in per_round.items()
        }
        for round_key, per_round in table.items()
    }


def _full_flow_def():
    """One path per outcome code: DIRECT, REPECHAGE, WILDCARD, FINALIST, ELIMINATED."""
    return _def(
        [
            {"key": "scored", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            {"key": "ranked", "type": "RANK", "source": "scored", "descending": True},
            {"key": "advanced", "type": "SELECT", "source": "ranked", "count": 1},
            {"key": "leftover", "type": "SUBTRACT", "minuend": ENTRY_KEY, "subtrahend": "advanced"},
            {"key": "repech", "type": "ASSESS", "source": "leftover", "round": "r1"},
            {"key": "rrank", "type": "RANK", "source": "repech", "descending": True},
            {"key": "rewinners", "type": "SELECT", "source": "rrank", "count": 1},
            {
                "key": "manual",
                "type": "MANUAL_SELECT",
                "source": "leftover",
                "groups": 1,
                "quota": 1,
            },
            {
                "key": "filled",
                "type": "FILL_TO_QUOTA",
                "from": "leftover",
                "into": "manual",
                "quota": 3,
            },
        ]
    )


class ResolverReadyTests(SimpleTestCase):
    def test_weighted_composite_topn_ready(self):
        roster = tuple(f"c{i}" for i in range(1, 13))
        round_scores = _rs(
            {
                "r1": {c: [11 - i] for i, c in enumerate(roster, 1)},
                "r2": {c: [9 - i] for i, c in enumerate(roster, 1)},
            }
        )
        result = resolve(
            weighted_composite_topn(), ResolveInput(roster=roster, round_scores=round_scores)
        )
        self.assertEqual(result.status, ResolverState.READY)
        by = {d.contestant: d for d in result.decisions}
        for i, c in enumerate(roster, 1):
            self.assertEqual(by[c].rank, i)
            if i <= 10:
                self.assertEqual(by[c].outcome_code, OutcomeCode.DIRECT)
            else:
                self.assertEqual(by[c].outcome_code, OutcomeCode.ELIMINATED)

    def test_acceptance_partition_flow_resolves_readily(self):
        roster = ("c1", "c2", "c3", "c4", "c5", "c6")
        inputs = ResolveInput(
            roster=roster,
            round_scores=_rs({"r1": {c: [100 - idx] for idx, c in enumerate(roster)}}),
            group_of={"class": {"c1": "A", "c2": "A", "c3": "A", "c4": "B", "c5": "B", "c6": "B"}},
            manual={"manual": {"": ("c5", "c6")}},
        )
        result = resolve(partition_subtract_repechage_merge(), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        by = {d.contestant: d for d in result.decisions}
        self.assertTrue(all(c in by for c in roster))
        self.assertTrue(all(d.outcome_code != OutcomeCode.PENDING for d in result.decisions))

    def test_full_flow_all_outcome_codes(self):
        roster = ("c1", "c2", "c3", "c4", "c5")
        inputs = ResolveInput(
            roster=roster,
            round_scores=_rs({"r1": {c: [10 - i] for i, c in enumerate(roster)}}),
            manual={"manual": {"": ("c4",)}},
        )
        result = resolve(_full_flow_def(), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        by = {d.contestant: d for d in result.decisions}
        self.assertEqual(by["c1"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.REPECHAGE)
        self.assertEqual(by["c3"].outcome_code, OutcomeCode.FINALIST)
        self.assertEqual(by["c4"].outcome_code, OutcomeCode.WILDCARD)
        self.assertEqual(by["c5"].outcome_code, OutcomeCode.ELIMINATED)

    def test_trimmed_mean_scoring(self):
        definition = _def(
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
            ]
        )
        inputs = ResolveInput(roster=("c1",), round_scores=_rs({"r1": {"c1": [10, 8, 9, 7]}}))
        result = resolve(definition, inputs)
        self.assertEqual(result.status, ResolverState.READY)
        self.assertEqual(result.decisions[0].score, Decimal("8.5"))

    def test_pair_even_ok(self):
        definition = _def([{"key": "p", "type": "PAIR", "source": ENTRY_KEY}])
        result = resolve(definition, ResolveInput(roster=("a", "b", "c", "d")))
        self.assertEqual(result.status, ResolverState.READY)
        self.assertEqual(len(result.node_values["p"]), 2)


class ResolverHoldTests(SimpleTestCase):
    def test_missing_round_score_hold(self):
        definition = _def([{"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"}])
        inputs = ResolveInput(
            roster=("c1", "c2", "c3"), round_scores=_rs({"r1": {"c1": [10], "c2": [9]}})
        )
        result = resolve(definition, inputs)
        self.assertEqual(result.status, ResolverState.HOLD)
        self.assertIn("c3", " ".join(result.reasons))

    def test_aggregate_missing_component_hold(self):
        definition = _def(
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
            ]
        )
        inputs = ResolveInput(
            roster=("c1", "c2"),
            round_scores=_rs({"r1": {"c1": [10], "c2": [9]}, "r2": {"c1": [8]}}),
        )
        result = resolve(definition, inputs)
        self.assertEqual(result.status, ResolverState.HOLD)
        self.assertIn("c2", " ".join(result.reasons))

    def test_partition_missing_group_hold(self):
        definition = _def([{"key": "g", "type": "PARTITION", "source": ENTRY_KEY, "by": "class"}])
        inputs = ResolveInput(roster=("c1", "c2"), group_of={"class": {"c1": "A"}})
        result = resolve(definition, inputs)
        self.assertEqual(result.status, ResolverState.HOLD)
        self.assertIn("c2", " ".join(result.reasons))

    def test_pair_odd_no_policy_hold(self):
        definition = _def([{"key": "p", "type": "PAIR", "source": ENTRY_KEY}])
        result = resolve(definition, ResolveInput(roster=("a", "b", "c")))
        self.assertEqual(result.status, ResolverState.HOLD)


class ResolverReviewTests(SimpleTestCase):
    def _tie_def(self, tie_policy=None):
        node = {"key": "s", "type": "SELECT", "source": "r", "count": 1}
        if tie_policy is not None:
            node["tie_policy"] = tie_policy
        return _def(
            [
                {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "r", "type": "RANK", "source": "a", "descending": True},
                node,
            ]
        )

    def test_boundary_tie_no_policy_review(self):
        inputs = ResolveInput(
            roster=("c1", "c2"), round_scores=_rs({"r1": {"c1": [10], "c2": [10]}})
        )
        result = resolve(self._tie_def(), inputs)
        self.assertEqual(result.status, ResolverState.REVIEW)
        by = {d.contestant: d for d in result.decisions}
        self.assertEqual(by["c1"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.PENDING)

    def test_boundary_tie_auto_break_ready(self):
        inputs = ResolveInput(
            roster=("c1", "c2"), round_scores=_rs({"r1": {"c1": [10], "c2": [10]}})
        )
        result = resolve(self._tie_def("auto_break"), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        by = {d.contestant: d for d in result.decisions}
        self.assertEqual(by["c1"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.ELIMINATED)


class ResolverManualSelectTests(SimpleTestCase):
    def _def(self):
        return _def(
            [{"key": "m", "type": "MANUAL_SELECT", "source": ENTRY_KEY, "groups": 1, "quota": 2}]
        )

    def test_no_submission_hold_with_human_message(self):
        result = resolve(self._def(), ResolveInput(roster=("c1", "c2", "c3")))
        self.assertEqual(result.status, ResolverState.HOLD)
        message = " ".join(result.reasons)
        self.assertIn("来源", message)
        self.assertIn("0~2", message)
        self.assertIn("当前已选 0", message)

    def test_submission_ready_wildcard(self):
        inputs = ResolveInput(roster=("c1", "c2", "c3"), manual={"m": {"": ("c1", "c3")}})
        result = resolve(self._def(), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        by = {d.contestant: d for d in result.decisions}
        self.assertEqual(by["c1"].outcome_code, OutcomeCode.WILDCARD)
        self.assertEqual(by["c3"].outcome_code, OutcomeCode.WILDCARD)
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.ELIMINATED)


class ResolverFillToQuotaTests(SimpleTestCase):
    def _def(self, quota):
        return _def(
            [
                {"key": "m", "type": "MANUAL_SELECT", "source": ENTRY_KEY, "groups": 1, "quota": 1},
                {
                    "key": "f",
                    "type": "FILL_TO_QUOTA",
                    "from": ENTRY_KEY,
                    "into": "m",
                    "quota": quota,
                },
            ]
        )

    def test_pool_too_small_hold(self):
        inputs = ResolveInput(roster=("c1", "c2"), manual={"m": {"": ()}})
        result = resolve(self._def(3), inputs)
        self.assertEqual(result.status, ResolverState.HOLD)
        self.assertIn("不足", " ".join(result.reasons))

    def test_completes_ready_finalist(self):
        inputs = ResolveInput(roster=("c1", "c2", "c3"), manual={"m": {"": ("c1",)}})
        result = resolve(self._def(2), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        by = {d.contestant: d for d in result.decisions}
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.FINALIST)


class ResolverDeterminismTests(SimpleTestCase):
    def test_idempotent_to_dict(self):
        roster = tuple(f"c{i}" for i in range(1, 13))
        round_scores = _rs(
            {
                "r1": {c: [11 - i] for i, c in enumerate(roster, 1)},
                "r2": {c: [9 - i] for i, c in enumerate(roster, 1)},
            }
        )
        inputs = ResolveInput(roster=roster, round_scores=round_scores)
        first = resolve(weighted_composite_topn(), inputs).to_dict()
        second = resolve(weighted_composite_topn(), inputs).to_dict()
        self.assertEqual(first, second)

    def test_to_dict_from_dict_round_trip(self):
        roster = tuple(f"c{i}" for i in range(1, 13))
        round_scores = _rs(
            {
                "r1": {c: [11 - i] for i, c in enumerate(roster, 1)},
                "r2": {c: [9 - i] for i, c in enumerate(roster, 1)},
            }
        )
        data = resolve(
            weighted_composite_topn(), ResolveInput(roster=roster, round_scores=round_scores)
        ).to_dict()
        self.assertEqual(ResolveResult.from_dict(data).to_dict(), data)

    def test_no_raw_input_mutation(self):
        roster = ("c1", "c2", "c3")
        round_scores = _rs({"r1": {"c1": [10], "c2": [9], "c3": [8]}})
        inputs = ResolveInput(roster=roster, round_scores=round_scores)
        roster_before = dict(roster=roster)
        round_before = {r: dict(t) for r, t in round_scores.items()}
        resolve(weighted_composite_topn(), inputs)
        self.assertEqual(inputs.roster, roster_before["roster"])
        self.assertEqual({r: dict(t) for r, t in inputs.round_scores.items()}, round_before)

    def test_plan_stamps_binding_metadata(self):
        roster = ("c1", "c2")
        inputs = ResolveInput(roster=roster, round_scores=_rs({"r1": {"c1": [10], "c2": [9]}}))
        plan = SimpleNamespace(content_hash="plan-hash", schema_version=1, plan_version=1)
        result = resolve(
            _def([{"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"}]),
            inputs,
            plan=plan,
        )
        self.assertEqual(result.content_hash, "plan-hash")
        self.assertEqual(result.schema_version, 1)
        self.assertEqual(result.plan_version, 1)
        self.assertEqual(result.decisions[0].content_hash, "plan-hash")
        self.assertEqual(result.decisions[0].plan_version, 1)


class ResolverUnsupportedTests(SimpleTestCase):
    def test_branch_raises(self):
        definition = _def(
            [
                {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {
                    "key": "b",
                    "type": "BRANCH",
                    "source": "a",
                    "branches": [{"when": {"gte": 60}, "into": "x"}],
                },
            ]
        )
        with self.assertRaises(UnsupportedNodeError):
            resolve(
                definition, ResolveInput(roster=("c1",), round_scores=_rs({"r1": {"c1": [10]}}))
            )

    def test_award_raises(self):
        definition = _def(
            [
                {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "w", "type": "AWARD", "source": "a", "award": "best"},
            ]
        )
        with self.assertRaises(UnsupportedNodeError):
            resolve(
                definition, ResolveInput(roster=("c1",), round_scores=_rs({"r1": {"c1": [10]}}))
            )


class ResolverPerfTests(SimpleTestCase):
    def test_perf_soft_three_stage_composite(self):
        roster = tuple(f"c{i}" for i in range(1, 101))
        round_scores = _rs(
            {
                "r1": {c: [(i + j) % 100 + 1 for j in range(10)] for i, c in enumerate(roster)},
                "r2": {c: [(i + j) % 100 + 1 for j in range(10)] for i, c in enumerate(roster)},
                "r3": {c: [(i + j) % 100 + 1 for j in range(10)] for i, c in enumerate(roster)},
            }
        )
        definition = _def(
            [
                {"key": "a1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "a2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
                {"key": "a3", "type": "ASSESS", "source": ENTRY_KEY, "round": "r3"},
                {
                    "key": "agg",
                    "type": "AGGREGATE",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "a1", "weight": 0.3},
                            {"source": "a2", "weight": 0.3},
                            {"source": "a3", "weight": 0.4},
                        ],
                    },
                },
                {"key": "r", "type": "RANK", "source": "agg", "descending": True},
                {
                    "key": "s",
                    "type": "SELECT",
                    "source": "r",
                    "count": 10,
                    "tie_policy": "auto_break",
                },
            ]
        )
        inputs = ResolveInput(roster=roster, round_scores=round_scores)
        start = time.perf_counter()
        result = resolve(definition, inputs)
        elapsed = time.perf_counter() - start
        self.assertEqual(result.status, ResolverState.READY)
        self.assertLess(elapsed, 2.0)
