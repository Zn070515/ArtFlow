"""P8 — the staff questionnaire designer, its JSON mode, and its previews.

Two things the designer must not do: assemble a whole definition root (it patches the
``questionnaire`` section like every other editor), and write to a FROZEN version (it
doesn't — the section patch refuses, and the page says so before you try).

The JSON mode is not a debug hatch. An agent can compose a questionnaire as JSON, get it
compiled and previewed, and a human can then confirm it; that loop is worth more than any
drag handle, so the JSON is a first-class tab rather than something hidden behind a flag.

The preview answers the question staff actually have before freezing — "what will a
participant see?" — in the four states that differ: nothing filled in, partly filled in,
registration closed, and one question sent back for supplement.
"""

from __future__ import annotations

import json

from accounts.services import require_current_staff
from django.contrib import messages
from django.core.exceptions import PermissionDenied, ValidationError
from django.http import HttpRequest
from django.shortcuts import get_object_or_404, redirect, render
from ruleset.models import RulesetVersion
from ruleset.services import update_ruleset_definition_section

from .builder import add_question, delete_question, duplicate_question, move_question
from .compiler import compile_questionnaire
from .runtime import completion_summary, resolve_question_value, resolve_questions
from .schema import parse_questionnaire

ACTION_LABELS = {
    "add": "新增题目",
    "duplicate": "复制题目",
    "delete": "删除题目",
    "move_up": "上移",
    "move_down": "下移",
    "save_json": "保存 JSON",
}

PREVIEW_CONTEXTS = {
    "participant": "普通选手（尚未填写）",
    "partial": "部分已填写",
    "closed": "报名已关闭",
    "supplement": "需补交",
}

EMPTY_QUESTIONNAIRE = {
    "schema_version": 1,
    "key": "singer_submission",
    "pages": [
        {
            "key": "basic",
            "title": "基本信息",
            "sections": [{"key": "basic", "title": "基本信息", "questions": []}],
        }
    ],
}


def _definition_root(version: RulesetVersion) -> dict:
    try:
        root = json.loads(version.definition)
    except (TypeError, ValueError) as exc:
        raise ValidationError("赛制定义不是合法 JSON。") from exc
    if not isinstance(root, dict):
        raise ValidationError("赛制定义的根必须是对象。")
    return root


def _current_questionnaire(version: RulesetVersion) -> dict:
    raw = _definition_root(version).get("questionnaire")
    return raw if raw is not None else dict(EMPTY_QUESTIONNAIRE)


def _bound_rounds(version: RulesetVersion) -> frozenset[str]:
    return frozenset((version.binding or {}).get("round_keys") or {})


def _row(question, resolved, value) -> dict:
    return {
        "key": question["key"],
        "label": question["label"],
        "type": question["type"],
        "round": question.get("round") or "",
        "binding": question.get("binding") or "",
        "description": question.get("description", ""),
        "options": question.get("options", []),
        "file": question.get("file"),
        "visible": resolved.visible,
        "due": resolved.due,
        "required": resolved.required,
        "value": "" if value is None else value,
        "value_text": value if isinstance(value, str) else "",
        "checked": value is True,
        "selected_values": value if isinstance(value, list) else [],
        "file_name": getattr(value, "original_name", ""),
    }


def _rows(plan, *, answers, context, due_rounds, registration=None, files=None) -> list[dict]:
    resolved_by_key = {
        resolved.question["key"]: resolved
        for resolved in resolve_questions(
            plan,
            answers=answers,
            context=context,
            due_rounds=due_rounds,
            registration=registration,
            files=files,
        )
    }
    rows = []
    for page in plan.pages:
        for section in page["sections"]:
            for block in section["questions"]:
                if block["type"] == "notice":
                    rows.append(
                        {
                            "key": block["key"],
                            "label": block["label"],
                            "type": "notice",
                            "round": "",
                            "binding": "",
                            "description": block.get("description", ""),
                            "options": [],
                            "file": None,
                            "visible": True,
                            "due": True,
                            "required": False,
                            "value": "",
                            "value_text": "",
                            "checked": False,
                            "file_name": "",
                        }
                    )
                    continue
                resolved = resolved_by_key[block["key"]]
                value = resolve_question_value(
                    block, answers=answers, registration=registration, files=files
                )
                rows.append(_row(block, resolved, value))
    return rows


def _page_model(plan, rows) -> list[dict]:
    by_key = {row["key"]: row for row in rows}
    pages = []
    for page in plan.pages:
        sections = []
        for section in page["sections"]:
            questions = [by_key[q["key"]] for q in section["questions"] if q["key"] in by_key]
            sections.append({**section, "questions": questions})
        pages.append({**page, "sections": sections})
    return pages


