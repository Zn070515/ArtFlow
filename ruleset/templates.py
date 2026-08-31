"""Reusable ruleset template library (§8.7, §14.2) + idempotent seeder.

Templates are global ``RulesetTemplate`` blueprints: a named ``definition`` (the typed,
forward-only node graph) plus a human description. The source of truth for "what a node is"
stays in :mod:`ruleset.schema`; here we only assemble valid definitions. The 2025 golden
definitions (院十佳 / 校十佳屏峰) are promoted into this module so the seeder, Clone Last
Year, and the editor all share one copy — no year special-casing lives in Python.
"""

from __future__ import annotations

import json

from django.db import transaction

from .schema import ENTRY_KEY, content_hash, parse_definition


def _d(nodes, context=None):
    definition = {"schema_version": 1, "nodes": nodes}
    if context is not None:
        definition["context"] = context
    return json.dumps(definition, ensure_ascii=False)


# --- 2025 golden definitions (single source of truth) -----------------------


def golden_schidui():
    """§11.3 院十佳 weights (30/60/10, 60/40, 30/50/20) as one forward-only graph."""
    return _d(
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


def golden_xiaofeng():
    """§12.5 校十佳屏峰 chain as one forward-only graph of generic primitives."""
    return _d(
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
            {
                "key": "final_groups",
                "type": "PARTITION",
                "source": "merged",
                "by": "final_group",
            },
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


def historical_xiaofeng_control_flow():
    """校十佳屏峰 definite control flow (§24.1): 5 groups x 4, top1/group direct,
    remainder R1 top12, R2 top7, merge, final groups, manual 0~2/group.

    The historical "按综合成绩全局补到6" and the 30/50/20 weights are deliberately NOT
    asserted here: they depend on R2/R3 coverage (see
    ``historical_xiaofeng_fallback_unresolved``) and would otherwise be invented.
    """
    return _d(
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
            {
                "key": "final_groups",
                "type": "PARTITION",
                "source": "merged",
                "by": "final_group",
            },
            {
                "key": "manual",
                "type": "MANUAL_SELECT",
                "source": "final_groups",
                "groups": 3,
                "quota": 2,
            },
        ]
    )


def historical_xiaofeng_fallback_unresolved():
    """校十佳屏峰 historical 30/50/20 (R1+R2+R3) fallback (§24.2).

    The group top-1 direct winners never reach R2/R3, so the aggregate mixes a
    full-roster R1 with subset R2/R3: the validator MUST FAIL MISSING_SCORE_DEPENDENCY.
    This template documents an unresolved rule; it is intentionally NOT executable.
    """
    return _d(
        [
            {
                "key": "groups",
                "type": "PARTITION",
                "source": ENTRY_KEY,
                "by": "initial",
            },
            {"key": "r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            {"key": "rank1", "type": "RANK", "source": "r1", "descending": True},
            {
                "key": "direct",
                "type": "SELECT",
                "source": "rank1",
                "count": 1,
                "by": "groups",
            },
            {"key": "leftover", "type": "SUBTRACT", "minuend": ENTRY_KEY, "subtrahend": "direct"},
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
    )


def synthetic_fill_to_quota_demo():
    """A clean, unambiguous synthetic FILL_TO_QUOTA demo (NOT a 2025 historical rule).

    6 candidates -> 2 final groups; manual 0~2/group; global FILL_TO_QUOTA to a hard
    total of 4, ordered by the r1 ranking (the §22 semantics). Named ``synthetic``: a
    resolver-focused fixture, not a claim about the real 2025 scoring.
    """
    return _d(
        [
            {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            {"key": "rank_r1", "type": "RANK", "source": "assess_r1", "descending": True},
            {
                "key": "final_groups",
                "type": "PARTITION",
                "source": ENTRY_KEY,
                "by": "final_group",
            },
            {
                "key": "manual",
                "type": "MANUAL_SELECT",
                "source": "final_groups",
                "groups": 2,
                "quota": 2,
            },
            {
                "key": "filled",
                "type": "FILL_TO_QUOTA",
                "from": ENTRY_KEY,
                "into": "manual",
                "quota": 4,
                "ranking_source": "rank_r1",
            },
        ]
    )


# --- §14.2 first batch: 10 templates ---------------------------------------


def _first_batch():
    """Ten first-batch templates, each schema-valid and forward-only."""

    def simple_screening():
        return _d(
            [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank", "type": "RANK", "source": "assess_r1", "descending": True},
                {"key": "win", "type": "SELECT", "source": "rank", "count": 10},
            ]
        )

    def single_round_topn():
        return _d(
            [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank", "type": "RANK", "source": "assess_r1", "descending": True},
                {"key": "win", "type": "SELECT", "source": "rank", "count": 10},
            ]
        )

    def weighted_multiround():
        return _d(
            [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "assess_r2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
                {
                    "key": "composite",
                    "type": "AGGREGATE",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "assess_r1", "weight": 0.40},
                            {"source": "assess_r2", "weight": 0.60},
                        ],
                    },
                },
                {"key": "rank", "type": "RANK", "source": "composite", "descending": True},
                {"key": "win", "type": "SELECT", "source": "rank", "count": 10},
            ]
        )

    def judge_audience_composite():
        return _d(
            [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {
                    "key": "assess_a1",
                    "type": "ASSESS",
                    "source": ENTRY_KEY,
                    "vote_source": "audience1",
                },
                {
                    "key": "composite",
                    "type": "AGGREGATE",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "assess_r1", "weight": 0.70},
                            {"source": "assess_a1", "weight": 0.30},
                        ],
                    },
                },
                {"key": "rank", "type": "RANK", "source": "composite", "descending": True},
                {"key": "win", "type": "SELECT", "source": "rank", "count": 10},
            ]
        )

    def independent_popularity_award():
        return _d(
            [
                {
                    "key": "assess_a1",
                    "type": "ASSESS",
                    "source": ENTRY_KEY,
                    "vote_source": "audience1",
                    "vote_purpose": "POPULARITY",
                },
                {"key": "rank", "type": "RANK", "source": "assess_a1", "descending": True},
                {"key": "win", "type": "SELECT", "source": "rank", "count": 1},
            ]
        )

    def group_direct_repechage():
        return _d(
            [
                {
                    "key": "groups",
                    "type": "PARTITION",
                    "source": ENTRY_KEY,
                    "by": "initial_group",
                },
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank", "type": "RANK", "source": "assess_r1", "descending": True},
                {"key": "direct", "type": "SELECT", "source": "rank", "count": 1, "by": "groups"},
                {
                    "key": "leftover",
                    "type": "SUBTRACT",
                    "minuend": ENTRY_KEY,
                    "subtrahend": "direct",
                },
                {"key": "repech", "type": "ASSESS", "source": "leftover", "round": "r1"},
                {"key": "rank2", "type": "RANK", "source": "repech", "descending": True},
                {"key": "top", "type": "SELECT", "source": "rank2", "count": 12},
                {"key": "merged", "type": "MERGE", "sources": ["direct", "top"]},
            ]
        )

    def seeded_pk_wildcard():
        return _d(
            [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank", "type": "RANK", "source": "assess_r1", "descending": True},
                {"key": "seeds", "type": "SELECT", "source": "rank", "count": 8},
                {"key": "pairs", "type": "PAIR", "source": "seeds", "odd_policy": "wildcard"},
                {"key": "assess_pk", "type": "ASSESS", "source": "seeds", "round": "r1"},
                {"key": "rank_pk", "type": "RANK", "source": "assess_pk", "descending": True},
                {"key": "win", "type": "SELECT", "source": "rank_pk", "count": 4},
            ]
        )

    def direct_bye_middle_pk():
        return _d(
            [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank", "type": "RANK", "source": "assess_r1", "descending": True},
                {"key": "direct", "type": "SELECT", "source": "rank", "count": 5},
                {"key": "middle", "type": "SUBTRACT", "minuend": ENTRY_KEY, "subtrahend": "direct"},
                {"key": "assess_mid", "type": "ASSESS", "source": "middle", "round": "r1"},
                {"key": "rank_mid", "type": "RANK", "source": "assess_mid", "descending": True},
                {"key": "win_mid", "type": "SELECT", "source": "rank_mid", "count": 4},
                {"key": "merged", "type": "MERGE", "sources": ["direct", "win_mid"]},
            ]
        )

    def track_team_quota():
        return _d(
            [
                {
                    "key": "tracks",
                    "type": "PARTITION",
                    "source": ENTRY_KEY,
                    "by": "track",
                },
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank", "type": "RANK", "source": "assess_r1", "descending": True},
                {
                    "key": "per_track",
                    "type": "SELECT",
                    "source": "rank",
                    "count": 3,
                    "by": "tracks",
                },
                {"key": "merged", "type": "MERGE", "sources": ["per_track"]},
            ]
        )

    def multivenue_merge():
        return _d(
            [
                {
                    "key": "venues",
                    "type": "PARTITION",
                    "source": ENTRY_KEY,
                    "by": "venue",
                },
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank", "type": "RANK", "source": "assess_r1", "descending": True},
                {
                    "key": "top_per_venue",
                    "type": "SELECT",
                    "source": "rank",
                    "count": 4,
                    "by": "venues",
                },
                {"key": "merged", "type": "MERGE", "sources": ["top_per_venue"]},
            ]
        )

    return [
        ("simple_screening", "海选筛选单场", "单一轮次评分 → 排名 → 取前 N", simple_screening()),
        ("single_round_topn", "单场 Top-N", "一场评分的冠军/晋级前 N", single_round_topn()),
        ("weighted_multiround", "多轮加权", "两轮加权合成 → 排名 → 取前 N", weighted_multiround()),
        (
            "judge_audience_composite",
            "评委+观众合成",
            "评委分与观众票按权重合成",
            judge_audience_composite(),
        ),
        (
            "independent_popularity_award",
            "独立人气奖",
            "仅按观众票取人气奖",
            independent_popularity_award(),
        ),
        (
            "group_direct_repechage",
            "分组直晋+复活",
            "组内直晋 + 复活赛补足",
            group_direct_repechage(),
        ),
        ("seeded_pk_wildcard", "种子 PK+外卡", "种子选手配对 PK, 奇数外卡", seeded_pk_wildcard()),
        ("direct_bye_middle_pk", "直晋+中段PK", "直晋若干 + 中段 PK 补足", direct_bye_middle_pk()),
        ("track_team_quota", "赛道/队伍名额", "按赛道/队伍分组各取固定名额", track_team_quota()),
        ("multivenue_merge", "多场地合并", "分场地评比后合并", multivenue_merge()),
    ]


