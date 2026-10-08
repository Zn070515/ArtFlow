"""Typed condition AST for questionnaire visibility / required-ness (§P1).

Conditions are data, never code: the DSL deliberately has no expression language, no
``eval``, and no embedded JavaScript. A condition is either a combinator over child
conditions or a leaf comparison::

    {"all": [{"source": "answer", "key": "r3.has_guest", "op": "eq", "value": true}]}

``source: "answer"`` reads another question's answer and may only name a question that
appears **earlier** in the document (forward-only), which makes cyclic visibility and
cyclic required-ness structurally impossible — the same discipline the flow DSL uses for
node references. ``source: "context"`` reads a server-generated fact (``qualified.r3``,
``activity.phase``, ``group.member_count``); the browser can never supply it, and the key
must be one some server fact actually produces (``CONTEXT_KEYS``).
"""

from __future__ import annotations

from django.core.exceptions import ValidationError

# V1 operators. Deliberately small: comparisons, membership, and emptiness. Anything
# richer belongs in a future schema_version, not in an expression parser.
OPERATORS = frozenset({"eq", "neq", "in", "not_in", "contains", "empty", "not_empty"})
# ``empty``/``not_empty`` are unary; every other operator needs a ``value``.
UNARY_OPERATORS = frozenset({"empty", "not_empty"})

SOURCES = frozenset({"answer", "context"})

COMBINATORS = ("all", "any")

# The server-generated context facts a condition may read (§P1), plus the one open-ended
# family. The browser can never supply a context value, so a key that no server fact
# produces is not "a condition that happens to be false": `evaluate_condition` reads
# ``None``, the comparison is False, and the question stays hidden — or silently stops
# being required — with nothing anywhere naming the typo. `qualified.<round_key>` is
# declared by prefix because there is one key per bound round; the round keys themselves
# are checked against the frozen binding in `cross_domain`.
CONTEXT_KEYS = frozenset(
    {
        "activity.phase",
        "group.stage",
        "group.order",
        "group.member_count",
    }
)
CONTEXT_KEY_PREFIXES = ("qualified.",)


def is_known_context_key(key: str) -> bool:
    """True when some server fact can produce *key* (GOAL §P1)."""
    return key in CONTEXT_KEYS or key.startswith(CONTEXT_KEY_PREFIXES)


def is_blank(value) -> bool:
    """Whether an answer counts as not given.

    An empty string, an empty list and an empty mapping are all "not answered" — which is
    what makes ``empty`` usable as "this question is still open" rather than forcing every
    caller to know which container the question type happens to use.
    """
    return value is None or value == "" or value == [] or value == {}


def evaluate_condition(condition, *, answers, context) -> bool:
    """Evaluate a parsed condition tree against one participant's current answers.

    ``answers`` are the participant's stored answers and ``context`` is server-generated;
    a condition names one source or the other, and there is no way for a browser to supply
    a ``context`` value. A missing condition is satisfied (nothing was asked for).
    """
    if not condition:
        return True
    if "all" in condition:
        return all(
            evaluate_condition(c, answers=answers, context=context) for c in condition["all"]
        )
    if "any" in condition:
        return any(
            evaluate_condition(c, answers=answers, context=context) for c in condition["any"]
        )

    source = answers if condition["source"] == "answer" else context
    value = source.get(condition["key"])
    op = condition["op"]
    expected = condition.get("value")
    if op == "empty":
        return is_blank(value)
    if op == "not_empty":
        return not is_blank(value)
    if op == "eq":
        return bool(value == expected)
    if op == "neq":
        return bool(value != expected)
    if op == "in":
        return value in (expected or ())
    if op == "not_in":
        return value not in (expected or ())
    if op == "contains":
        return isinstance(value, (list, tuple, set, str)) and expected in value
    raise ValidationError(f"未知条件运算符 {op!r}。")


def parse_condition(node, *, prior_keys: frozenset[str] | set[str], where: str) -> dict:
    """Validate and normalize one condition node.

    ``prior_keys`` is the set of question keys that may legally be referenced — every
    question that appears before the one this condition belongs to.
    """
    if not isinstance(node, dict):
        raise ValidationError(f"{where}：条件必须是对象。")
    combinators = [name for name in COMBINATORS if name in node]
    if combinators:
        extra = set(node) - set(combinators)
        if extra:
            raise ValidationError(f"{where}：条件组合子不能与其他字段混用：{sorted(extra)}")
        name = combinators[0]
        children = node[name]
        if not isinstance(children, list) or not children:
            raise ValidationError(f"{where}：'{name}' 必须是条件列表且非空。")
        return {name: [parse_condition(c, prior_keys=prior_keys, where=where) for c in children]}

    source = node.get("source")
    if source not in SOURCES:
        raise ValidationError(f"{where}：条件来源必须是 {sorted(SOURCES)} 之一：{source!r}")
    key = node.get("key")
    if not isinstance(key, str) or not key:
        raise ValidationError(f"{where}：条件缺少非空的 'key'。")
    op = node.get("op")
    if op not in OPERATORS:
        raise ValidationError(f"{where}：未知条件运算符 {op!r}。")
    if source == "answer" and key not in prior_keys:
        # Forward-only: an answer condition may only look backwards.
        raise ValidationError(f"{where}：条件引用了未出现或后置的问题 {key!r}。")
    if source == "context" and not is_known_context_key(key):
        raise ValidationError(
            f"{where}：条件引用了服务器不提供的上下文键 {key!r}"
            f"（可用：{sorted(CONTEXT_KEYS)} 或 qualified.<轮次键>）。"
        )

    out: dict = {"source": source, "key": key, "op": op}
    if op in UNARY_OPERATORS:
        if "value" in node:
            raise ValidationError(f"{where}：运算符 {op!r} 不接受 value。")
    elif "value" not in node:
        raise ValidationError(f"{where}：运算符 {op!r} 需要 value。")
    else:
        out["value"] = node["value"]
    return out
