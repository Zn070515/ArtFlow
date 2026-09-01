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
    if "Checkpoint" in message:
        return "GRAPH_CHECKPOINT", ""
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
        # A vote_source ASSESS adopts its vote config scale (a SCORE_COMPONENT audience
        # vote sits on the composite's hundred-mark scale), so an AGGREGATE mixing a
        # judge rubric and an audience vote is not misread as a scale mismatch.
        vote_scale = None
        vote_source = node.get("vote_source")
        if vote_source:
            vote_scale = (ctx.get("votes") or {}).get(vote_source, {}).get("scale")
        # M1-R9-Final: at a bound compile the real rubric/vote scale is the authority; a
        # node-declared scale is only an "expected" hint (used for template validation when
        # no entity is bound). Prefer the bound actual so a 50-mark sheet is never misread
        # as hundred inside an AGGREGATE.
        p["scale"] = (
            vote_scale
            or (_round_scale(ctx, rnd) if isinstance(rnd, str) else None)
            or node.get("scale")
            or "unknown"
        )
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
            # An aggregate's output scale is its components' scale: propagate it so a
            # downstream aggregate can verify quantity without a spurious SCALE_MIXED
            # (aggregate-of-aggregate scale was None, tripping the checker).
            if node.get("conversion"):
                p["scale"] = node["conversion"].get("to")
            else:
                comp_scales = {prov[c["source"]]["scale"] for c in comps}
                known = [s for s in comp_scales if s not in (None, "unknown")]
                p["scale"] = known[0] if len(comp_scales) == 1 and known else None
    elif ntype == "RANK":
        src = prov[node["source"]]
        p.update(pool_sig=src["pool_sig"], pool_relation=src["pool_relation"], size=src["size"])
    elif ntype == "SELECT":
        p["pool_sig"] = ("select", node["key"])
        p["pool_relation"] = POOL_SUBSET
        # A `by`-scoped select picks count per group; its flat size depends on the
        # partition's group count, which is not statically known here.
        p["size"] = None if node.get("by") else node["count"]
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