_FIRST_BATCH_DEFINITIONS = _first_batch()

GOLDEN_SCHIDUI = golden_schidui()
GOLDEN_XIAOFENG = golden_xiaofeng()
HISTORICAL_XIAOFENG_CONTROL_FLOW = historical_xiaofeng_control_flow()
HISTORICAL_XIAOFENG_FALLBACK_UNRESOLVED = historical_xiaofeng_fallback_unresolved()
SYNTHETIC_FILL_TO_QUOTA_DEMO = synthetic_fill_to_quota_demo()
FIRST_BATCH = [
    {"key": key, "name": name, "description": desc, "definition": definition}
    for (key, name, desc, definition) in _FIRST_BATCH_DEFINITIONS
]


def _catalog():
    catalog = [
        ("院十佳", GOLDEN_SCHIDUI, "2025 院十佳：15→10→5→3 加权晋级链"),
        ("校十佳屏峰", GOLDEN_XIAOFENG, "2025 校十佳屏峰：分组直晋 + 复活 + 手动/补足（控制流）"),
        (
            "校十佳屏峰_历史控制流",
            HISTORICAL_XIAOFENG_CONTROL_FLOW,
            "校十佳屏峰确定控制流（§24.1）：5 组直晋 + 复活 + 手动，不含未决补足/权重",
        ),
        (
            "校十佳屏峰_历史未决回退",
            HISTORICAL_XIAOFENG_FALLBACK_UNRESOLVED,
            "校十佳屏峰历史 30/50/20 回退（§24.2）：直晋无 R2，校验必须 FAIL（未决）",
        ),
        (
            "合成_补足至配额演示",
            SYNTHETIC_FILL_TO_QUOTA_DEMO,
            "合成（非历史）FILL_TO_QUOTA 演示：全局补足 + 排名（§22 语义）",
        ),
    ]
    for item in FIRST_BATCH:
        catalog.append((item["name"], item["definition"], item["description"]))
    return catalog


@transaction.atomic
def seed_ruleset_templates(operator=None, *, status=None):
    """Idempotently upsert the template library into :class:`RulesetTemplate`.

    Keyed by ``name``; each row's canonical ``content_hash`` keeps it current. Returns the
    number of templates newly created.
    """
    from .models import RulesetTemplate

    if status is None:
        status = RulesetTemplate.Status.DRAFT

    created = 0
    for name, definition, description in _catalog():
        parsed = parse_definition(definition)
        _, was_created = RulesetTemplate.objects.update_or_create(
            name=name,
            defaults={
                "definition": definition,
                "schema_version": parsed["schema_version"],
                "description": description,
                "status": status,
                "content_hash": content_hash(definition),
                "created_by": operator,
            },
        )
        created += 1 if was_created else 0
    return created
