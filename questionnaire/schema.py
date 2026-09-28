"""Typed Questionnaire DSL (§P1).

The Questionnaire is a **second, independent DSL** inside the ruleset definition root::

    {"schema_version": 1, "nodes": [...], "checkpoints": [...], "context": {...},
     "questionnaire": {"schema_version": 1, "key": "singer_submission", "pages": [...]}}

It carries its own ``schema_version`` so it can be upgraded independently of the flow DSL.
Like :mod:`ruleset.schema`, the validator is hand-rolled (the repo has no pydantic /
jsonschema dependency and stores JSON in a TextField) and validation is pure — nothing here
executes, and nothing here touches the database.

V1 deliberately ships a small block vocabulary. Matrices, ranking, rating scales, formulas,
randomised questions, exams, and any embedded JS/HTML/expression are *out of scope by
design*, not merely unimplemented: adding them is a new ``schema_version``.

A note on units: ``file.purpose`` is a *technical* file type policed by the ``files`` app
(MIME, magic bytes, size, versioning) while ``question.key`` is the *business* identity
("the second round's accompaniment"). The two are never merged — a question declares a
purpose, it never becomes one.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from django.core.exceptions import ValidationError

from .conditions import parse_condition

SCHEMA_VERSION = 1

# Structure blocks. A NOTICE is display-only and is not answerable, so it is separated out
# of the compiled question list rather than being given a degenerate answer slot.
NOTICE_TYPE = "notice"

# Question blocks.
FILE_TYPE = "file"
CHOICE_TYPES = frozenset({"single_choice", "multiple_choice", "select"})
ANSWERABLE_TYPES = frozenset(
    {
        "text",
        "textarea",
        "number",
        "boolean",
        "single_choice",
        "multiple_choice",
        "select",
        FILE_TYPE,
    }
)

# Only these may be bound into a questionnaire, and only from a participant-facing one.
# ``pre_status`` / ``live_status`` and anything on ``user`` or ``activity`` are staff or
# derived authority — a browser must never be able to write them through an answer.
BINDING_WHITELIST = frozenset(
    {
        "registration.name",
        "registration.student_id",
        "registration.college",
        "registration.class_name",
        "registration.phone",
        "registration.wechat",
    }
)

# File purposes the ``files`` app can police. A question names one of these; it never
# invents a new technical file type.
FILE_PURPOSES = frozenset(
    {
        "accompaniment",
        "performance_video",
        "program_material",
        "public_image",
        "attachment",
    }
)
# The server's own ceiling. A question may ask for less, never more.
MAX_FILE_MB_HARD_LIMIT = 500

AUDIENCES = frozenset({"participant", "staff"})
# When an answer becomes due. ``upfront`` is the registration pass; ``before_round`` gates
# it on a round existing/starting (round keys are resolved at freeze, §P2).
DUE_MODES = frozenset({"upfront", "before_round"})

# Round references are ``r1``, ``r2``, ... — the same namespace the flow DSL binds.
ROUND_KEY_RE = re.compile(r"^r[0-9]+$")
# Keys are dotted lowercase segments: ``name``, ``r3.guest_name``.
KEY_RE = re.compile(r"^[a-z0-9_]+(?:\.[a-z0-9_]+)*$")


def _require(condition: object, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def _as_dict(value: object, message: str) -> dict:
    if not isinstance(value, dict):
        raise ValidationError(message)
    return value


def _as_list(value: object, message: str) -> list:
    if not isinstance(value, list):
        raise ValidationError(message)
    return value


def _as_str(value: object, message: str) -> str:
    if not isinstance(value, str):
        raise ValidationError(message)
    return value


def _as_key(value: object, message: str) -> str:
    """Narrow a value to a well-formed dotted key, raising on anything else."""
    if not isinstance(value, str) or not KEY_RE.match(value):
        raise ValidationError(message)
    return value


def _load(questionnaire: dict | str | None) -> dict:
    if isinstance(questionnaire, str):
        try:
            questionnaire = json.loads(questionnaire)
        except ValueError as exc:
            raise ValidationError("问卷定义不是合法 JSON。") from exc
    return _as_dict(questionnaire, "问卷定义必须是对象。")


def _parse_file_config(question: dict, where: str) -> dict:
    config = _as_dict(question.get("file"), f"{where}：file 题必须声明 file 配置。")
    purpose = config.get("purpose")
    _require(
        isinstance(purpose, str) and purpose in FILE_PURPOSES,
        f"{where}：未注册的文件用途 {purpose!r}。",
    )
    extensions = _as_list(config.get("extensions"), f"{where}：file.extensions 必须是列表。")
    _require(
        bool(extensions) and all(isinstance(e, str) for e in extensions),
        f"{where}：file.extensions 必须是非空字符串列表。",
    )
    max_mb = config.get("max_mb")
    _require(
        isinstance(max_mb, int) and not isinstance(max_mb, bool) and max_mb > 0,
        f"{where}：file.max_mb 必须是正整数。",
    )
    _require(
        isinstance(max_mb, int) and max_mb <= MAX_FILE_MB_HARD_LIMIT,
        f"{where}：file.max_mb={max_mb} 超过服务器上限 {MAX_FILE_MB_HARD_LIMIT} MB。",
    )
    max_files = config.get("max_files", 1)
    _require(
        isinstance(max_files, int) and not isinstance(max_files, bool) and max_files > 0,
        f"{where}：file.max_files 必须是正整数。",
    )
    return {
        "purpose": purpose,
        "extensions": list(extensions),
        "max_mb": max_mb,
        "max_files": max_files,
    }


def _parse_choice_options(question: dict, where: str, key: str) -> list[dict]:
    options = _as_list(question.get("options"), f"{where}：题目 {key!r} 是选择题但缺少 options。")
    _require(bool(options), f"{where}：题目 {key!r} 的 options 不能为空。")
    seen: set[str] = set()
    normalized: list[dict] = []
    for option in options:
        item = _as_dict(option, f"{where}：题目 {key!r} 的 options 项必须是对象。")
        message = f"{where}：题目 {key!r} 的 options 项需要非空 value 与 label。"
        value = _as_str(item.get("value"), message)
        label = _as_str(item.get("label"), message)
        _require(bool(value) and bool(label), message)
        _require(value not in seen, f"{where}：题目 {key!r} 的选项 value 重复：{value!r}。")
        seen.add(value)
        normalized.append({"value": value, "label": label})
    return normalized


def _parse_due(question: dict, where: str, key: str) -> dict:
    due = _as_dict(question.get("due"), f"{where}：题目 {key!r} 的 due 必须是对象。")
    mode = due.get("mode")
    _require(
        isinstance(mode, str) and mode in DUE_MODES,
        f"{where}：题目 {key!r} 的 due.mode 非法：{mode!r}。",
    )
    normalized: dict[str, Any] = {"mode": mode}
    if mode == "before_round":
        due_round = due.get("round")
        _require(
            isinstance(due_round, str) and bool(ROUND_KEY_RE.match(due_round)),
            f"{where}：题目 {key!r} 的 due.round 非法：{due_round!r}。",
        )
        normalized["round"] = due_round
    return normalized


def _parse_question(question: dict, *, where: str, prior_keys: frozenset[str]) -> dict:
    """Validate one block and return its normalized form.

    A NOTICE comes back too, and stays *in place* among the questions: it is display-only,
    but where it appears is part of the document, and a renderer has to see it in order.
    Consumers that want only answerable questions filter on the type — the compiler does.
    """
    key = _as_key(question.get("key"), f"{where}：非法题目 key {question.get('key')!r}。")
    label = question.get("label")
    _require(isinstance(label, str) and bool(label.strip()), f"{where}：题目 {key!r} 缺少 label。")
    qtype = question.get("type")

    if qtype == NOTICE_TYPE:
        notice: dict[str, Any] = {"key": key, "type": NOTICE_TYPE, "label": label}
        description = question.get("description")
        if isinstance(description, str) and description:
            notice["description"] = description
        return notice

    _require(
        isinstance(qtype, str) and qtype in ANSWERABLE_TYPES,
        f"{where}：未知题目类型 {qtype!r}。",
    )

    out: dict[str, Any] = {"key": key, "type": qtype, "label": label}
    description = question.get("description")
    if isinstance(description, str) and description:
        out["description"] = description

    binding = question.get("binding")
    if binding is not None:
        _require(isinstance(binding, str), f"{where}：题目 {key!r} 的 binding 必须是字符串。")
        _require(
            binding in BINDING_WHITELIST,
            f"{where}：题目 {key!r} 的 binding {binding!r} 不在白名单内"
            "（staff 专属或派生字段不可绑定）。",
        )
        out["binding"] = binding

    audience = question.get("audience", "participant")
    _require(
        isinstance(audience, str) and audience in AUDIENCES,
        f"{where}：题目 {key!r} 的 audience 非法：{audience!r}。",
    )
    out["audience"] = audience

    round_key = question.get("round")
    if round_key is not None:
        _require(
            isinstance(round_key, str) and bool(ROUND_KEY_RE.match(round_key)),
            f"{where}：题目 {key!r} 的 round 非法：{round_key!r}。",
        )
        out["round"] = round_key

    if question.get("due") is not None:
        out["due"] = _parse_due(question, where, key)

    required = question.get("required", False)
    _require(isinstance(required, bool), f"{where}：题目 {key!r} 的 required 必须是布尔。")
    required_if = question.get("required_if")
    if required and required_if is not None:
        # Unconditional and conditional required-ness say different things; a reader (or a
        # completion counter) cannot honour both.
        raise ValidationError(f"{where}：题目 {key!r} 同时声明了 required 与 required_if。")
    out["required"] = required

    if qtype in CHOICE_TYPES:
        out["options"] = _parse_choice_options(question, where, key)

    if qtype == FILE_TYPE:
        out["file"] = _parse_file_config(question, f"{where}/题目 {key!r}")

    validation = question.get("validation")
    if validation is not None:
        out["validation"] = dict(
            _as_dict(validation, f"{where}：题目 {key!r} 的 validation 必须是对象。")
        )

    for field in ("visible_if", "required_if"):
        raw = question.get(field)
        if raw is None:
            continue
        out[field] = parse_condition(raw, prior_keys=prior_keys, where=f"{where}/题目 {key!r}")

    return out


def parse_questionnaire(questionnaire: dict | str | None) -> dict:
    """Validate a questionnaire and return its normalized form.

    Raises :class:`~django.core.exceptions.ValidationError` on any violation. Pure: reads
    no database, resolves no round. Cross-domain facts (does ``r3`` exist in the frozen
    ruleset?) are the freeze-time concern of §P2, not of this gate.
    """
    obj = _load(questionnaire)
    version = obj.get("schema_version", SCHEMA_VERSION)
    _require(
        version == SCHEMA_VERSION,
        f"不支持的问卷 schema_version {version!r}；期望 {SCHEMA_VERSION}。",
    )
    key = _as_key(obj.get("key"), f"问卷 key 非法：{obj.get('key')!r}。")
    pages_raw = _as_list(obj.get("pages"), "问卷必须包含非空 'pages' 列表。")
    _require(bool(pages_raw), "问卷必须包含非空 'pages' 列表。")

    seen_question_keys: set[str] = set()
    notice_keys: set[str] = set()
    seen_section_keys: set[str] = set()
    seen_page_keys: set[str] = set()
    pages: list[dict] = []
    notices: list[dict] = []

    for page_index, page_raw in enumerate(pages_raw):
        page_where = f"page[{page_index}]"
        page = _as_dict(page_raw, f"{page_where}：页必须是对象。")
        page_key = _as_key(page.get("key"), f"{page_where}：非法 page key {page.get('key')!r}。")
        _require(page_key not in seen_page_keys, f"{page_where}：page key 重复：{page_key!r}。")
        seen_page_keys.add(page_key)
        sections_raw = _as_list(page.get("sections"), f"{page_where}：页必须包含 'sections' 列表。")
        _require(bool(sections_raw), f"{page_where}：页必须包含非空 'sections' 列表。")

        sections: list[dict] = []
        for section_index, section_raw in enumerate(sections_raw):
            section_where = f"{page_where}/section[{section_index}]"
            section = _as_dict(section_raw, f"{section_where}：分区必须是对象。")
            section_key = _as_key(
                section.get("key"), f"{section_where}：非法 section key {section.get('key')!r}。"
            )
            _require(
                section_key not in seen_section_keys,
                f"{section_where}：section key 重复：{section_key!r}。",
            )
            seen_section_keys.add(section_key)
            blocks_raw = _as_list(
                section.get("questions"), f"{section_where}：分区必须包含 'questions' 列表。"
            )

            blocks: list[dict] = []
            for block_index, block_raw in enumerate(blocks_raw):
                block_where = f"{section_where}/question[{block_index}]"
                block = _as_dict(block_raw, f"{block_where}：题目必须是对象。")
                block_key = _as_key(
                    block.get("key"), f"{block_where}：非法题目 key {block.get('key')!r}。"
                )
                _require(
                    block_key not in seen_question_keys,
                    f"{block_where}：题目 key 重复：{block_key!r}。",
                )
                # Forward-only: a condition may only name *answerable* blocks that already
                # appeared — a notice has no answer to compare against.
                normalized = _parse_question(
                    block,
                    where=block_where,
                    prior_keys=frozenset(seen_question_keys - notice_keys),
                )
                seen_question_keys.add(block_key)
                if normalized["type"] == NOTICE_TYPE:
                    notice_keys.add(block_key)
                    notices.append(normalized)
                blocks.append(normalized)
            sections.append(
                {
                    "key": section_key,
                    "title": section.get("title") or section_key,
                    "questions": blocks,
                }
            )
        pages.append(
            {"key": page_key, "title": page.get("title") or page_key, "sections": sections}
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "key": key,
        "pages": pages,
        "notices": notices,
    }


def canonical_json(questionnaire: dict | str) -> str:
    """Deterministic (sorted-key) JSON serialization, ignoring key order / whitespace."""
    return json.dumps(
        _load(questionnaire), sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )


def schema_hash(questionnaire: dict | str) -> str:
    """SHA-256 of the canonical, *normalized* form of a questionnaire.

    The questionnaire rides inside the ruleset definition, so the ruleset's own
    ``content_hash`` already covers it; this hash exists for response staleness detection
    and for the builder's "has this changed?" comparison. Hashing the normalized form makes
    it a semantic identity: whitespace, key order, and unknown extra fields do not move it.
    """
    return hashlib.sha256(
        canonical_json(parse_questionnaire(questionnaire)).encode("utf-8")
    ).hexdigest()
