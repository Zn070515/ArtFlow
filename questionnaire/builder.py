"""P8 — the operations the staff questionnaire builder performs on a document.

Pure: each function takes a parsed questionnaire, returns a new one, and leaves the input
alone. The view layer decides who may call them and which section of the ruleset definition
the result is written back into (``update_ruleset_definition_section``), so the editor
never assembles a whole definition root.

Every result is re-validated before it is returned. That is deliberate: an operation that
produced a document the compiler would reject is a bug in the editor, and finding it here
means the operator sees why instead of discovering it at freeze.
"""

from __future__ import annotations

import copy
from typing import Iterable

from django.core.exceptions import ValidationError

from .schema import FILE_PURPOSES, NOTICE_TYPE, parse_questionnaire

# The blocks the designer offers, with the shape each starts life with. The defaults are
# deliberately valid documents so adding a block never creates a save-then-fail dead end.
DEFAULT_KEYS: dict[str, dict] = {
    "text": {"label": "单行填空"},
    "textarea": {"label": "多行填空"},
    "number": {"label": "数字"},
    "boolean": {"label": "开关"},
    "single_choice": {"label": "单选"},
    "multiple_choice": {"label": "多选"},
    "select": {"label": "下拉"},
    "file": {"label": "文件上传"},
    "notice": {"label": "说明"},
}

_CHOICE_DEFAULTS = {"single_choice", "multiple_choice", "select"}


def _clone(questionnaire: dict) -> dict:
    return copy.deepcopy(questionnaire)


def _sections(questionnaire: dict) -> Iterable[dict]:
    for page in questionnaire["pages"]:
        yield from page["sections"]


def _section(questionnaire: dict, section_key: str) -> dict:
    for section in _sections(questionnaire):
        if section["key"] == section_key:
            return section
    raise ValidationError(f"没有这个分区：{section_key!r}。")


def _find(questionnaire: dict, key: str) -> tuple[dict, dict, int]:
    for section in _sections(questionnaire):
        for index, question in enumerate(section["questions"]):
            if question["key"] == key:
                return section, question, index
    raise ValidationError(f"没有这道题：{key!r}。")


def _all_keys(questionnaire: dict) -> set[str]:
    return {q["key"] for section in _sections(questionnaire) for q in section["questions"]}


def referenced_keys(questionnaire: dict) -> set[str]:
    """Every question key a condition names."""
    keys: set[str] = set()
    for section in _sections(questionnaire):
        for question in section["questions"]:
            for field in ("visible_if", "required_if"):
                keys |= _condition_keys(question.get(field))
    return keys


def _condition_keys(condition) -> set[str]:
    if not isinstance(condition, dict):
        return set()
    keys = set()
    for combinator in ("all", "any"):
        for child in condition.get(combinator, ()) or ():
            keys |= _condition_keys(child)
    if condition.get("source") == "answer" and isinstance(condition.get("key"), str):
        keys.add(condition["key"])
    return keys


def _next_key(questionnaire: dict, base: str) -> str:
    """A stable key that does not collide: ``base``, then ``base_2``, ``base_3``, …"""
    existing = _all_keys(questionnaire)
    if base not in existing:
        return base
    index = 2
    while f"{base}_{index}" in existing:
        index += 1
    return f"{base}_{index}"


def _slug(label: str) -> str:
    cleaned = "".join(ch if ch.isascii() and (ch.isalnum() or ch == "_") else "" for ch in label)
    return cleaned.lower() or "question"


def default_question(question_type: str, *, key: str) -> dict:
    """A fresh block of ``question_type`` with a usable starting shape."""
    if question_type == NOTICE_TYPE:
        return {"key": key, "type": NOTICE_TYPE, "label": "说明"}
    if question_type not in DEFAULT_KEYS:
        raise ValidationError(f"设计器不支持该题型：{question_type!r}。")
    question: dict = {
        "key": key,
        "type": question_type,
        "label": DEFAULT_KEYS[question_type]["label"],
    }
    if question_type in _CHOICE_DEFAULTS:
        question["options"] = [
            {"value": "option_1", "label": "选项一"},
            {"value": "option_2", "label": "选项二"},
        ]
    elif question_type == "file":
        question["file"] = {
            "purpose": (
                "accompaniment" if "accompaniment" in FILE_PURPOSES else sorted(FILE_PURPOSES)[0]
            ),
            "extensions": [".mp3", ".wav", ".mp4"],
            "max_mb": 500,
            "max_files": 1,
        }
    return question


