"""Typed, forward-only ruleset definition schema (§8).

M1-C is schema-only: it validates a *typechecked definition* (a JSON document over
registered node types) that expresses a contest ruleset, but performs no execution.
Execution (scoring, ranking, quota fill, weight normalization, score-scale conversion,
judge-count checks, the freeze gate) is M1-D.

The validator is deliberately hand-rolled (the repo has no pydantic/jsonschema/drf
dependency and stores JSON in a TextField). The single source of truth for "what a node
is" is :data:`NODE_TYPE_SPEC`; the graph is required to be forward-only (a node may only
reference node outputs emitted *before* it), which makes cycles structurally impossible.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Callable

from django.core.exceptions import ValidationError

# Registry of permissible aggregate strategies. Free-form formula strings (e.g.
# "0.3 * x + ...") are forbidden by design; composition is always structured.
AGGREGATE_TYPES = ("weighted_sum", "average")

# Semantic annotations consumed by the M1-D compiler (§16). These are optional
# per-node fields; absent values are resolved to "unknown" by the compiler so the
# M1-C structures (which carry none) still compile. Keep behind the type-graph so
# M1-C parsing is unchanged. ``votes`` (M1-R9) is the raw-vote-count unit: it is a
# count, not a score, so it must never be mixed by weight as a SCORE_COMPONENT.
SCALES = frozenset({"hundred", "ten", "raw", "ordinal", "votes"})
ASSESS_MODES = frozenset({"mean", "trimmed_mean"})
TIE_POLICIES = frozenset({"auto_break", "extra_round", "manual", "score_fallback"})
ODD_POLICIES = frozenset({"bye", "wildcard", "manual", "reject"})
VOTE_PURPOSES = frozenset({"POPULARITY", "SCORE_COMPONENT", "SELECTION", "OTHER"})
CONVERSION_METHODS = frozenset({"factor", "minmax", "rank"})
# FILL_TO_QUOTA distribution mode: "global" fills until the TOTAL across the target
# group map reaches `quota`; "each_group" fills EVERY target group up to `quota`.
FILL_MODES = frozenset({"global", "each_group"})

# The seed node. Every definition begins by referencing ``entry`` (a Roster); it is the
# only pre-declared output and cannot be claimed by a user node.
ENTRY_KEY = "entry"


class OutputType(StrEnum):
    """Statically-typed outputs a node may produce (§8.5)."""

    ROSTER = "Roster"
    SCOREMAP = "ScoreMap"
    RANKED_ROSTER = "RankedRoster"
    DECISION_SET = "DecisionSet"
    GROUP_MAP = "GroupMap"
    PAIR_SET = "PairSet"
    AWARD_SET = "AwardSet"


class NodeType(StrEnum):
    """Registered node types (§8.4). ``REPLACE`` is reserved, not implemented this stage."""

    ROSTER = "ROSTER"
    PARTITION = "PARTITION"
    PAIR = "PAIR"
    ASSESS = "ASSESS"
    AGGREGATE = "AGGREGATE"
    RANK = "RANK"
    SELECT = "SELECT"
    BRANCH = "BRANCH"
    SUBTRACT = "SUBTRACT"
    MERGE = "MERGE"
    FILL_TO_QUOTA = "FILL_TO_QUOTA"
    MANUAL_SELECT = "MANUAL_SELECT"
    AWARD = "AWARD"
    REPLACE = "REPLACE"  # reserved


SCHEMA_VERSION = 1

# Accepted input-output types (frozenset so mypy treats each as an immutable contract).
_ROSTER = frozenset({OutputType.ROSTER})
_SCOREMAP = frozenset({OutputType.SCOREMAP})
_RANKED_ROSTER = frozenset({OutputType.RANKED_ROSTER})
_GROUP_MAP = frozenset({OutputType.GROUP_MAP})
_ROSTER_OR_GROUP_MAP = frozenset({OutputType.ROSTER, OutputType.GROUP_MAP})
# An ordered roster (RANK output or a plain Roster/SELECT) may serve as a ranking order.
_ORDERED_ROSTER = frozenset({OutputType.ROSTER, OutputType.RANKED_ROSTER})


def _run_validators(*validators: Callable[[str, dict], None]) -> Callable[[str, dict], None]:
    """Compose validators that raise on failure.

    The validators annotate ``-> None`` (they raise or pass), so composing them with
    ``a() or b()`` trips mypy's ``[func-returns-value]``. A validator's return value is
    never consumed at the call site, so this just runs each in order.
    """

    def run(name: str, node: dict) -> None:
        for validator in validators:
            validator(name, node)

    return run


def _require_bool(name: str, node: dict, field: str) -> None:
    value = node.get(field)
    if value is not None and not isinstance(value, bool):
        raise ValidationError(f"Node {name}: '{field}' must be a boolean.")


def _require_non_negative_int(name: str, node: dict, field: str) -> None:
    value = node.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValidationError(f"Node {name}: '{field}' must be a non-negative integer.")


def _require_non_empty_str(name: str, node: dict, field: str) -> None:
    value = node.get(field)
    if not isinstance(value, str) or not value:
        raise ValidationError(f"Node {name}: '{field}' must be a non-empty string.")


def _require_non_empty_str_list(name: str, node: dict, field: str) -> None:
    value = node.get(field)
    if not isinstance(value, list) or not value:
        raise ValidationError(f"Node {name}: '{field}' must be a non-empty list.")
    for item in value:
        if not isinstance(item, str) or not item:
            raise ValidationError(f"Node {name}: '{field}' entries must be non-empty strings.")


def _require_optional_non_negative_int(name: str, node: dict, field: str) -> None:
    if node.get(field) is None:
        return
    _require_non_negative_int(name, node, field)


def _require_optional_non_empty_str(name: str, node: dict, field: str) -> None:
    if node.get(field) is None:
        return
    _require_non_empty_str(name, node, field)


def _validate_manual_select(name: str, node: dict) -> None:
    _require_non_negative_int(name, node, "groups")
    _require_non_negative_int(name, node, "quota")


def _validate_fill(name: str, node: dict) -> None:
    _require_non_negative_int(name, node, "quota")
    _require_one_of(name, node, "mode", FILL_MODES)
    _require_bool(name, node, "exclude_selected")
    _require_optional_non_empty_str(name, node, "ranking_source")


def _require_one_of(name: str, node: dict, field: str, allowed: frozenset[str]) -> None:
    value = node.get(field)
    if value is not None and value not in allowed:
        raise ValidationError(
            f"Node {name}: '{field}' must be one of {sorted(allowed)}, got {value!r}."
        )


def _validate_assess(name: str, node: dict) -> None:
    _require_one_of(name, node, "scale", SCALES)
    _require_one_of(name, node, "mode", ASSESS_MODES)
    _require_optional_non_negative_int(name, node, "trim_high")
    _require_optional_non_negative_int(name, node, "trim_low")
    _require_optional_non_negative_int(name, node, "min_judges")
    _require_optional_non_empty_str(name, node, "vote_source")
    _require_one_of(name, node, "vote_purpose", VOTE_PURPOSES)


def _validate_pair(name: str, node: dict) -> None:
    _require_one_of(name, node, "odd_policy", ODD_POLICIES)


def _validate_tie(name: str, node: dict) -> None:
    _require_one_of(name, node, "tie_policy", TIE_POLICIES)
    tie_break = node.get("tie_break_source")
    if tie_break is not None:
        _require_non_empty_str(name, node, "tie_break_source")


def _validate_conversion(name: str, node: dict) -> None:
    conversion = node.get("conversion")
    if conversion is None:
        return
    if not isinstance(conversion, dict):
        raise ValidationError(f"Node {name}: 'conversion' must be an object.")
    _require_one_of(name, {"conversion": conversion.get("to")}, "conversion", SCALES)
    conversions = conversion.get("conversions")
    if not isinstance(conversions, list) or not conversions:
        raise ValidationError(f"Node {name}: conversion 'conversions' must be a non-empty list.")
    for i, entry in enumerate(conversions):
        if not isinstance(entry, dict):
            raise ValidationError(f"Node {name}: conversion {i} must be an object.")
        _require_one_of(name, {"conversion": entry.get("from")}, "conversion", SCALES)
        method = entry.get("method")
        if method not in CONVERSION_METHODS:
            raise ValidationError(
                f"Node {name}: conversion {i} method {method!r} unsupported; "
                f"expected one of {sorted(CONVERSION_METHODS)}."
            )


def _validate_vote(name: str, node: dict) -> None:
    _require_optional_non_empty_str(name, node, "vote_source")
    _require_one_of(name, node, "vote_purpose", VOTE_PURPOSES)


def _validate_aggregate(name: str, node: dict) -> None:
    aggregate = node.get("aggregate")
    if not isinstance(aggregate, dict):
        raise ValidationError(f"Node {name}: 'aggregate' must be an object.")
    agg_type = aggregate.get("type")
    if agg_type not in AGGREGATE_TYPES:
        raise ValidationError(
            f"Node {name}: aggregate type {agg_type!r} unsupported; "
            f"expected one of {AGGREGATE_TYPES}."
        )
    components = aggregate.get("components")
    if not isinstance(components, list) or not components:
        raise ValidationError(f"Node {name}: aggregate 'components' must be a non-empty list.")
    seen = set()
    total = 0.0
    for i, component in enumerate(components):
        if not isinstance(component, dict):
            raise ValidationError(f"Node {name}: component {i} must be an object.")
        source = component.get("source")
        if not isinstance(source, str) or not source:
            raise ValidationError(f"Node {name}: component {i} requires a non-empty 'source'.")
        if source in seen:
            raise ValidationError(f"Node {name}: component {i} duplicates source {source!r}.")
        seen.add(source)
        weight = component.get("weight")
        if isinstance(weight, bool) or not isinstance(weight, (int, float)):
            raise ValidationError(f"Node {name}: component {i} 'weight' must be a number.")
        if weight < 0 or weight > 1:
            raise ValidationError(f"Node {name}: component {i} weight must be in [0, 1].")
        total += weight
    if total <= 0:
        raise ValidationError(f"Node {name}: aggregate component weights must sum to > 0.")
    _validate_conversion(name, node)


def _validate_branch(name: str, node: dict) -> None:
    branches = node.get("branches")
    if not isinstance(branches, list) or not branches:
        raise ValidationError(f"Node {name}: 'branches' must be a non-empty list.")
    for i, branch in enumerate(branches):
        if not isinstance(branch, dict):
            raise ValidationError(f"Node {name}: branch {i} must be an object.")
        if "when" not in branch:
            raise ValidationError(f"Node {name}: branch {i} requires a 'when' condition.")
        if "into" not in branch:
            raise ValidationError(f"Node {name}: branch {i} requires an 'into' target.")


@dataclass(frozen=True)
class NodeSpec:
    """Declarative contract for one node type (shape + static types)."""

    name: str
    output_type: OutputType
    required: tuple[str, ...]
    optional: tuple[str, ...]
    source_refs: tuple[str, ...]
    expects: dict[str, frozenset[OutputType]] | None
    validate: Callable[[str, dict], None] = lambda _name, _node: None


def _spec(
    node_type: NodeType,
    output_type: OutputType,
    *,
    required: tuple[str, ...] = (),
    optional: tuple[str, ...] = (),
    source_refs: tuple[str, ...] = (),
    expects: dict[str, frozenset[OutputType]] | None = None,
    validate: Callable[[str, dict], None] = lambda _name, _node: None,
) -> NodeSpec:
    return NodeSpec(
        name=node_type.value,
        output_type=output_type,
        required=required,
        optional=optional,
        source_refs=source_refs,
        expects=expects,
        validate=validate,
    )


NODE_TYPE_SPEC: dict[str, NodeSpec] = {
    spec.name: spec
    for spec in [
        _spec(NodeType.ROSTER, OutputType.ROSTER),
        _spec(
            NodeType.PARTITION,
            OutputType.GROUP_MAP,
            required=("source", "by"),
            source_refs=("source",),
            expects={"source": _ROSTER},
            validate=lambda n, d: _require_non_empty_str(n, d, "by"),
        ),
        _spec(
            NodeType.PAIR,
            OutputType.PAIR_SET,
            required=("source",),
            optional=("odd_policy",),
            source_refs=("source",),
            expects={"source": _ROSTER},
            validate=_validate_pair,
        ),
        _spec(
            NodeType.ASSESS,
            OutputType.SCOREMAP,
            required=("source",),
            optional=(
                "round",
                "scale",
                "mode",
                "trim_high",
                "trim_low",
                "min_judges",
                "vote_source",
                "vote_purpose",
            ),
            source_refs=("source",),
            expects={"source": _ROSTER},
            validate=_validate_assess,
        ),
        _spec(
            NodeType.AGGREGATE,
            OutputType.SCOREMAP,
            required=("aggregate",),
            optional=("conversion", "within"),
            source_refs=("aggregate.components[].source", "within"),
            expects={"aggregate.components[].source": _SCOREMAP, "within": _ROSTER},
            validate=_validate_aggregate,
        ),
        _spec(
            NodeType.RANK,
            OutputType.RANKED_ROSTER,
            required=("source",),
            optional=("descending", "tie_policy", "tie_break_source"),
            source_refs=("source", "tie_break_source"),
            expects={"source": _SCOREMAP, "tie_break_source": _SCOREMAP},
            validate=_run_validators(lambda n, d: _require_bool(n, d, "descending"), _validate_tie),
        ),
        _spec(
            NodeType.SELECT,
            OutputType.ROSTER,
            required=("source", "count"),
            optional=("tie_policy", "by", "tie_break_source"),
            source_refs=("source", "by", "tie_break_source"),
            expects={"source": _RANKED_ROSTER, "by": _GROUP_MAP, "tie_break_source": _SCOREMAP},
            validate=_run_validators(
                lambda n, d: _require_non_negative_int(n, d, "count"), _validate_tie
            ),
        ),
        _spec(
            NodeType.BRANCH,
            OutputType.DECISION_SET,
            required=("source", "branches"),
            source_refs=("source",),
            validate=_validate_branch,
        ),
        _spec(
            NodeType.SUBTRACT,
            OutputType.ROSTER,
            required=("minuend", "subtrahend"),
            source_refs=("minuend", "subtrahend"),
            expects={"minuend": _ROSTER, "subtrahend": _ROSTER},
        ),
        _spec(
            NodeType.MERGE,
            OutputType.ROSTER,
            required=("sources",),
            source_refs=("sources",),
            expects={"sources": _ROSTER},
            validate=lambda n, d: _require_non_empty_str_list(n, d, "sources"),
        ),
        _spec(
            NodeType.FILL_TO_QUOTA,
            OutputType.GROUP_MAP,
            required=("from", "into", "quota"),
            optional=("ranking_source", "mode", "exclude_selected"),
            source_refs=("from", "into", "ranking_source"),
            expects={
                "from": _ROSTER,
                "into": _GROUP_MAP,
                "ranking_source": _ORDERED_ROSTER,
            },
            validate=_validate_fill,
        ),
        _spec(
            NodeType.MANUAL_SELECT,
            OutputType.GROUP_MAP,
            required=("source", "groups", "quota"),
            source_refs=("source",),
            expects={"source": _ROSTER_OR_GROUP_MAP},
            validate=_validate_manual_select,
        ),
        _spec(
            NodeType.AWARD,
            OutputType.AWARD_SET,
            required=("source", "award"),
            optional=("vote_source", "vote_purpose"),
            source_refs=("source",),
            validate=_run_validators(
                lambda n, d: _require_non_empty_str(n, d, "award"), _validate_vote
            ),
        ),
    ]
}

# Node types that appear in the registry but are reserved/not executable this stage.
RESERVED_NODE_TYPES = {NodeType.REPLACE.value}


def _load(definition: dict | str) -> dict:
    if isinstance(definition, str):
        try:
            obj = json.loads(definition)
        except ValueError as exc:
            raise ValidationError("Ruleset definition is not valid JSON.") from exc
    else:
        obj = definition
    if not isinstance(obj, dict):
        raise ValidationError("Ruleset definition must be an object.")
    return obj


def _as_keys(value: Any):
    """Yield node-key tokens at a leaf (a list of keys, or a single key)."""
    if isinstance(value, list):
        for item in value:
            yield item
    else:
        yield value


def _collect(node: Any, parts: list[str]):
    """Walk ``node`` along ``parts`` (e.g. ``components[].source``) and yield leaf keys."""
    if not parts:
        yield from _as_keys(node)
        return
    part = parts[0]
    rest = parts[1:]
    if part.endswith("[]"):
        sequence = node.get(part[:-2], ()) if isinstance(node, dict) else ()
        if not isinstance(sequence, list):
            raise ValidationError(f"Node {node!r}: expected a list at '{part}'.")
        for item in sequence:
            yield from _collect(item, rest)
    else:
        if isinstance(node, dict) and part in node:
            yield from _collect(node[part], rest)


def _extract_keys(node: dict, path: str) -> list[str]:
    return list(_collect(node, path.split(".")))


def _validate_nodes(nodes: list) -> tuple[list[dict], dict[str, OutputType]]:
    emitted: dict[str, OutputType] = {ENTRY_KEY: OutputType.ROSTER}
    validated: list[dict] = []
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            raise ValidationError(f"Node at index {index} must be an object.")
        key = node.get("key")
        node_type = node.get("type")
        if not isinstance(key, str) or not key:
            raise ValidationError(f"Node at index {index} is missing a non-empty 'key'.")
        if key == ENTRY_KEY:
            raise ValidationError(f"'{ENTRY_KEY}' is a reserved seed key and cannot be used.")
        if not isinstance(node_type, str) or not node_type:
            raise ValidationError(f"Node {key}: missing 'type'.")
        if key in emitted:
            raise ValidationError(f"Node {key}: duplicate node key.")
        if node_type in RESERVED_NODE_TYPES:
            raise ValidationError(
                f"Node {key}: type {node_type!r} is reserved and not implemented."
            )
        spec = NODE_TYPE_SPEC.get(node_type)
        if spec is None:
            raise ValidationError(f"Node {key}: unknown node type {node_type!r}.")
        allowed = set(spec.required) | set(spec.optional) | {"key", "type"}
        extra = set(node) - allowed
        if extra:
            raise ValidationError(f"Node {key}: unexpected keys {sorted(extra)}.")
        missing = [field for field in spec.required if field not in node]
        if missing:
            raise ValidationError(f"Node {key}: missing required keys {missing}.")
        for path in spec.source_refs:
            for ref_key in _extract_keys(node, path):
                if ref_key == ENTRY_KEY:
                    continue
                if ref_key not in emitted:
                    raise ValidationError(
                        f"Node {key}: source {ref_key!r} is not defined before this node "
                        "(forward-only)."
                    )
                expected = (spec.expects or {}).get(path)
                if expected is not None and emitted[ref_key] not in expected:
                    raise ValidationError(
                        f"Node {key}: source {ref_key!r} has type {emitted[ref_key].value}, "
                        f"expected one of {sorted(t.value for t in expected)}."
                    )
        spec.validate(key, node)
        emitted[key] = spec.output_type
        validated.append(node)
    return validated, emitted


_VALID_OUTCOME_CODES = (
    "direct",
    "advanced",
    "repechage",
    "pending",
    "eliminated",
    "wildcard",
    "finalist",
)


def _validate_checkpoints(checkpoints, node_keys: set[str]) -> tuple[dict, ...]:
    """Validate the optional top-level ``checkpoints`` list.

    A checkpoint is ``{key, output, decisions?}``: a named progressive-publication boundary
    that resolves only the dependency closure of ``output`` (so future-stage inputs never
    force a HOLD). ``key`` is the stage identifier (becomes the ``StageResult.stage_key``);
    ``output`` must reference a real node; optional ``decisions`` is an ordered ``[{source,
    outcome}]`` map declaring which node set becomes which official per-stage StageDecision
    (contestants matching no source are ELIMINATED). Absent ``decisions``, membership in
    ``output`` is DIRECT and everyone else ELIMINATED.
    """
    if checkpoints is None:
        return ()
    if not isinstance(checkpoints, list) or not checkpoints:
        raise ValidationError("'checkpoints' 必须是非空列表。")
    seen: set[str] = set()
    out: list[dict] = []
    for index, cp in enumerate(checkpoints):
        if not isinstance(cp, dict):
            raise ValidationError(f"Checkpoint at index {index} must be an object.")
        key = cp.get("key")
        if not isinstance(key, str) or not key:
            raise ValidationError(f"Checkpoint at index {index} is missing a non-empty 'key'.")
        if key in seen:
            raise ValidationError(f"Checkpoint {key}: duplicate checkpoint key.")
        seen.add(key)
        output = cp.get("output")
        if not isinstance(output, str) or not output:
            raise ValidationError(f"Checkpoint {key}: missing a non-empty 'output'.")
        if output not in node_keys:
            raise ValidationError(f"Checkpoint {key}: output {output!r} is not a defined node.")
        decisions_raw = cp.get("decisions") or ()
        if not isinstance(decisions_raw, (list, tuple)):
            raise ValidationError(f"Checkpoint {key}: 'decisions' 必须是列表。")
        decisions: list[dict] = []
        for d in decisions_raw:
            if not isinstance(d, dict):
                raise ValidationError(f"Checkpoint {key}: each decisions entry must be an object.")
            src = d.get("source")
            if not isinstance(src, str) or src not in node_keys:
                raise ValidationError(
                    f"Checkpoint {key}: decisions source {src!r} is not a defined node."
                )
            oc = d.get("outcome")
            if oc not in _VALID_OUTCOME_CODES:
                raise ValidationError(
                    f"Checkpoint {key}: decisions outcome {oc!r} must be one of "
                    f"{', '.join(_VALID_OUTCOME_CODES)}."
                )
            decisions.append({"source": src, "outcome": oc})
        out.append({"key": key, "output": output, "decisions": tuple(decisions)})
    return tuple(out)


def parse_definition(definition: dict | str, schema_version: int | None = None) -> dict:
    """Validate a ruleset definition and return its normalized node list.

    Accepts a Python object or a JSON string. Raises :class:`ValidationError` on any
    schema violation. This is the typed gate M1-C provides; it does not execute anything.
    """
    obj = _load(definition)
    version = obj.get("schema_version", schema_version or SCHEMA_VERSION)
    if version != SCHEMA_VERSION:
        raise ValidationError(
            f"Unsupported ruleset schema_version {version!r}; expected {SCHEMA_VERSION}."
        )
    if "nodes" not in obj or not isinstance(obj["nodes"], list) or not obj["nodes"]:
        raise ValidationError("Ruleset definition must contain a non-empty 'nodes' list.")
    nodes, outputs = _validate_nodes(obj["nodes"])
    checkpoints = _validate_checkpoints(obj.get("checkpoints"), {n["key"] for n in nodes})
    return {
        "schema_version": version,
        "nodes": nodes,
        "outputs": outputs,
        "checkpoints": checkpoints,
    }


def canonical_json(definition: dict | str) -> str:
    """Deterministic (sorted-key) JSON serialization, ignoring key order / whitespace."""
    obj = _load(definition)
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def content_hash(definition: dict | str) -> str:
    """SHA-256 of the canonical JSON form of a definition."""
    return hashlib.sha256(canonical_json(definition).encode("utf-8")).hexdigest()
