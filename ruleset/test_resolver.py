"""M1-E deterministic StageResolver tests (DB-free, SimpleTestCase).

The resolver must replay a frozen ruleset over raw facts and publish deterministic
per-contestant StageDecisions with a HOLD/REVIEW/READY state. Everything here is a
pure function of ``(definition, inputs)``: no DB, no clock, no unordered queryset.
"""

import time
from decimal import Decimal
from types import SimpleNamespace
from typing import cast

from django.test import SimpleTestCase

from ruleset.resolver import (
    OutcomeCode,
    ResolveInput,
    ResolveResult,
    ResolverState,
    UnsupportedNodeError,
    resolve,
    resolve_to_checkpoint,
)
from ruleset.schema import ENTRY_KEY
from ruleset.templates import synthetic_fill_to_quota_demo
from ruleset.test_schema import (
    _def,
    partition_subtract_repechage_merge,
    weighted_composite_topn,
    xiaofeng_chain,
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


class ResolverWithinScopeTests(SimpleTestCase):
    """AGGREGATE may scope its computed pool to a roster via 'within'."""

    def _def(self):
        return _def(
            [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
                {"key": "top1", "type": "SELECT", "source": "rank1", "count": 2},
                {"key": "assess_r2", "type": "ASSESS", "source": "top1", "round": "r2"},
                {
                    "key": "agg2",
                    "type": "AGGREGATE",
                    "within": "top1",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "assess_r1", "weight": 0.5},
                            {"source": "assess_r2", "weight": 0.5},
                        ],
                    },
                },
                {"key": "rank2", "type": "RANK", "source": "agg2"},
            ]
        )

    def test_within_scopes_pool_to_advanced_roster(self):
        # Only the 2 advancees (c1, c2) have r2 scores; without 'within' the union pool
        # would include c3/c4 and hold on the missing r2 component.
        inputs = ResolveInput(
            roster=("c1", "c2", "c3", "c4"),
            round_scores=_rs(
                {
                    "r1": {"c1": [10], "c2": [9], "c3": [8], "c4": [7]},
                    "r2": {"c1": [80], "c2": [70]},
                }
            ),
        )
        result = resolve(self._def(), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        # agg2 computes .5*mean(r1) + .5*mean(r2): c1=45, c2=39.5
        agg2 = {d.contestant: d.score for d in result.decisions}
        self.assertEqual(agg2["c1"], Decimal("45.0"))
        self.assertEqual(agg2["c2"], Decimal("39.5"))


class ResolverGroupScopedSelectTests(SimpleTestCase):
    """SELECT with a `by` PARTITION picks top-count within each group, not globally."""

    def _def(self):
        return _def(
            [
                {"key": "scored", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "grouped", "type": "PARTITION", "source": ENTRY_KEY, "by": "class"},
                {"key": "ranked", "type": "RANK", "source": "scored", "descending": True},
                {"key": "top1", "type": "SELECT", "source": "ranked", "count": 1, "by": "grouped"},
            ]
        )

    def test_top1_per_group_is_direct_only_for_group_leaders(self):
        inputs = ResolveInput(
            roster=("c1", "c2", "c3", "c4", "c5", "c6"),
            round_scores=_rs(
                {
                    "r1": {
                        "c1": [100],
                        "c2": [99],
                        "c3": [98],
                        "c4": [97],
                        "c5": [96],
                        "c6": [95],
                    }
                }
            ),
            group_of={"class": {"c1": "A", "c2": "B", "c3": "A", "c4": "B", "c5": "A", "c6": "B"}},
        )
        result = resolve(self._def(), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        by = {d.contestant: d for d in result.decisions}
        self.assertEqual(by["c1"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.DIRECT)
        for c in ("c3", "c4", "c5", "c6"):
            self.assertEqual(by[c].outcome_code, OutcomeCode.ELIMINATED)

    def test_over_global_top1_under_scoped_select(self):
        """Group leaders (c1, c2) are not the global top-N once N exceeds group size."""
        inputs = ResolveInput(
            roster=("c1", "c2", "c3", "c4"),
            round_scores=_rs({"r1": {"c1": [100], "c2": [99], "c3": [98], "c4": [97]}}),
            group_of={"class": {"c1": "A", "c3": "A", "c2": "B", "c4": "B"}},
        )
        result = resolve(self._def(), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        by = {d.contestant: d for d in result.decisions}
        # Per-group top1 (count=1): A->c1, B->c2. Both are the global top-2 here, so the
        # distinction only bites when count is per-group and groups are uneven.
        self.assertEqual(by["c1"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.DIRECT)


def _xiaofeng_inputs(manual: dict | None) -> ResolveInput:
    roster = tuple(f"c{i}" for i in range(1, 21))
    initial = {}
    for group, start in zip(("G1", "G2", "G3", "G4", "G5"), (1, 5, 9, 13, 17)):
        for i in range(start, start + 4):
            initial[f"c{i}"] = group
    final = {
        "c1": "F1",
        "c2": "F1",
        "c3": "F1",
        "c4": "F1",
        "c5": "F2",
        "c6": "F2",
        "c7": "F2",
        "c8": "F2",
        "c9": "F3",
        "c10": "F3",
        "c13": "F3",
        "c17": "F3",
    }
    return ResolveInput(
        roster=roster,
        round_scores=_rs(
            {
                "r1": {f"c{i}": (100 - i,) for i in range(1, 21)},
                "r2": {f"c{i}": (200 - i,) for i in range(1, 21)},
            }
        ),
        group_of={"initial_group": initial, "final_group": final},
        manual={"manual": manual or {}},
    )


class GoldenSchiduiXiaofengTests(SimpleTestCase):
    """2025 校十佳屏峰 golden control flow (Cases G1-G4), no 2025 special-casing.

    The finalists are the union of the per-group manual picks (WILDCARD) and the
    FillToQuota fill-ins; read from the `filled` GroupMap. Because every member of the
    merged pool already carries DIRECT/REPECHAGE (first-writer-wins), the finalist code
    is not a reliable axis — the `filled` node_value is.
    """

    def _resolve(self, manual):
        return resolve(xiaofeng_chain(), _xiaofeng_inputs(manual))

    def test_g1_manual_6_no_fill_quota(self):
        result = self._resolve({"F1": ("c1", "c2"), "F2": ("c5", "c6"), "F3": ("c9", "c10")})
        self.assertEqual(result.status, ResolverState.READY)
        filled = result.node_values["filled"]
        self.assertEqual(filled, {"F1": ["c1", "c2"], "F2": ["c5", "c6"], "F3": ["c9", "c10"]})
        finalists = {c for g in filled.values() for c in g}
        self.assertEqual(len(finalists), 6)

    def test_g2_manual_5_auto_fill_1(self):
        result = self._resolve({"F1": ("c1", "c2"), "F2": ("c5", "c6"), "F3": ("c9",)})
        self.assertEqual(result.status, ResolverState.READY)
        filled = result.node_values["filled"]
        # F3 had 1 manual pick; FillToQuota fills it to 2 with the first unselected
        # merged contestant in roster order (c13).
        self.assertEqual(filled, {"F1": ["c1", "c2"], "F2": ["c5", "c6"], "F3": ["c9", "c13"]})
        self.assertEqual(len({c for g in filled.values() for c in g}), 6)

    def test_g3_manual_4_auto_fill_2(self):
        result = self._resolve({"F1": ("c1", "c2"), "F2": ("c5",), "F3": ("c9",)})
        self.assertEqual(result.status, ResolverState.READY)
        filled = result.node_values["filled"]
        # F2 and F3 each need 1; F2 is filled first (c13), then F3 (c17).
        self.assertEqual(filled, {"F1": ["c1", "c2"], "F2": ["c5", "c13"], "F3": ["c9", "c17"]})
        self.assertEqual(len({c for g in filled.values() for c in g}), 6)

    def test_g4_manual_0_full_auto_fill_6(self):
        result = self._resolve({"F1": (), "F2": (), "F3": ()})
        self.assertEqual(result.status, ResolverState.READY)
        filled = result.node_values["filled"]
        self.assertEqual(len({c for g in filled.values() for c in g}), 6)
        # Every group is filled to its quota of 2 from the merged pool (roster order).
        self.assertTrue(all(len(gs) == 2 for gs in filled.values()))

    def test_group_top1_5_direct_and_topn_layers(self):
        result = self._resolve({"F1": (), "F2": (), "F3": ()})
        # Top1 per group -> 5 direct winners, distinct groups.
        self.assertEqual(len(result.node_values["direct"]), 5)
        self.assertEqual(result.node_values["direct"], ["c1", "c5", "c9", "c13", "c17"])
        # R1 top12 of the 15 leftover; R2 top7 of those 12; merged exactly 12.
        self.assertEqual(len(result.node_values["top12"]), 12)
        self.assertEqual(len(result.node_values["top7"]), 7)
        self.assertEqual(len(result.node_values["merged"]), 12)
        by = {d.contestant: d for d in result.decisions}
        for c in ("c1", "c5", "c9", "c13", "c17"):
            self.assertEqual(by[c].outcome_code, OutcomeCode.DIRECT)


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
        definition = _def(
            [{"key": "p", "type": "PAIR", "source": ENTRY_KEY, "pairing_policy": "ADJACENT"}]
        )
        result = resolve(definition, ResolveInput(roster=("a", "b", "c", "d")))
        self.assertEqual(result.status, ResolverState.READY)
        self.assertEqual(len(result.node_values["p"]), 2)  # type: ignore[arg-type]


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
        definition = _def(
            [{"key": "p", "type": "PAIR", "source": ENTRY_KEY, "pairing_policy": "ADJACENT"}]
        )
        result = resolve(definition, ResolveInput(roster=("a", "b", "c")))
        self.assertEqual(result.status, ResolverState.HOLD)

    def test_duel_consumes_pair_decisions_and_exposes_winners_and_losers(self):
        definition = _def(
            [
                {
                    "key": "pairs",
                    "type": "PAIR",
                    "source": ENTRY_KEY,
                    "pairing_policy": "ADJACENT",
                },
                {
                    "key": "duel",
                    "type": "DUEL",
                    "source": "pairs",
                    "decision_source": "manual_recorded_result",
                },
                {"key": "winners", "type": "SELECT", "source": "duel", "count": 2},
            ]
        )
        result = resolve(
            definition,
            ResolveInput(
                roster=("a", "b", "c", "d"),
                duel_decisions={"duel": {"a|b": "a", "c|d": "d"}},
            ),
        )
        self.assertEqual(result.status, ResolverState.READY)
        duel = cast(dict, result.node_values["duel"])
        self.assertEqual(duel["winners"], ["a", "d"])
        self.assertEqual(duel["losers"], ["b", "c"])
        self.assertEqual(result.node_values["winners"], ["a", "d"])

    def test_duel_missing_or_invalid_decision_holds(self):
        definition = _def(
            [
                {
                    "key": "pairs",
                    "type": "PAIR",
                    "source": ENTRY_KEY,
                    "pairing_policy": "ADJACENT",
                },
                {
                    "key": "duel",
                    "type": "DUEL",
                    "source": "pairs",
                    "decision_source": "manual_recorded_result",
                },
            ]
        )
        missing = resolve(
            definition,
            ResolveInput(roster=("a", "b", "c", "d"), duel_decisions={"duel": {"a|b": "a"}}),
        )
        self.assertEqual(missing.status, ResolverState.HOLD)
        invalid = resolve(
            definition,
            ResolveInput(
                roster=("a", "b", "c", "d"),
                duel_decisions={"duel": {"a|b": "x", "c|d": "c"}},
            ),
        )
        self.assertEqual(invalid.status, ResolverState.HOLD)

    def test_duel_wildcard_is_a_winner_without_a_hidden_opponent(self):
        definition = _def(
            [
                {
                    "key": "pairs",
                    "type": "PAIR",
                    "source": ENTRY_KEY,
                    "pairing_policy": "ADJACENT",
                    "odd_policy": "wildcard",
                },
                {
                    "key": "duel",
                    "type": "DUEL",
                    "source": "pairs",
                    "decision_source": "manual_recorded_result",
                },
            ]
        )
        result = resolve(
            definition,
            ResolveInput(
                roster=("a", "b", "c"),
                duel_decisions={"duel": {"a|b": "b"}},
            ),
        )
        self.assertEqual(result.status, ResolverState.READY)
        duel = cast(dict, result.node_values["duel"])
        self.assertEqual(duel["winners"], ["b", "c"])
        self.assertEqual(duel["losers"], ["a"])

    def test_award_is_independent_from_advancement_decisions(self):
        definition = _def(
            [
                {
                    "key": "popularity",
                    "type": "ASSESS",
                    "source": ENTRY_KEY,
                    "vote_source": "audience",
                    "vote_purpose": "POPULARITY",
                },
                {"key": "award", "type": "AWARD", "source": "popularity", "award": "人气奖"},
            ]
        )
        result = resolve(
            definition,
            ResolveInput(
                roster=("a", "b"),
                vote_scores={"audience": {"a": Decimal("9"), "b": Decimal("10")}},
            ),
        )
        self.assertEqual(result.status, ResolverState.READY)
        award = cast(dict, result.node_values["award"])
        self.assertEqual(award["winner"], "b")
        self.assertEqual(result.awards[0].contestant, "b")
        self.assertTrue(all(d.outcome_code == OutcomeCode.ELIMINATED for d in result.decisions))


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

    def test_boundary_tie_no_policy_holds_all_pending(self):
        inputs = ResolveInput(
            roster=("c1", "c2"), round_scores=_rs({"r1": {"c1": [10], "c2": [10]}})
        )
        result = resolve(self._tie_def(), inputs)
        self.assertEqual(result.status, ResolverState.REVIEW)
        by = {d.contestant: d for d in result.decisions}
        # Roster order must never pick a winner on a true cutoff tie; BOTH tied
        # boundary contestants are held as PENDING for human confirmation (§M1-R8).
        self.assertEqual(by["c1"].outcome_code, OutcomeCode.PENDING)
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.PENDING)

    def test_boundary_tie_auto_break_without_source_holds(self):
        inputs = ResolveInput(
            roster=("c1", "c2"), round_scores=_rs({"r1": {"c1": [10], "c2": [10]}})
        )
        # A generic auto_break (no declared tie_break_source) must NOT silently
        # fall back to roster order; it surfaces the tie for confirmation.
        result = resolve(self._tie_def("auto_break"), inputs)
        self.assertEqual(result.status, ResolverState.REVIEW)
        by = {d.contestant: d for d in result.decisions}
        self.assertEqual(by["c1"].outcome_code, OutcomeCode.PENDING)
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.PENDING)

    def _tie_def_count(self, tie_policy, count):
        node = {"key": "s", "type": "SELECT", "source": "r", "count": count}
        if tie_policy is not None:
            node["tie_policy"] = tie_policy
        return _def(
            [
                {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "r", "type": "RANK", "source": "a", "descending": True},
                node,
            ]
        )

    def test_tie_extending_above_cutoff_holds_all(self):
        # Three contestants share a score but only two advance; the tie extends
        # ABOVE the cutoff line, so roster order must not hand the top two a win.
        inputs = ResolveInput(
            roster=("c1", "c2", "c3"),
            round_scores=_rs({"r1": {"c1": [10], "c2": [10], "c3": [10]}}),
        )
        result = resolve(self._tie_def_count(None, 2), inputs)
        self.assertEqual(result.status, ResolverState.REVIEW)
        by = {d.contestant: d for d in result.decisions}
        self.assertEqual(by["c1"].outcome_code, OutcomeCode.PENDING)
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.PENDING)
        self.assertEqual(by["c3"].outcome_code, OutcomeCode.PENDING)

    def test_boundary_tie_auto_break_with_source_resolves(self):
        # A declared tie_break_source (a prior ScoreMap) deterministically breaks
        # a primary tie WITHOUT any roster-order rule.
        definition = _def(
            [
                {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "tb", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
                {
                    "key": "r",
                    "type": "RANK",
                    "source": "a",
                    "descending": True,
                    "tie_break_source": "tb",
                },
                {
                    "key": "s",
                    "type": "SELECT",
                    "source": "r",
                    "count": 1,
                    "tie_policy": "auto_break",
                    "tie_break_source": "tb",
                },
            ]
        )
        inputs = ResolveInput(
            roster=("c1", "c2"),
            round_scores=_rs({"r1": {"c1": [10], "c2": [10]}, "r2": {"c1": [5], "c2": [8]}}),
        )
        result = resolve(definition, inputs)
        self.assertEqual(result.status, ResolverState.READY)
        by = {d.contestant: d for d in result.decisions}
        # c2 (secondary 8) outranks c1 (secondary 5) on the primary tie → c2 advances.
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by["c1"].outcome_code, OutcomeCode.ELIMINATED)

    def test_boundary_tie_partial_secondary_still_holds_pair(self):
        # c1 (secondary 8) is clearly above, but c2/c3 are score-tied on BOTH primary
        # and secondary, exactly at the cutoff. A tie_break that separates OTHER tied
        # contestants but leaves the boundary pair equal must NOT resolve the cutoff —
        # roster order would otherwise hand c2 the slot over c3 (§M1-R8 both sides).
        definition = _def(
            [
                {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "tb", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
                {
                    "key": "r",
                    "type": "RANK",
                    "source": "a",
                    "descending": True,
                    "tie_break_source": "tb",
                },
                {
                    "key": "s",
                    "type": "SELECT",
                    "source": "r",
                    "count": 2,
                    "tie_policy": "auto_break",
                    "tie_break_source": "tb",
                },
            ]
        )
        inputs = ResolveInput(
            roster=("c1", "c2", "c3"),
            round_scores=_rs(
                {
                    "r1": {"c1": [10], "c2": [10], "c3": [10]},
                    "r2": {"c1": [8], "c2": [5], "c3": [5]},
                }
            ),
        )
        result = resolve(definition, inputs)
        self.assertEqual(result.status, ResolverState.REVIEW)
        by = {d.contestant: d for d in result.decisions}
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.PENDING)
        self.assertEqual(by["c3"].outcome_code, OutcomeCode.PENDING)


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


class ResolverFillGlobalSemanticsTests(SimpleTestCase):
    """§19-§22: FILL_TO_QUOTA 'global' fills until the TOTAL reaches `quota`,
    ordered by a ranking_source (not per-group / not roster order)."""

    def _def(self):
        return _def(
            [
                {"key": "assess", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank", "type": "RANK", "source": "assess", "descending": True},
                {"key": "groups", "type": "PARTITION", "source": ENTRY_KEY, "by": "class"},
                {
                    "key": "manual",
                    "type": "MANUAL_SELECT",
                    "source": "groups",
                    "groups": 2,
                    "quota": 2,
                },
                {
                    "key": "filled",
                    "type": "FILL_TO_QUOTA",
                    "from": ENTRY_KEY,
                    "into": "manual",
                    "quota": 5,
                    "ranking_source": "rank",
                },
            ]
        )

    @staticmethod
    def _group_of():
        return {
            "class": {
                **{f"c{i}": "G1" for i in range(1, 5)},
                **{f"c{i}": "G2" for i in range(5, 9)},
            }
        }

    def test_global_fill_reaches_total_across_groups_by_score(self):
        inputs = ResolveInput(
            roster=tuple(f"c{i}" for i in range(1, 9)),
            round_scores=_rs({"r1": {f"c{i}": (100 - i,) for i in range(1, 9)}}),
            group_of=self._group_of(),
            manual={"manual": {"G1": ("c1",), "G2": ("c5",)}},
        )
        result = resolve(self._def(), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        filled = result.node_values["filled"]
        total = {c for g in filled.values() for c in g}  # type: ignore[attr-defined]
        # Top-5 globally by score: c1..c5 (c1,c5 manual; c2,c3,c4 filled). Not per-group.
        self.assertEqual(len(total), 5)
        self.assertEqual(total, {"c1", "c2", "c3", "c4", "c5"})

    def test_global_fill_orders_by_ranking_source_not_roster(self):
        # Scores reverse roster order: c8 is best, c1 worst. Ranking must pick c8/c7/c6.
        inputs = ResolveInput(
            roster=tuple(f"c{i}" for i in range(1, 9)),
            round_scores=_rs({"r1": {f"c{i}": (i,) for i in range(1, 9)}}),
            group_of=self._group_of(),
            manual={"manual": {"G1": ("c1",), "G2": ("c5",)}},
        )
        result = resolve(self._def(), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        filled = result.node_values["filled"]
        total = {c for g in filled.values() for c in g}  # type: ignore[attr-defined]
        # RANK desc -> c8,c7,c6,c5,c4,c3,c2,c1; minus manual {c1,c5} -> fills c8,c7,c6.
        self.assertEqual(total, {"c1", "c5", "c8", "c7", "c6"})

    def test_global_fill_cutoff_tie_holds_not_roster_order(self):
        # A genuine score tie exactly at the fill cutoff must NOT let roster order
        # silently decide who fills the last slot; the tied pair is held for review
        # (§M1-R9). Deterministic fills c2/c3 still advance.
        inputs = ResolveInput(
            roster=tuple(f"c{i}" for i in range(1, 9)),
            round_scores=_rs(
                {
                    "r1": {
                        "c1": [110],
                        "c2": [100],
                        "c3": [90],
                        "c4": [80],
                        "c5": [120],
                        "c6": [80],
                        "c7": [70],
                        "c8": [60],
                    }
                }
            ),
            group_of=self._group_of(),
            manual={"manual": {"G1": ("c1",), "G2": ("c5",)}},
        )
        result = resolve(self._def(), inputs)
        self.assertEqual(result.status, ResolverState.REVIEW)
        by = {d.contestant: d for d in result.decisions}
        # c4/c6 are score-tied at the fill boundary (need 3); both are PENDING rather
        # than roster-ordered. Deterministic fills c2/c3 become FINALIST.
        self.assertEqual(by["c4"].outcome_code, OutcomeCode.PENDING)
        self.assertEqual(by["c6"].outcome_code, OutcomeCode.PENDING)
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.FINALIST)
        self.assertEqual(by["c3"].outcome_code, OutcomeCode.FINALIST)

    def test_each_group_mode_fills_every_group_independently(self):
        definition = _def(
            [
                {"key": "groups", "type": "PARTITION", "source": ENTRY_KEY, "by": "class"},
                {
                    "key": "manual",
                    "type": "MANUAL_SELECT",
                    "source": "groups",
                    "groups": 2,
                    "quota": 2,
                },
                {
                    "key": "filled",
                    "type": "FILL_TO_QUOTA",
                    "from": ENTRY_KEY,
                    "into": "manual",
                    "quota": 2,
                    "mode": "each_group",
                },
            ]
        )
        inputs = ResolveInput(
            roster=tuple(f"c{i}" for i in range(1, 7)),
            group_of={
                "class": {
                    **{f"c{i}": "A" for i in range(1, 4)},
                    **{f"c{i}": "B" for i in range(4, 7)},
                }
            },
            manual={"manual": {"A": ("c1",), "B": ("c4",)}},
        )
        result = resolve(definition, inputs)
        self.assertEqual(result.status, ResolverState.READY)
        filled = result.node_values["filled"]
        # each_group tops each group to its own quota (2 each => 4 total), not global 2.
        self.assertEqual(filled, {"A": ["c1", "c2"], "B": ["c4", "c3"]})

    def test_synthetic_fill_to_quota_demo_global_by_ranking(self):
        """§24.3 — the named synthetic demo fills to a hard GLOBAL total, ordered by
        the r1 ranking rather than roster order."""
        inputs = ResolveInput(
            roster=tuple(f"c{i}" for i in range(1, 7)),
            # ascending scores: c6 is best, so RANK desc -> c6,c5,c4,c3,c2,c1
            round_scores=_rs({"r1": {f"c{i}": (i,) for i in range(1, 7)}}),
            group_of={
                "final_group": {
                    "c1": "F1",
                    "c2": "F1",
                    "c3": "F1",
                    "c4": "F2",
                    "c5": "F2",
                    "c6": "F2",
                }
            },
            manual={"manual": {"F1": ("c1",), "F2": ("c4",)}},
        )
        result = resolve(synthetic_fill_to_quota_demo(), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        filled = result.node_values["filled"]
        total = {c for g in filled.values() for c in g}  # type: ignore[attr-defined]
        # global total 4: {c1,c4} manual + {c6,c5} as the top two remaining by score.
        self.assertEqual(len(total), 4)
        self.assertEqual(total, {"c1", "c4", "c6", "c5"})


class ResolverManualSelectValidationTests(SimpleTestCase):
    """§25-§26: MANUAL_SELECT must reject over-quota, cross-group, unknown-key,
    and duplicated contestants rather than silently accepting them."""

    def _def(self, quota=2, groups=2):
        return _def(
            [
                {"key": "groups", "type": "PARTITION", "source": ENTRY_KEY, "by": "class"},
                {
                    "key": "m",
                    "type": "MANUAL_SELECT",
                    "source": "groups",
                    "groups": groups,
                    "quota": quota,
                },
            ]
        )

    @staticmethod
    def _group_of():
        return {"class": {"c1": "A", "c2": "A", "c3": "B", "c4": "B"}}

    def test_not_supplied_hold(self):
        inputs = ResolveInput(
            roster=("c1", "c2", "c3", "c4"),
            group_of=self._group_of(),
        )
        result = resolve(self._def(), inputs)
        self.assertEqual(result.status, ResolverState.HOLD)
        self.assertIn("当前已选 0", " ".join(result.reasons))

    def test_over_quota_hold(self):
        inputs = ResolveInput(
            roster=("c1", "c2", "c3", "c4"),
            group_of=self._group_of(),
            manual={"m": {"A": ("c1", "c2")}},
        )
        result = resolve(self._def(quota=1), inputs)
        self.assertEqual(result.status, ResolverState.HOLD)
        self.assertIn("超过上限", " ".join(result.reasons))

    def test_cross_group_selection_hold(self):
        inputs = ResolveInput(
            roster=("c1", "c2", "c3", "c4"),
            group_of=self._group_of(),
            manual={"m": {"A": ("c3",)}},
        )
        result = resolve(self._def(), inputs)
        self.assertEqual(result.status, ResolverState.HOLD)
        self.assertIn("不属于该组", " ".join(result.reasons))

    def test_unknown_group_key_hold(self):
        inputs = ResolveInput(
            roster=("c1", "c2", "c3", "c4"),
            group_of=self._group_of(),
            manual={"m": {"A": ("c1",), "C": ("c2",)}},
        )
        result = resolve(self._def(), inputs)
        self.assertEqual(result.status, ResolverState.HOLD)
        self.assertIn("不存在的组", " ".join(result.reasons))

    def test_duplicate_across_groups_hold(self):
        inputs = ResolveInput(
            roster=("c1", "c2", "c3", "c4"),
            group_of=self._group_of(),
            manual={"m": {"A": ("c1",), "B": ("c1",)}},
        )
        result = resolve(self._def(), inputs)
        self.assertEqual(result.status, ResolverState.HOLD)
        self.assertIn("同时选入", " ".join(result.reasons))

    def test_valid_grouped_selection_ready(self):
        inputs = ResolveInput(
            roster=("c1", "c2", "c3", "c4"),
            group_of=self._group_of(),
            manual={"m": {"A": ("c1",), "B": ("c3",)}},
        )
        result = resolve(self._def(), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        by = {d.contestant: d for d in result.decisions}
        self.assertEqual(by["c1"].outcome_code, OutcomeCode.WILDCARD)
        self.assertEqual(by["c3"].outcome_code, OutcomeCode.WILDCARD)
        self.assertEqual(by["c2"].outcome_code, OutcomeCode.ELIMINATED)


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

    def test_resolve_sets_input_fingerprint(self):
        """§18: the raw-facts snapshot the resolver consumed is fingerprinted on the result."""
        inputs = ResolveInput(
            roster=("c1", "c2"),
            round_scores=_rs({"r1": {"c1": [10], "c2": [9]}}),
        )
        definition = _def([{"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"}])
        plain = resolve(definition, inputs)
        self.assertTrue(plain.input_fingerprint)
        # Deterministic: unchanged facts → the same fingerprint (idempotency key).
        again = resolve(definition, inputs)
        self.assertEqual(plain.input_fingerprint, again.input_fingerprint)
        # Facts changed → a different fingerprint and therefore a new result identity.
        changed = resolve(
            definition,
            ResolveInput(roster=("c1", "c2"), round_scores=_rs({"r1": {"c1": [10], "c2": [8]}})),
        )
        self.assertNotEqual(plain.input_fingerprint, changed.input_fingerprint)


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
        # This fixture genuinely produces a boundary tie (c82/c92 score the same on
        # both primary and secondary); the honest resolver surfaces it as REVIEW
        # rather than silently breaking it by roster order (§M1-R8). The perf gates
        # are the real concern: resolve to a terminal state (READY/REVIEW, never
        # HOLD or an exception) in under 2s.
        self.assertIn(result.status, (ResolverState.READY, ResolverState.REVIEW))
        self.assertLess(elapsed, 2.0)


class GoldenSchiduiTopTenTests(SimpleTestCase):
    """M1-F golden 院十佳 full-graph resolve (pure, DB-free, no 2025 in Python).

    One frozen definition resolves the whole 15->10->5->3 chain via
    composite-of-composite within a single graph. AGGREGATE ``within`` scopes
    each stage's pool to the current advance roster so the eliminated
    contestants (lacking R3/R4 scores) never cause a spurious HOLD. Weights are
    exactly the §11.3 values (30/60/10, 60/40, 30/50/20) — but they live in the
    definition, not in this module.
    """

    def _def(self):
        definition = _def(
            [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "assess_r2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
                {
                    "key": "assess_a1",
                    "type": "ASSESS",
                    "source": ENTRY_KEY,
                    "vote_source": "audience1",
                },
                {
                    "key": "stage1",
                    "type": "AGGREGATE",
                    "within": ENTRY_KEY,
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "assess_r1", "weight": 0.30},
                            {"source": "assess_r2", "weight": 0.60},
                            {"source": "assess_a1", "weight": 0.10},
                        ],
                    },
                },
                {"key": "rank1", "type": "RANK", "source": "stage1", "descending": True},
                {"key": "top10", "type": "SELECT", "source": "rank1", "count": 10},
                {"key": "assess_r3", "type": "ASSESS", "source": "top10", "round": "r3"},
                {
                    "key": "stage2",
                    "type": "AGGREGATE",
                    "within": "top10",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "stage1", "weight": 0.60},
                            {"source": "assess_r3", "weight": 0.40},
                        ],
                    },
                },
                {"key": "rank2", "type": "RANK", "source": "stage2", "descending": True},
                {"key": "top5", "type": "SELECT", "source": "rank2", "count": 5},
                {"key": "assess_r4", "type": "ASSESS", "source": "top5", "round": "r4"},
                {
                    "key": "assess_a4",
                    "type": "ASSESS",
                    "source": "top5",
                    "vote_source": "audience4",
                },
                {
                    "key": "final",
                    "type": "AGGREGATE",
                    "within": "top5",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "assess_r3", "weight": 0.30},
                            {"source": "assess_r4", "weight": 0.50},
                            {"source": "assess_a4", "weight": 0.20},
                        ],
                    },
                },
                {"key": "rank3", "type": "RANK", "source": "final", "descending": True},
                {"key": "top3", "type": "SELECT", "source": "rank3", "count": 3},
            ]
        )
        definition["checkpoints"] = [
            {"key": "stage1", "output": "top10"},
            {"key": "stage2", "output": "top5"},
            {"key": "stage3", "output": "top3"},
        ]
        return definition

    def _inputs(self):
        roster = tuple(f"c{i}" for i in range(1, 16))
        r1 = {f"c{i}": (Decimal(100 - i),) for i in range(1, 16)}
        r2 = {f"c{i}": (Decimal(90 - i),) for i in range(1, 16)}
        r3 = {f"c{i}": (Decimal(100 - i),) for i in range(1, 11)}
        r4 = {f"c{i}": (Decimal(100 - i),) for i in range(1, 6)}
        a1 = {f"c{i}": Decimal("50") for i in range(1, 16)}
        a4 = {f"c{i}": Decimal(90 - i) for i in range(1, 6)}
        return ResolveInput(
            roster=roster,
            round_scores={"r1": r1, "r2": r2, "r3": r3, "r4": r4},
            vote_scores={"audience1": a1, "audience4": a4},
        )

    def _composite_map(self, result, node_key):
        return {c.contestant: c.value for c in result.composites if c.node_key == node_key}

    def assertStage(self, result, node_key, expected):
        values = self._composite_map(result, node_key)
        self.assertEqual(values, expected, f"composite {node_key} mismatch")

    def test_golden_schidui_topten_full_chain(self):
        definition = self._def()
        result = resolve(definition, self._inputs())
        self.assertEqual(result.status, ResolverState.READY)
        self.assertEqual(result.reasons, ())
        self.assertEqual(result.schema_version, 1)
        self.assertEqual(result.result_version, 1)
        self.assertTrue(result.content_hash)

        # §11.3 layered Decimals: Stage1 (30/60/10), Stage2 (60/40), Final (30/50/20).
        self.assertStage(
            result,
            "stage1",
            {
                "c1": Decimal("88.1"),
                "c2": Decimal("87.2"),
                "c3": Decimal("86.3"),
                "c4": Decimal("85.4"),
                "c5": Decimal("84.5"),
                "c6": Decimal("83.6"),
                "c7": Decimal("82.7"),
                "c8": Decimal("81.8"),
                "c9": Decimal("80.9"),
                "c10": Decimal("80.0"),
                "c11": Decimal("79.1"),
                "c12": Decimal("78.2"),
                "c13": Decimal("77.3"),
                "c14": Decimal("76.4"),
                "c15": Decimal("75.5"),
            },
        )
        self.assertStage(
            result,
            "stage2",
            {
                "c1": Decimal("92.46"),
                "c2": Decimal("91.52"),
                "c3": Decimal("90.58"),
                "c4": Decimal("89.64"),
                "c5": Decimal("88.70"),
                "c6": Decimal("87.76"),
                "c7": Decimal("86.82"),
                "c8": Decimal("85.88"),
                "c9": Decimal("84.94"),
                "c10": Decimal("84.00"),
            },
        )
        self.assertStage(
            result,
            "final",
            {
                "c1": Decimal("97.0"),
                "c2": Decimal("96.0"),
                "c3": Decimal("95.0"),
                "c4": Decimal("94.0"),
                "c5": Decimal("93.0"),
            },
        )

        # Roster staging: 15 -> 10 -> 5 -> 3.
        self.assertEqual(result.node_values["top10"], [f"c{i}" for i in range(1, 11)])
        self.assertEqual(result.node_values["top5"], [f"c{i}" for i in range(1, 6)])
        self.assertEqual(result.node_values["top3"], ["c1", "c2", "c3"])

        # Origin tags: everyone who reached top-10 was directly selected (DIRECT);
        # contestants never selected into any advance roster are eliminated.
        by_contestant = {d.contestant: d for d in result.decisions}
        self.assertEqual(by_contestant["c1"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by_contestant["c2"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by_contestant["c3"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by_contestant["c1"].rank, 1)
        self.assertEqual(by_contestant["c2"].rank, 2)
        self.assertEqual(by_contestant["c3"].rank, 3)
        for c in (f"c{i}" for i in range(4, 11)):
            self.assertEqual(by_contestant[c].outcome_code, OutcomeCode.DIRECT)
        for c in (f"c{i}" for i in range(11, 16)):
            self.assertEqual(by_contestant[c].outcome_code, OutcomeCode.ELIMINATED)

    def test_golden_schidui_definition_is_forward_only(self):
        """The golden definition resolves READY with all raw facts present."""
        result = resolve(self._def(), self._inputs())
        self.assertEqual(result.status, ResolverState.READY)
        self.assertEqual(len(result.decisions), 15)


class ResolverCheckpointTests(SimpleTestCase):
    """§11-15: a checkpoint resolves only its dependency closure, so a completed
    stage publishes READY before later-stage inputs exist (progressive publication)."""

    def _def(self):
        return GoldenSchiduiTopTenTests()._def()

    def _inputs(self, *, with_r3=False, with_r4=False, with_a4=False):
        roster = tuple(f"c{i}" for i in range(1, 16))
        round_scores = {
            "r1": {f"c{i}": (Decimal(100 - i),) for i in range(1, 16)},
            "r2": {f"c{i}": (Decimal(90 - i),) for i in range(1, 16)},
        }
        if with_r3:
            round_scores["r3"] = {f"c{i}": (Decimal(100 - i),) for i in range(1, 11)}
        if with_r4:
            round_scores["r4"] = {f"c{i}": (Decimal(100 - i),) for i in range(1, 6)}
        vote_scores = {"audience1": {f"c{i}": Decimal("50") for i in range(1, 16)}}
        if with_a4:
            vote_scores["audience4"] = {f"c{i}": Decimal(90 - i) for i in range(1, 6)}
        return ResolveInput(roster=roster, round_scores=round_scores, vote_scores=vote_scores)

    def test_stage1_checkpoint_ready_with_only_first_stage_facts(self):
        # Only R1/R2/Audience1 exist; R3/R4/Audience4 are still missing.
        result = resolve_to_checkpoint(self._def(), self._inputs(), "stage1")
        self.assertEqual(result.status, ResolverState.READY)
        self.assertEqual(result.reasons, ())
        self.assertEqual(result.node_values["top10"], [f"c{i}" for i in range(1, 11)])
        by = {d.contestant: d for d in result.decisions}
        for c in (f"c{i}" for i in range(1, 11)):
            self.assertEqual(by[c].outcome_code, OutcomeCode.DIRECT)
        for c in (f"c{i}" for i in range(11, 16)):
            self.assertEqual(by[c].outcome_code, OutcomeCode.ELIMINATED)

    def test_stage2_checkpoint_requires_r3_not_r4(self):
        # R1/R2/R3/Audience1 present; R4/Audience4 missing -> stage2 still READY.
        result = resolve_to_checkpoint(self._def(), self._inputs(with_r3=True), "stage2")
        self.assertEqual(result.status, ResolverState.READY)
        self.assertEqual(result.node_values["top5"], [f"c{i}" for i in range(1, 6)])
        # §6/P0-4: the Stage2 checkpoint's official decisions reflect the CURRENT stage
        # (Top5), not the replayed Stage1's Top10 — so Top10-minus-Top5 are ELIMINATED.
        by = {d.contestant: d for d in result.decisions}
        for c in (f"c{i}" for i in range(1, 6)):
            self.assertEqual(by[c].outcome_code, OutcomeCode.DIRECT)
        for c in (f"c{i}" for i in range(6, 16)):
            self.assertEqual(by[c].outcome_code, OutcomeCode.ELIMINATED)

    def test_stage3_checkpoint_holds_when_final_stage_facts_missing(self):
        # R3 present but R4/Audience4 missing -> the final stage cannot yet resolve.
        result = resolve_to_checkpoint(self._def(), self._inputs(with_r3=True), "stage3")
        self.assertEqual(result.status, ResolverState.HOLD)
        self.assertTrue(result.reasons)

    def test_stage3_checkpoint_ready_with_all_facts(self):
        result = resolve_to_checkpoint(
            self._def(), self._inputs(with_r3=True, with_r4=True, with_a4=True), "stage3"
        )
        self.assertEqual(result.status, ResolverState.READY)
        self.assertEqual(result.node_values["top3"], ["c1", "c2", "c3"])
        by = {d.contestant: d for d in result.decisions}
        for c in ("c1", "c2", "c3"):
            self.assertEqual(by[c].outcome_code, OutcomeCode.DIRECT)
        for c in (f"c{i}" for i in range(4, 16)):
            self.assertEqual(by[c].outcome_code, OutcomeCode.ELIMINATED)

    def test_checkpoint_input_fingerprint_stable_across_later_stage_data(self):
        # Stage1 identity must not change when r3/r4/a4 (inputs stage1 does not read) arrive.
        before = resolve_to_checkpoint(self._def(), self._inputs(), "stage1")
        after = resolve_to_checkpoint(
            self._def(), self._inputs(with_r3=True, with_r4=True, with_a4=True), "stage1"
        )
        self.assertEqual(before.status, ResolverState.READY)
        self.assertEqual(after.status, ResolverState.READY)
        self.assertEqual(before.input_fingerprint, after.input_fingerprint)

    def test_checkpoint_fingerprint_scopes_duel_decisions_to_its_closure(self):
        definition = _def(
            [
                {
                    "key": "pairs1",
                    "type": "PAIR",
                    "source": ENTRY_KEY,
                    "pairing_policy": "ADJACENT",
                },
                {
                    "key": "duel1",
                    "type": "DUEL",
                    "source": "pairs1",
                    "decision_source": "manual_recorded_result",
                },
                {"key": "winner1", "type": "SELECT", "source": "duel1", "count": 2},
                {
                    "key": "pairs2",
                    "type": "PAIR",
                    "source": ENTRY_KEY,
                    "pairing_policy": "ADJACENT",
                },
                {
                    "key": "duel2",
                    "type": "DUEL",
                    "source": "pairs2",
                    "decision_source": "manual_recorded_result",
                },
                {"key": "winner2", "type": "SELECT", "source": "duel2", "count": 2},
            ]
        )
        definition["checkpoints"] = [{"key": "first", "output": "winner1"}]
        inputs = ResolveInput(
            roster=("a", "b", "c", "d"),
            duel_decisions={
                "duel1": {"a|b": "a", "c|d": "c"},
                "duel2": {"a|b": "b", "c|d": "d"},
            },
        )
        before = resolve_to_checkpoint(definition, inputs, "first")
        changed_duels = dict(inputs.duel_decisions)
        changed_duels["duel2"] = {"a|b": "a", "c|d": "d"}
        after = resolve_to_checkpoint(
            definition,
            ResolveInput(roster=inputs.roster, duel_decisions=changed_duels),
            "first",
        )
        self.assertEqual(before.status, ResolverState.READY)
        self.assertEqual(after.status, ResolverState.READY)
        self.assertEqual(before.input_fingerprint, after.input_fingerprint)

    def test_full_resolve_still_runs_whole_graph(self):
        # The default path is unchanged: the full graph needs r3/r4/a4 and holds without them.
        result = resolve(self._def(), self._inputs())
        self.assertEqual(result.status, ResolverState.HOLD)

    def test_unknown_checkpoint_raises(self):
        with self.assertRaises(ValueError):
            resolve_to_checkpoint(self._def(), self._inputs(), "nope")