def _apply_action(questionnaire: dict, action: str, post) -> dict:
    if action == "add":
        return add_question(
            questionnaire,
            section_key=post.get("section_key") or "basic",
            question_type=post.get("question_type") or "text",
        )
    if action == "duplicate":
        return duplicate_question(questionnaire, key=post.get("key") or "")
    if action == "delete":
        return delete_question(questionnaire, key=post.get("key") or "")
    if action in {"move_up", "move_down"}:
        delta = -1 if action == "move_up" else 1
        return move_question(questionnaire, key=post.get("key") or "", delta=delta)
    if action == "save_json":
        try:
            submitted = json.loads(post.get("questionnaire_json") or "")
        except ValueError as exc:
            raise ValidationError("问卷 JSON 不是合法 JSON。") from exc
        return parse_questionnaire(submitted)
    raise ValidationError(f"未知操作：{action!r}。")


def builder_view(request: HttpRequest, pk: int):
    """The designer, its JSON mode, and the write path they share."""
    require_current_staff(request.user)
    version = get_object_or_404(RulesetVersion, pk=pk)
    read_only = version.status == RulesetVersion.Status.FROZEN
    if request.method == "POST":
        if read_only:
            raise PermissionDenied("已冻结赛制版本不可编辑。")
        action = request.POST.get("action") or ""
        try:
            base_content_hash = request.POST.get("base_content_hash") or ""
            if not base_content_hash:
                raise ValidationError("问卷已更新，请刷新后再操作。")
            questionnaire = _apply_action(
                parse_questionnaire(_current_questionnaire(version)), action, request.POST
            )
            update_ruleset_definition_section(
                version,
                section="questionnaire",
                value=questionnaire,
                operator=request.user,
                base_content_hash=base_content_hash,
            )
        except ValidationError as exc:
            messages.error(request, "；".join(getattr(exc, "messages", None) or [str(exc)]))
            return redirect("staff:ruleset_questionnaire", pk=version.pk)
        messages.success(request, f"{ACTION_LABELS.get(action, action)}成功。")
        return redirect("staff:ruleset_questionnaire", pk=version.pk)

    questionnaire = _current_questionnaire(version)
    plan = compile_questionnaire(questionnaire)
    rows = _rows(plan, answers={}, context={}, due_rounds=_bound_rounds(version))
    return render(
        request,
        "staff_panel/questionnaire_builder.html",
        {
            "version": version,
            "ruleset": version.ruleset,
            "activity": version.ruleset.activity,
            "read_only": read_only,
            "questionnaire": questionnaire,
            "questionnaire_json": json.dumps(questionnaire, ensure_ascii=False, indent=2),
            "pages": _page_model(plan, rows),
            "completion": completion_summary(
                plan, registration=None, answers={}, context={}, due_rounds=_bound_rounds(version)
            ),
            "preview_contexts": PREVIEW_CONTEXTS,
            "question_types": [
                ("text", "单行填空"),
                ("textarea", "多行填空"),
                ("number", "数字"),
                ("boolean", "开关"),
                ("single_choice", "单选"),
                ("multiple_choice", "多选"),
                ("select", "下拉"),
                ("notice", "说明"),
            ],
        },
    )


def _preview_answers(plan) -> dict:
    """A partly-filled document: the first text question of each round gets a sample."""
    answers: dict = {}
    seen: set[str] = set()
    for question in plan.questions:
        group = question.get("round") or "basic"
        if question["type"] == "text" and group not in seen:
            seen.add(group)
            answers[question["key"]] = "示例回答"
    return answers


def preview_view(request: HttpRequest, pk: int, context: str):
    """Render the participant form in one of the four states staff need to see."""
    require_current_staff(request.user)
    if context not in PREVIEW_CONTEXTS:
        raise PermissionDenied("未知的预览语境。")
    version = get_object_or_404(RulesetVersion, pk=pk)
    plan = compile_questionnaire(_current_questionnaire(version))
    activity = version.ruleset.activity
    server_context: dict[str, object] = {"activity.phase": activity.phase}
    for key in _bound_rounds(version):
        server_context[f"qualified.{key}"] = context in {"partial", "closed", "supplement"}

    answers = {} if context == "participant" else _preview_answers(plan)
    rows = _rows(
        plan,
        answers=answers,
        context=server_context,
        due_rounds=_bound_rounds(version),
    )
    if context == "supplement":
        # One file question sent back: the participant can see everything and may only
        # re-upload the one thing staff asked for.
        for row in rows:
            if row["type"] == "file":
                row["supplement"] = True
                break
    return render(
        request,
        "staff_panel/questionnaire_preview.html",
        {
            "version": version,
            "activity": activity,
            "context_key": context,
            "context_label": PREVIEW_CONTEXTS[context],
            "preview_contexts": PREVIEW_CONTEXTS,
            "read_only": context != "participant",
            "pages": _page_model(plan, rows),
            "completion": completion_summary(
                plan,
                registration=None,
                answers=answers,
                context=server_context,
                due_rounds=_bound_rounds(version),
            ),
        },
    )