def add_question(
    questionnaire: dict, *, section_key: str, question_type: str, key: str | None = None
) -> dict:
    """Append a new block to a section."""
    document = _clone(questionnaire)
    section = _section(document, section_key)
    new_key = key or _next_key(document, _slug(section_key))
    if new_key in _all_keys(document):
        raise ValidationError(f"题目 key 已存在：{new_key!r}。")
    section["questions"].append(default_question(question_type, key=new_key))
    return parse_questionnaire(document)


def duplicate_question(questionnaire: dict, *, key: str) -> dict:
    """Copy a block in place, under a new stable key and with its conditions dropped.

    The copied conditions would otherwise point at siblings the copy no longer sits beside,
    and the operator re-attaches what it actually needs.
    """
    document = _clone(questionnaire)
    section, question, index = _find(document, key)
    copy_of = copy.deepcopy(question)
    copy_of["key"] = _next_key(document, question["key"])
    copy_of.pop("visible_if", None)
    copy_of.pop("required_if", None)
    section["questions"].insert(index + 1, copy_of)
    return parse_questionnaire(document)


def update_question(
    questionnaire: dict,
    *,
    key: str,
    label: str,
    description: str = "",
    round_key: str = "",
    required: bool = False,
    options: list[dict[str, str]] | None = None,
    file_config: dict[str, object] | None = None,
) -> dict:
    """Update the human-facing fields commonly changed by staff.

    Conditions remain untouched here. Choice options and file policy are accepted only when
    the structured editor submits the complete field set; the final parser remains the
    authority for uniqueness, registered purposes, extensions, and size ceilings.
    """
    document = _clone(questionnaire)
    _section_for_question, question, _index = _find(document, key)
    clean_label = label.strip()
    if not clean_label:
        raise ValidationError("题目标题不能为空。")
    question["label"] = clean_label
    clean_description = description.strip()
    if clean_description:
        question["description"] = clean_description
    else:
        question.pop("description", None)
    clean_round = round_key.strip()
    if clean_round:
        question["round"] = clean_round
    else:
        question.pop("round", None)
    if question.get("type") != NOTICE_TYPE:
        question["required"] = bool(required)
    if question.get("type") in _CHOICE_DEFAULTS and options is not None:
        question["options"] = options
    if question.get("type") == "file" and file_config is not None:
        question["file"] = file_config
    return parse_questionnaire(document)


def delete_question(questionnaire: dict, *, key: str) -> dict:
    """Remove a block, refusing while another question's condition still names it."""
    dependents = sorted(k for k in _dependents(questionnaire, key))
    if dependents:
        raise ValidationError(
            f"这些题目还依赖 {key!r}：{'、'.join(dependents)}。请先处理它们的显示/必填条件。"
        )
    document = _clone(questionnaire)
    section, _question, index = _find(document, key)
    del section["questions"][index]
    return parse_questionnaire(document)


def _dependents(questionnaire: dict, key: str) -> set[str]:
    dependents = set()
    for section in _sections(questionnaire):
        for question in section["questions"]:
            if question["key"] == key:
                continue
            for field in ("visible_if", "required_if"):
                if key in _condition_keys(question.get(field)):
                    dependents.add(question["key"])
    return dependents


def move_question(questionnaire: dict, *, key: str, delta: int) -> dict:
    """Reorder a block within its own section.

    The result is re-validated, so a move that would put a question above the question its
    condition names is refused here — forward-only is what makes cyclic visibility
    impossible, and the editor cannot let the operator build the cycle and blame the
    compiler for it.
    """
    document = _clone(questionnaire)
    section, _question, index = _find(document, key)
    target = index + delta
    if target < 0 or target >= len(section["questions"]):
        return parse_questionnaire(document)
    questions = section["questions"]
    questions[index], questions[target] = questions[target], questions[index]
    return parse_questionnaire(document)
