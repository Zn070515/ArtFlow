"""M1-D ruleset compiler: static semantic validation → ValidationReport + ExecutionPlan.

M1-C (:mod:`ruleset.schema`) proves a definition is a *well-typed, forward-only node
graph*. M1-D proves it is also *executable and non-contradictory*: weights normalize,
score scales aren't mixed, judged/trimmed rounds have enough judges, quotas fit their
pools, odd pairings declare a policy, decisive cutoffs declare a tie policy, and every
candidate path that can reach a composite pool actually produces the scores the
composite requires (§16, the "dependency completeness" golden error).

The compiler is deliberately pure/deterministic: it holds no DB state and only reads
facts declared in the definition itself. Numeric facts it cannot know statically
(entry size, judge count, per-round scale & scope) come from an OPTIONAL top-level
``context`` block in the definition. When a fact is absent, count-dependent checks
become non-blocking WARN/INFO ("not verifiable") rather than a hard INVALID — so the
schema-only M1-C acceptance structures still compile.

Output is a :class:`ValidationReport` plus a :class:`ExecutionPlan` that is
stably serializable (``to_dict``/``from_dict`` round-trip) so M1-E can replay it.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum

from django.core.exceptions import ValidationError

from .schema import (
    ENTRY_KEY,
    OutputType,
    content_hash,
    parse_definition,
)

PLAN_VERSION = 1
WEIGHT_SUM_EPS = Decimal("1e-9")
SCORE = "score"

# Provenance pool relation to the entry roster: "full" = same candidates as entry,
# "subset" = strictly fewer, "unknown" = not statically determinate.
POOL_FULL, POOL_SUBSET, POOL_UNKNOWN = "full", "subset", "unknown"


class Severity(StrEnum):
    ERROR = "error"  # hard violation; freeze must abort
    WARN = "warn"  # advisory / unverifiable-until-bound; non-blocking
    REVIEW = "review"  # M1-E must stop and ask a human at a decisive cutoff
    INFO = "info"  # informational (e.g. "count check skipped: no binding")


@dataclass(frozen=True)
class ReportIssue:
    code: str
    severity: Severity
    node_key: str = ""
    path: str = ""
    message: str = ""
    context: dict | None = None

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "severity": self.severity.value,
            "node_key": self.node_key,
            "path": self.path,
            "message": self.message,
            "context": self.context,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ReportIssue":
        return cls(
            code=data["code"],
            severity=Severity(data["severity"]),
            node_key=data.get("node_key", ""),
            path=data.get("path", ""),
            message=data.get("message", ""),
            context=data.get("context"),
        )


@dataclass(frozen=True)
class ValidationReport:
    issues: tuple[ReportIssue, ...] = ()

    def passes(self) -> bool:
        return not any(i.severity is Severity.ERROR for i in self.issues)

    def codes(self) -> set[str]:
        return {i.code for i in self.issues}

    def by_code(self, code: str) -> tuple[ReportIssue, ...]:
        return tuple(i for i in self.issues if i.code == code)

    def counts(self) -> dict[str, int]:
        result: dict[str, int] = {}
        for i in self.issues:
            result[i.severity.value] = result.get(i.severity.value, 0) + 1
        return result

    def to_dict(self) -> dict:
        return {"issues": [i.to_dict() for i in self.issues]}

    @classmethod
    def from_dict(cls, data: dict) -> "ValidationReport":
        return cls(tuple(ReportIssue.from_dict(i) for i in data["issues"]))


@dataclass(frozen=True)
class ExecutionPlan:
    plan_version: int
    content_hash: str
    schema_version: int
    entry: dict
    nodes: tuple[dict, ...]
    summary: dict
    policies: dict

    def to_dict(self) -> dict:
        return {
            "plan_version": self.plan_version,
            "content_hash": self.content_hash,
            "schema_version": self.schema_version,
            "entry": self.entry,
            "nodes": list(self.nodes),
            "summary": self.summary,
            "policies": self.policies,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ExecutionPlan":
        return cls(
            plan_version=data["plan_version"],
            content_hash=data["content_hash"],
            schema_version=data["schema_version"],
            entry=data["entry"],
            nodes=tuple(data["nodes"]),
            summary=data["summary"],
            policies=data["policies"],
        )


# --- D1: map the schema ValidationError into structured GRAPH issues ----------


def _map_graph_error(message: str) -> tuple[str, str]:
    node_key = ""
    match = re.match(r"Node ([^:]+):", message)
    if match:
        node_key = match.group(1)
    if "not valid JSON" in message:
        return "GRAPH_PARSE_ERROR", ""
    if "Unsupported ruleset schema_version" in message:
        return "GRAPH_BAD_VERSION", ""
    if "must contain a non-empty 'nodes' list" in message:
        return "GRAPH_EMPTY", ""
    if "reserved seed key" in message or "is reserved and not implemented" in message:
        return "GRAPH_RESERVED_KEY", node_key
    if "is reserved" in message:
        return "GRAPH_RESERVED_KEY", node_key
    if "duplicate node key" in message:
        return "GRAPH_DUPLICATE_KEY", node_key
    if "unknown node type" in message:
        return "GRAPH_UNKNOWN_TYPE", node_key
    if "unexpected keys" in message:
        return "GRAPH_UNEXPECTED_KEY", node_key
    if "missing required keys" in message:
        return "GRAPH_MISSING_REQUIRED", node_key
    if "is not defined before this node" in message:
        return "GRAPH_FORWARD_REF", node_key
    if "has type" in message:
        return "GRAPH_TYPE_MISMATCH", node_key
    if "duplicates source" in message:
        return "WGHT_DUPLICATE_SOURCE", node_key
    return "GRAPH_INVALID_FIELD", node_key


def _graph_report(exc: ValidationError) -> ValidationReport:
    issues = []
    for message in exc.messages:
        code, node_key = _map_graph_error(message)
        issues.append(ReportIssue(code, Severity.ERROR, node_key, "", message))
    return ValidationReport(tuple(issues))


# --- context helpers ----------------------------------------------------------


def _ctx_round(ctx: dict, key: str) -> dict:
    return (ctx.get("rounds") or {}).get(key) or {}


def _round_scope(ctx: dict, key: str) -> str | None:
    scope = _ctx_round(ctx, key).get("scope")
    return scope if scope in (POOL_FULL, POOL_SUBSET, "none") else None


def _round_scale(ctx: dict, key: str) -> str | None:
    return _ctx_round(ctx, key).get("scale")


def _round_judges(ctx: dict, key: str) -> int | None:
    value = _ctx_round(ctx, key).get("judge_count")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


# --- provenance ---------------------------------------------------------------


def _empty_prov():
    return {"pool_sig": (), "pool_relation": POOL_UNKNOWN, "size": None, "scale": None}


def _flat_sig(sig) -> tuple:
    """Flatten a possibly-nested pool signature into a canonical tuple of strings."""
    if isinstance(sig, (tuple, list)):
        out: list = []
        for s in sig:
            out.extend(_flat_sig(s))
        return tuple(out)
    return (sig,)


def _node_by_key(nodes: list[dict]) -> dict[str, dict]:
    return {node["key"]: node for node in nodes}


def _resolve(node: dict, prov: dict, by_key: dict, ctx: dict) -> dict:
    """Compute provenance (pool identity/size/relation/coverage/scale) for one node."""
    ntype = node["type"]
    p = _empty_prov()

    if ntype == OutputType.ROSTER.value or ntype == "ROSTER":
        pass
    elif ntype == "PARTITION":
        src = prov[node["source"]]
        p.update(pool_sig=src["pool_sig"], pool_relation=src["pool_relation"], size=src["size"])
    elif ntype == "PAIR":
        src = prov[node["source"]]
        p.update(pool_sig=src["pool_sig"], pool_relation=src["pool_relation"], size=src["size"])
    elif ntype == "ASSESS":
        src = prov[node["source"]]
        rnd = node.get("round")
        p.update(pool_sig=src["pool_sig"], pool_relation=src["pool_relation"], size=src["size"])
        p["scale"] = node.get("scale") or _round_scale(ctx, rnd) or "unknown"
    elif ntype == "AGGREGATE":
        comps = node["aggregate"]["components"]
        if comps:
            all_full = all(prov[c["source"]]["pool_relation"] == POOL_FULL for c in comps)
            p["pool_relation"] = POOL_FULL if all_full else POOL_SUBSET
            p["pool_sig"] = tuple(sorted(_flat_sig(prov[c["source"]]["pool_sig"]) for c in comps))
            sizes = [prov[c["source"]]["size"] for c in comps]
            p["size"] = (
                sizes[0] if sizes and all(s == sizes[0] and s is not None for s in sizes) else None
            )
            p["scale"] = node.get("conversion", {}).get("to") if node.get("conversion") else None
    elif ntype == "RANK":
        src = prov[node["source"]]
        p.update(pool_sig=src["pool_sig"], pool_relation=src["pool_relation"], size=src["size"])
    elif ntype == "SELECT":
        p["pool_sig"] = ("select", node["key"])
        p["pool_relation"] = POOL_SUBSET
        p["size"] = node["count"]
    elif ntype == "SUBTRACT":
        minuend = prov[node["minuend"]]
        subt = prov[node["subtrahend"]]
        p["pool_sig"] = ("subtract", node["minuend"], node["subtrahend"])
        p["pool_relation"] = POOL_SUBSET
        if minuend["size"] is not None and subt["size"] is not None:
            p["size"] = max(0, minuend["size"] - subt["size"])
        else:
            p["size"] = minuend["size"]
    elif ntype == "MERGE":
        srcs = [prov[s] for s in node["sources"]]
        p["pool_relation"] = (
            POOL_FULL if all(s["pool_relation"] == POOL_FULL for s in srcs) else POOL_SUBSET
        )
        p["pool_sig"] = ("merge", *tuple(sorted(node["sources"])))
        sizes = [s["size"] for s in srcs if s["size"] is not None]
        p["size"] = sum(sizes) if sizes else None
    elif ntype == "FILL_TO_QUOTA":
        p["pool_sig"] = ("fill", node["key"])
        p["pool_relation"] = POOL_SUBSET
        p["size"] = node.get("quota")
    elif ntype == "MANUAL_SELECT":
        p["pool_sig"] = ("manual", node["key"])
        p["pool_relation"] = POOL_SUBSET
        p["size"] = None
    elif ntype == "BRANCH":
        src = prov[node["source"]]
        p.update(pool_sig=src["pool_sig"], pool_relation=POOL_SUBSET, size=src["size"])
    elif ntype == "AWARD":
        src = prov[node["source"]]
        p.update(pool_sig=src["pool_sig"], pool_relation=src["pool_relation"], size=src["size"])
    else:
        p["pool_sig"] = (ntype, node["key"])
    return p


def _resolve_entry(ctx: dict) -> dict:
    return {
        "pool_sig": (ENTRY_KEY,),
        "pool_relation": POOL_FULL,
        "size": ctx.get("entry_size"),
        "scale": None,
    }


# --- checks -------------------------------------------------------------------


def _check_weight(agg: dict, node_key: str, issues: list[ReportIssue]) -> None:
    if agg.get("type") != "weighted_sum":
        return
    total = Decimal("0")
    for comp in agg["components"]:
        total += Decimal(str(comp["weight"]))
    if abs(total - Decimal("1")) > WEIGHT_SUM_EPS:
        issues.append(
            ReportIssue(
                "WGHT_NOT_NORMALIZED",
                Severity.ERROR,
                node_key,
                "aggregate.components",
                f"权重和为 {total:.10f}，归一化后应为 1.0 ± {WEIGHT_SUM_EPS}。",
            )
        )


def _check_scale(
    node: dict, prov: dict, by_key: dict, ctx: dict, issues: list[ReportIssue]
) -> None:
    if node["type"] != "AGGREGATE":
        return
    comps = node["aggregate"]["components"]
    scales = [prov[c["source"]]["scale"] for c in comps]
    resolved = [s for s in scales if s != "unknown"]
    if any(s == "unknown" for s in scales) and not resolved:
        _warn_scale(
            node, "SCALE_UNDECLARED", "所有分量 scale 未声明，无法校验是否混用量纲。", issues
        )
        return
    if len(set(resolved)) == 1:
        return
    if node.get("conversion"):
        return
    if any(s == "unknown" for s in scales):
        _warn_scale(
            node,
            "SCALE_UNDECLARED",
            "存在未声明 scale 的分量，跨量纲组合需显式 conversion。",
            issues,
        )
        return
    _issue_scale(
        node, "SCALE_MIXED", "混合不同分数制：{}。".format(set(scales)), Severity.ERROR, issues
    )


def _warn_scale(node: dict, code: str, message: str, issues: list[ReportIssue]) -> None:
    issues.append(ReportIssue(code, Severity.WARN, node["key"], "aggregate.components", message))


def _issue_scale(
    node: dict, code: str, message: str, severity: Severity, issues: list[ReportIssue]
) -> None:
    issues.append(ReportIssue(code, severity, node["key"], "aggregate.components", message))


def _check_judges(node: dict, prov: dict, ctx: dict, issues: list[ReportIssue]) -> None:
    if node.get("mode") != "trimmed_mean":
        return
    trims = int(node.get("trim_high") or 0) + int(node.get("trim_low") or 0)
    rnd = node.get("round")
    judges = _round_judges(ctx, rnd)
    if judges is None:
        issues.append(
            ReportIssue(
                "JUDGE_UNVERIFIABLE",
                Severity.WARN,
                node["key"],
                "min_judges",
                "无法校验评委数量：未提供 context.rounds[{}].judge_count。".format(rnd),
            )
        )
        return
    if judges <= trims:
        issues.append(
            ReportIssue(
                "JUDGE_INSUFFICIENT",
                Severity.ERROR,
                node["key"],
                "min_judges",
                f"去最高最低后平均需要 judge_count > trim_high + trim_low（{judges} <= {trims}）。",
            )
        )
    min_judges = node.get("min_judges")
    if min_judges is not None and judges < min_judges:
        issues.append(
            ReportIssue(
                "JUDGE_INSUFFICIENT",
                Severity.ERROR,
                node["key"],
                "min_judges",
                f"评委人数 {judges} 低于要求最低 {min_judges}。",
            )
        )


def _check_quota(
    node: dict, prov: dict, by_key: dict, ctx: dict, issues: list[ReportIssue]
) -> None:
    ntype = node["type"]
    if ntype == "SELECT":
        src_size = prov[node["source"]]["size"]
        if src_size is None:
            issues.append(
                _quota_warn(node, "QUOTA_UNVERIFIABLE", "无法校验 TopN：源候选池大小未知。")
            )
        elif node["count"] > src_size:
            issues.append(
                ReportIssue(
                    "QUOTA_EXCEEDED",
                    Severity.ERROR,
                    node["key"],
                    "count",
                    f"晋级数 {node['count']} 超过理论候选人数 {src_size}。",
                )
            )
    elif ntype == "FILL_TO_QUOTA":
        from_size = prov[node["from"]]["size"]
        if from_size is None:
            issues.append(
                _quota_warn(node, "QUOTA_UNVERIFIABLE", "无法校验 quota：来源池大小未知。")
            )
        elif node["quota"] > from_size:
            issues.append(
                ReportIssue(
                    "POOL_INSUFFICIENT",
                    Severity.ERROR,
                    node["key"],
                    "quota",
                    f"补足名额 {node['quota']} 超过来源池 {from_size}。",
                )
            )
    elif ntype == "MANUAL_SELECT":
        if node.get("groups", 0) <= 0 or node.get("quota", 0) <= 0:
            issues.append(
                ReportIssue(
                    "MANUAL_LIMIT_INVALID",
                    Severity.ERROR,
                    node["key"],
                    "quota",
                    "手动分组选择要求 groups > 0 且 quota > 0。",
                )
            )
        by = _partition_by(by_key, node.get("source"))
        capacity = ((ctx.get("groups") or {}).get(by) or {}).get("capacity") if by else None
        if isinstance(capacity, list) and capacity:
            if node.get("groups") > len(capacity):
                issues.append(
                    ReportIssue(
                        "GROUP_QUOTA_EXCEEDED",
                        Severity.ERROR,
                        node["key"],
                        "groups",
                        f"分组数 {node.get('groups')} 超过组容量数量 {len(capacity)}。",
                    )
                )
            elif node.get("quota") > min(capacity):
                issues.append(
                    ReportIssue(
                        "GROUP_QUOTA_EXCEEDED",
                        Severity.ERROR,
                        node["key"],
                        "quota",
                        f"每组补足名额 {node.get('quota')} 超过最小组容量 {min(capacity)}。",
                    )
                )


def _quota_warn(node: dict, code: str, message: str) -> ReportIssue:
    return ReportIssue(code, Severity.WARN, node["key"], "", message)


def _partition_by(by_key: dict[str, dict], source: str | None) -> str | None:
    if not source:
        return None
    node = by_key.get(source)
    if node and node["type"] == "PARTITION":
        return node.get("by")
    return None


def _check_pair(node: dict, prov: dict, ctx: dict, issues: list[ReportIssue]) -> None:
    if node["type"] != "PAIR":
        return
    size = prov[node["source"]]["size"]
    if size is None:
        issues.append(
            ReportIssue(
                "ODD_UNVERIFIABLE", Severity.WARN, node["key"], "", "无法校验奇偶：池大小未知。"
            )
        )
        return
    if size % 2 == 1 and not node.get("odd_policy"):
        issues.append(
            ReportIssue(
                "ODD_NO_POLICY",
                Severity.ERROR,
                node["key"],
                "odd_policy",
                "参赛人数为奇数且未声明 bye/野生/人工/淘汰。",
            )
        )


def _check_tie(
    node: dict, prov: dict, by_key: dict, issues: list[ReportIssue], cutoffs: list[dict]
) -> None:
    if node["type"] not in ("SELECT", "RANK"):
        return
    decisive = node["type"] == "SELECT" or _feeds_decisive(by_key, node["key"])
    if not decisive:
        return
    policy = node.get("tie_policy")
    if policy is None:
        cutoffs.append({"node": node["key"], "count": node.get("count"), "tie_policy": "review"})
        issues.append(
            ReportIssue(
                "TIE_REVIEW",
                Severity.REVIEW,
                node["key"],
                "tie_policy",
                "决定性截止未声明平局处理，交由人工核定 (REVIEW)。",
            )
        )
        return
    if not _tie_is_supported(node, policy):
        issues.append(
            ReportIssue(
                "TIE_POLICY_UNSUPPORTED",
                Severity.ERROR,
                node["key"],
                "tie_policy",
                "平局处理策略在该节点上不可实现。",
            )
        )
    else:
        cutoffs.append({"node": node["key"], "count": node.get("count"), "tie_policy": policy})


def _feeds_decisive(by_key: dict[str, dict], key: str) -> bool:
    for node in by_key.values():
        if node["type"] == "SELECT" and node.get("source") == key:
            return True
    return False


def _tie_is_supported(node: dict, policy: str) -> bool:
    if policy == "auto_break":
        return True
    if policy == "extra_round":
        return bool(node.get("extra_round"))
    if policy == "score_fallback":
        return bool(node.get("fallback_component"))
    if policy == "manual":
        return True
    return False


def _check_votes(node: dict, ctx: dict, issues: list[ReportIssue]) -> None:
    source = node.get("vote_source")
    if not source:
        return
    votes = ctx.get("votes")
    if not votes:
        issues.append(
            ReportIssue(
                "VOTE_UNVERIFIABLE",
                Severity.WARN,
                node["key"],
                "vote_source",
                "未提供 context.votes 绑定。",
            )
        )
        return
    vote = votes.get(source)
    if vote is None:
        issues.append(
            ReportIssue(
                "VOTE_NOT_READY",
                Severity.ERROR,
                node["key"],
                "vote_source",
                f"投票 {source} 未绑定。",
            )
        )
        return
    if not vote.get("result_ready"):
        issues.append(
            ReportIssue(
                "VOTE_NOT_READY",
                Severity.ERROR,
                node["key"],
                "vote_source",
                f"投票 {source} 尚无可用结果。",
            )
        )
        return
    if (
        node.get("vote_purpose")
        and node["type"] == "ASSESS"
        and node.get("vote_purpose") != "SCORE_COMPONENT"
    ):
        issues.append(
            ReportIssue(
                "VOTE_PURPOSE",
                Severity.ERROR,
                node["key"],
                "vote_purpose",
                f"进入成绩的投票必须为 SCORE_COMPONENT，got {node.get('vote_purpose')}。",
            )
        )
    if (
        node.get("vote_purpose") == "SCORE_COMPONENT"
        and vote.get("scale") not in (None, "hundred")
        and not vote.get("normalization")
    ):
        issues.append(
            ReportIssue(
                "VOTE_NO_NORM",
                Severity.ERROR,
                node["key"],
                "normalization",
                f"投票 {source} 量纲 {vote.get('scale')} 混入应归一化。",
            )
        )


def _check_dependency(
    node: dict, prov: dict, ctx: dict, by_key: dict, issues: list[ReportIssue]
) -> None:
    if node["type"] != "AGGREGATE":
        return
    comps = node["aggregate"]["components"]
    origins: set[str] = set()
    for comp in comps:
        origins |= _origin_rounds(by_key, comp["source"], set())
    subset_hit = None
    for rnd in origins:
        scope = _round_scope(ctx, rnd)
        if scope in (POOL_SUBSET, "none"):
            subset_hit = rnd
            break
    pool_relations = {prov[c["source"]]["pool_relation"] for c in comps}
    mixes_full_subset = POOL_FULL in pool_relations and any(
        prov[c["source"]]["pool_relation"] == POOL_SUBSET for c in comps
    )
    if subset_hit is not None:
        issues.append(
            ReportIssue(
                "MISSING_SCORE_DEPENDENCY",
                Severity.ERROR,
                node["key"],
                "aggregate.components",
                f"某候选路径缺失 {subset_hit} score。",
                {"missing_round": subset_hit, "dropped_path": "候选路径未覆盖该轮评分"},
            )
        )
        return
    if mixes_full_subset:
        issues.append(
            ReportIssue(
                "MISSING_SCORE_DEPENDENCY",
                Severity.ERROR,
                node["key"],
                "aggregate.components",
                "候选池混合了 full/subset 两类来源，部分候选可能缺失所需轮次评分。",
            )
        )
        return
    if any(_round_scope(ctx, rnd) is None for rnd in origins):
        issues.append(
            ReportIssue(
                "SCORE_DEPENDENCY_UNVERIFIABLE",
                Severity.WARN,
                node["key"],
                "aggregate.components",
                "缺少各轮 scope 声明，无法完全校验依赖完整性。",
            )
        )


def _origin_rounds(by_key: dict[str, dict], key: str, seen: set[str]) -> set[str]:
    if key in seen:
        return set()
    seen.add(key)
    node = by_key.get(key)
    if not node:
        return set()
    if node["type"] == "ASSESS" and node.get("round"):
        return {node["round"]}
    if node["type"] == "AGGREGATE":
        found: set[str] = set()
        for comp in node["aggregate"]["components"]:
            found |= _origin_rounds(by_key, comp["source"], seen)
        return found
    return set()


def _node_plan(node: dict, prov: dict, outputs: dict) -> dict:
    plan = {
        "key": node["key"],
        "type": node["type"],
        "output_type": outputs[node["key"]].value,
        "scale": prov[node["key"]]["scale"],
        "candidate_pool": {
            "sig": list(prov[node["key"]]["pool_sig"]),
            "size": prov[node["key"]]["size"],
            "relation": prov[node["key"]]["pool_relation"],
        },
    }
    if node["type"] == "AGGREGATE":
        plan["components"] = [
            {"source": c["source"], "weight": c["weight"], "scale": prov[c["source"]]["scale"]}
            for c in node["aggregate"]["components"]
        ]
        plan["score_weights_sum"] = str(
            sum((Decimal(str(c["weight"])) for c in node["aggregate"]["components"]), Decimal("0"))
        )
    if node.get("round"):
        plan["round"] = node["round"]
    if node.get("tie_policy"):
        plan["tie_policy"] = node["tie_policy"]
    if node.get("odd_policy"):
        plan["odd_policy"] = node["odd_policy"]
    if node.get("vote_source"):
        plan["vote_source"] = node["vote_source"]
    return plan


# --- public entry points ------------------------------------------------------


def compile_definition(
    definition: dict | str, *, context: dict | None = None
) -> tuple[ValidationReport, ExecutionPlan | None]:
    """Validate a definition and build its ExecutionPlan.

    Returns ``(report, plan)``. ``plan`` is ``None`` when the definition fails the
    static graph gate (D1) — an unparseable graph has no executable plan.
    """
    try:
        parsed = parse_definition(definition)
    except ValidationError as exc:  # D1 graph gate
        return _graph_report(exc), None

    obj = definition if isinstance(definition, dict) else json.loads(definition)
    ctx: dict = context if context is not None else (obj.get("context") or {})

    nodes: list[dict] = parsed["nodes"]
    outputs: dict[str, OutputType] = parsed["outputs"]
    by_key = _node_by_key(nodes)

    issues: list[ReportIssue] = []
    prov: dict[str, dict] = {ENTRY_KEY: _resolve_entry(ctx)}
    node_plans: list[dict] = []
    cutoffs: list[dict] = []
    vote_deps: list[dict] = []

    for node in nodes:
        prov[node["key"]] = _resolve(node, prov, by_key, ctx)
        if node["type"] == "AGGREGATE":
            _check_weight(node["aggregate"], node["key"], issues)
        _check_scale(node, prov, by_key, ctx, issues)
        _check_judges(node, prov, ctx, issues)
        _check_quota(node, prov, by_key, ctx, issues)
        _check_pair(node, prov, ctx, issues)
        _check_tie(node, prov, by_key, issues, cutoffs)
        _check_votes(node, ctx, issues)
        _check_dependency(node, prov, ctx, by_key, issues)
        node_plans.append(_node_plan(node, prov, outputs))
        if node.get("vote_source"):
            vote_deps.append(
                {
                    "node": node["key"],
                    "vote_source": node["vote_source"],
                    "purpose": node.get("vote_purpose"),
                }
            )

    report = ValidationReport(tuple(issues))

    summary = {
        "total_nodes": len(nodes),
        "final_outputs": [n["key"] for n in nodes if _is_final(by_key, n["key"])],
        "candidate_pool_sizes": {n["key"]: prov[n["key"]]["size"] for n in nodes},
        "effective_scales": {n["key"]: prov[n["key"]]["scale"] for n in nodes},
        "decisive_cutoffs": cutoffs,
        "vote_dependencies": vote_deps,
        "missing_score_paths": [i.context for i in report.by_code("MISSING_SCORE_DEPENDENCY")],
        "issues_by_severity": report.counts(),
    }
    policies = {
        "tie": {c["node"]: c["tie_policy"] for c in cutoffs},
        "vote": {
            (node.get("vote_source")): (ctx.get("votes") or {}).get(node.get("vote_source"))
            for node in nodes
            if node.get("vote_source")
        },
    }
    plan = ExecutionPlan(
        plan_version=PLAN_VERSION,
        content_hash=content_hash(obj),
        schema_version=parsed["schema_version"],
        entry={"key": ENTRY_KEY, "type": OutputType.ROSTER.value},
        nodes=tuple(node_plans),
        summary=summary,
        policies=policies,
    )
    return report, plan


def _is_final(by_key: dict[str, dict], key: str) -> bool:
    for node in by_key.values():
        for ref in _source_refs(node):
            if ref == key:
                return False
    return True


def _source_refs(node: dict) -> list[str]:
    source = node.get("source")
    refs = [source] if source else []
    refs.extend(node.get("sources") or [])
    if node.get("minuend"):
        refs.append(node["minuend"])
    if node.get("subtrahend"):
        refs.append(node["subtrahend"])
    return [r for r in refs if r]


def compile_version(version) -> tuple[ValidationReport, ExecutionPlan | None]:
    """Compile a ``RulesetVersion`` model instance (thin wrapper over the definition)."""
    return compile_definition(version.definition)
