"""Typed condition AST for questionnaire visibility / required-ness (§P1).

Conditions are data, never code: the DSL deliberately has no expression language, no
``eval``, and no embedded JavaScript. A condition is either a combinator over child
conditions or a leaf comparison::

    {"all": [{"source": "answer", "key": "r3.has_guest", "op": "eq", "value": true}]}

``source: "answer"`` reads another question's answer and may only name a question that
appears **earlier** in the document (forward-only), which makes cyclic visibility and
cyclic required-ness structurally impossible — the same discipline the flow DSL uses for
node references. ``source: "context"`` reads a server-generated fact (``qualified.r3``,
``activity.phase``, ``supplement.r2.accompaniment``); the browser can never supply it.
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

    out: dict = {"source": source, "key": key, "op": op}
    if op in UNARY_OPERATORS:
        if "value" in node:
            raise ValidationError(f"{where}：运算符 {op!r} 不接受 value。")
    elif "value" not in node:
        raise ValidationError(f"{where}：运算符 {op!r} 需要 value。")
    else:
        out["value"] = node["value"]
    return out