def _check_conversion(node: dict, issues: list[ReportIssue]) -> None:
    # §29-30: scale conversion is declared in the schema but NOT implemented by the
    # resolver, which silently does ``w * v``. Deciding or ignoring it yields wrong
    # math, so forbid it outright (roadmap option B) until a real conversion exists.
    if node.get("conversion"):
        issues.append(
            ReportIssue(
                "CONVERSION_UNSUPPORTED",
                Severity.ERROR,
                node["key"],
                "conversion",
                "分数制换算当前未实现，禁止声明 conversion。",
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
    judges = _round_judges(ctx, rnd) if isinstance(rnd, str) else None
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
            if (node.get("groups") or 0) > len(capacity):
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
    if policy == "auto_break":
        # §M1-R8: a generic auto_break silently falls back to roster order — an
        # implicit rule. It is honest only when a real secondary scoring source is
        # declared (previous_round_score / a prior ScoreMap node). Without one,
        # reject so a definition can never freeze with a hidden tie-break.
        if not node.get("tie_break_source"):
            issues.append(
                ReportIssue(
                    "TIE_AUTO_BREAK_NO_SOURCE",
                    Severity.ERROR,
                    node["key"],
                    "tie_break_source",
                    "平局自动破解 (auto_break) 未声明真实 tie_break_source；"
                    "泛化 auto_break 会退回 roster order 隐式规则，已禁用。",
                )
            )
            return
        # M1-R9-Final (tie exactness): a SELECT auto_break must agree with the ordering used by
        # its source RANK. If the SELECT breaks a tie with a *different* secondary source than
        # the RANK ordered by, the RANK already emitted an order the SELECT cannot re-shuffle —
        # so the cutoff would pick the wrong side. Force the two sources to be identical.
        src = by_key.get(node.get("source"))
        if src is not None and src.get("type") == "RANK":
            sel, rank_tb = node.get("tie_break_source"), src.get("tie_break_source")
            if sel != rank_tb:
                issues.append(
                    ReportIssue(
                        "TIE_SELECT_SOURCE_MISMATCH",
                        Severity.ERROR,
                        node["key"],
                        "tie_break_source",
                        f"SELECT 的 tie_break_source {sel} 必须与其来源 RANK 的 {rank_tb} 一致。",
                    )
                )
                return
        cutoffs.append({"node": node["key"], "count": node.get("count"), "tie_policy": policy})
        return
    if policy == "manual":
        # §M1-R8: the manual tie decision loop (TieDecision / MANUAL_TIE_BREAK)
        # is not yet closed. Mark the policy explicit-incomplete so a definition
        # can never claim a real human loop it does not have.
        cutoffs.append({"node": node["key"], "count": node.get("count"), "tie_policy": policy})
        issues.append(
            ReportIssue(
                "TIE_MANUAL_INCOMPLETE",
                Severity.REVIEW,
                node["key"],
                "tie_policy",
                "平局人工核定闭环 (TieDecision) 尚未实现；当前仅 REVIEW，不真正闭环。",
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
    # §M1-R8: only strategies the resolver truly executes without a roster-order
    # hidden rule are supported. ``manual`` degrades to a REVIEW bundle (closed by
    # a human ManualDecision re-resolve, not by roster order). ``auto_break`` is
    # gated earlier (needs a real tie_break_source); ``extra_round``/``score_fallback``
    # are declared but never actually run (they degrade to a review), so they must be
    # a hard TIE_POLICY_UNSUPPORTED error rather than silently accepted.
    return policy == "manual"


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
    # M1-R9-Final (bound source truth): a vote_source ASSESS must declare its purpose.
    # Omitting vote_purpose used to dodge both the VOTE_PURPOSE gate and the SCORE_COMPONENT
    # raw-vote rejection, letting a node-declared scale pass raw votes into a composite.
    if node["type"] == "ASSESS" and not node.get("vote_purpose"):
        issues.append(
            ReportIssue(
                "VOTE_PURPOSE_REQUIRED",
                Severity.ERROR,
                node["key"],
                "vote_purpose",
                "投票评分节点必须声明 vote_purpose。",
            )
        )
    # M1-R8 (P0-2): a bound freeze validates vote CONFIG, not runtime readiness. Whether
    # a VoteSession has collected ballots / is locked / has a result is a runtime
    # resolver HOLD condition — never a Ruleset Freeze gate. So no ``result_ready`` fact.
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
    # M1-R9 (§三/表单 "Vote/Score Source Truth"): a raw vote count (unit ``votes``) is not
    # a score. It may feed a POPULARITY/SELECTION award, but as a SCORE_COMPONENT it would
    # be mixed by weight as if it were already a 0-100 score — a "looks legal but wrong"
    # result. With no VoteScoringRule/AudienceScore conversion the compiler must refuse it
    # outright rather than silently accept raw counts into a composite.
    if node.get("vote_purpose") == "SCORE_COMPONENT" and vote.get("scale") == "votes":
        issues.append(
            ReportIssue(
                "VOTE_SCORE_COMPONENT_RAW",
                Severity.ERROR,
                node["key"],
                "vote_source",
                f"投票 {source} 为原始票数（量纲 votes），无换算规则，不可进入综合分。",
            )
        )
    if (
        node.get("vote_purpose") == "SCORE_COMPONENT"
        and vote.get("scale") not in (None, "hundred")
        and vote.get("scale") != "votes"
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


def _check_scale_binding(node: dict, ctx: dict, issues: list[ReportIssue]) -> None:
    """A bound ASSESS's declared scale must match its real bound rubric/vote scale.

    At a template compile (no entity bound) the declared scale is a valid "expected" hint.
    At a bound freeze the real scale is the authority; a definition that claims ``hundred``
    over a real 50-mark rubric would otherwise smuggle raw votes/50-mark sheets into a
    composite as if the units matched (§M1-R9-Final bound source truth).
    """
    if node["type"] != "ASSESS":
        return
    declared = node.get("scale")
    if not declared:
        return
    actual = None
    if node.get("vote_source"):
        actual = (ctx.get("votes") or {}).get(node["vote_source"], {}).get("scale")
    elif node.get("round") and isinstance(node.get("round"), str):
        actual = _round_scale(ctx, node["round"])
    if actual and actual != "unknown" and declared != actual:
        issues.append(
            ReportIssue(
                "ASSESS_SCALE_BINDING_MISMATCH",
                Severity.ERROR,
                node["key"],
                "scale",
                f"节点声明 {declared} 与绑定实际 {actual} 不一致。",
            )
        )


def _check_dependency(
    node: dict, prov: dict, ctx: dict, by_key: dict, issues: list[ReportIssue]
) -> None:
    if node["type"] != "AGGREGATE":
        return
    comps = node["aggregate"]["components"]
    # A within-scoped aggregate scores only the referenced advance roster, so mixing full and
    # subset components is intentional: no member of that roster goes unscored. Skip the
    # dependency check entirely for a within-scope.
    if node.get("within"):
        return
    # Scan component round origins in declaration order (not a set) so the reported
    # ``missing_round`` is deterministic: R1 is a full pool, so the first subset round is R2.
    origins: list[str] = []
    for comp in comps:
        for rnd in _origin_rounds(by_key, comp["source"], set()):
            if rnd not in origins:
                origins.append(rnd)
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


# §38-39: facts that are only "unverifiable until bound" (a template legitimately
# lacks real entities). A bound activity freeze has no such excuse — if any of these
# still fires once the real binding is supplied, the freeze must fail rather than
# succeed on a WARN.
_BOUND_STRICT_CODES = {
    "JUDGE_UNVERIFIABLE",
    "QUOTA_UNVERIFIABLE",
    "ODD_UNVERIFIABLE",
    "SCORE_DEPENDENCY_UNVERIFIABLE",
    "VOTE_UNVERIFIABLE",
    "SCALE_UNDECLARED",
}


def _escalate_unverifiable(issues: tuple[ReportIssue, ...]) -> tuple[ReportIssue, ...]:
    out = []
    for issue in issues:
        if issue.code in _BOUND_STRICT_CODES and issue.severity is Severity.WARN:
            out.append(
                ReportIssue(
                    issue.code,
                    Severity.ERROR,
                    issue.node_key,
                    issue.path,
                    f"绑定模式：{issue.message}",
                    issue.context,
                )
            )
        else:
            out.append(issue)
    return tuple(out)


def compile_definition(
    definition: dict | str, *, context: dict | None = None, bound: bool = False
) -> tuple[ValidationReport, ExecutionPlan | None]:
    """Validate a definition and build its ExecutionPlan.

    Returns ``(report, plan)``. ``plan`` is ``None`` when the definition fails the
    static graph gate (D1) — an unparseable graph has no executable plan.

    ``bound=True`` is the §39 *bound activity freeze* level: facts the compiler could
    otherwise only WARN about as "unverifiable until bound" are promoted to ERROR, so a
    freeze never succeeds while a real binding is still missing. Templates leave it
    ``False`` (they legitimately have no real entities and may WARN).
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
        if node["type"] in ("BRANCH", "AWARD"):
            issues.append(
                ReportIssue(
                    "NODE_UNSUPPORTED_RUNTIME",
                    Severity.ERROR,
                    node["key"],
                    "type",
                    "该节点类型当前未实现运行时语义，禁止编译/冻结。",
                )
            )
        if node["type"] == "AGGREGATE":
            _check_weight(node["aggregate"], node["key"], issues)
        _check_scale(node, prov, by_key, ctx, issues)
        _check_conversion(node, issues)
        _check_judges(node, prov, ctx, issues)
        _check_quota(node, prov, by_key, ctx, issues)
        _check_pair(node, prov, ctx, issues)
        _check_tie(node, prov, by_key, issues, cutoffs)
        _check_votes(node, ctx, issues)
        _check_scale_binding(node, ctx, issues)
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

    report = ValidationReport(_escalate_unverifiable(tuple(issues)) if bound else tuple(issues))

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
    if node.get("by"):
        refs.append(node["by"])
    refs.extend(node.get("sources") or [])
    if node.get("minuend"):
        refs.append(node["minuend"])
    if node.get("subtrahend"):
        refs.append(node["subtrahend"])
    return [r for r in refs if r]


def compile_version(version) -> tuple[ValidationReport, ExecutionPlan | None]:
    """Compile a ``RulesetVersion`` model instance (thin wrapper over the definition)."""
    return compile_definition(version.definition)
