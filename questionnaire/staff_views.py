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
from files.policies import FILE_PURPOSE_LABELS, FILE_PURPOSE_POLICIES, effective_file_policy
from ruleset.models import RulesetVersion
from ruleset.services import update_ruleset_definition_section

from .builder import (
    add_question,
    delete_question,
    duplicate_question,
    move_question,
    update_question,
)
from .compiler import compile_questionnaire
from .runtime import completion_summary, resolve_question_value, resolve_questions
from .schema import FILE_PURPOSES, parse_questionnaire

ACTION_LABELS = {
    "add": "新增题目",
    "duplicate": "复制题目",
    "delete": "删除题目",
    "move_up": "上移",
    "move_down": "下移",
    "save_json": "保存 JSON",
    "edit": "编辑题目",
}

QUESTION_TYPE_LABELS = {
    "text": "单行填空",
    "textarea": "多行填空",
    "number": "数字",
    "boolean": "开关",
    "single_choice": "单选",
    "multiple_choice": "多选",
    "select": "下拉",
    "file": "文件上传",
    "notice": "说明",
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
    options = question.get("options", [])
    option_slots = list(options) + [
        {"value": "", "label": ""} for _ in range(max(0, 6 - len(options)))
    ]
    return {
        "key": question["key"],
        "label": question["label"],
        "type": question["type"],
        "type_label": QUESTION_TYPE_LABELS.get(question["type"], question["type"]),
        "round": question.get("round") or "",
        "binding": question.get("binding") or "",
        "description": question.get("description", ""),
        "options": options,
        "option_slots": option_slots,
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
                            "type_label": QUESTION_TYPE_LABELS["notice"],
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
            questions = []
            for question in section["questions"]:
                row = by_key.get(question["key"])
                if row is None:
                    continue
                # The builder edits the stored schema, not the current runtime state. In
                # particular, a required question may be temporarily not due for a round;
                # do not render that runtime result as if it changed the definition.
                questions.append(
                    {
                        **row,
                        "description": question.get("description", ""),
                        "required": question.get("required", False),
                        "round": question.get("round", ""),
                    }
                )
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
    if action == "edit":
        options = None
        if post.get("option_value") is not None:
            values = post.getlist("option_value")
            labels = post.getlist("option_label")
            if len(values) != len(labels):
                raise ValidationError("选择题选项不完整，请同时填写选项值和显示名称。")
            options = []
            for value, label in zip(values, labels, strict=True):
                value = value.strip()
                label = label.strip()
                if not value and not label:
                    continue
                if not value or not label:
                    raise ValidationError(
                        "选择题每一行都要同时填写选项值和显示名称，空白行可以留空。"
                    )
                options.append({"value": value, "label": label})
            if not options:
                raise ValidationError("选择题至少需要保留一个选项。")
        file_config = None
        if post.get("file_purpose") is not None:
            extensions = [
                extension.strip().lower()
                for extension in (post.get("file_extensions") or "").split(",")
                if extension.strip()
            ]
            try:
                max_mb = int(post.get("file_max_mb") or "")
            except (TypeError, ValueError) as exc:
                raise ValidationError("文件大小上限必须是正整数 MB。") from exc
            file_config = {
                "purpose": post.get("file_purpose") or "",
                "extensions": extensions,
                "max_mb": max_mb,
                "max_files": 1,
            }
        return update_question(
            questionnaire,
            key=post.get("key") or "",
            label=post.get("label") or "",
            description=post.get("description") or "",
            round_key=post.get("round") or "",
            required=post.get("required") == "1",
            options=options,
            file_config=file_config,
        )
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
            before = parse_questionnaire(_current_questionnaire(version))
            questionnaire = _apply_action(before, action, request.POST)
            if action in {"move_up", "move_down"} and questionnaire == before:
                direction = "上" if action == "move_up" else "下"
                messages.warning(
                    request, f"这道题不能再向{direction}移动：条件依赖必须保持在前面。"
                )
                return redirect("staff:ruleset_questionnaire", pk=version.pk)
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
    round_choices = [("", "不限定轮次")]
    from singer_contest.models import ContestRound

    round_keys = version.ruleset.round_keys or {}
    rounds = ContestRound.objects.filter(activity=version.ruleset.activity).order_by(
        "sequence", "pk"
    )
    rounds_by_id = {str(contest_round.pk): contest_round for contest_round in rounds}
    candidate_rounds = list(round_keys.items())
    known_keys = {key for key, _round_id in candidate_rounds}
    candidate_rounds.extend(
        (
            f"r{contest_round.sequence}",
            contest_round.pk,
        )
        for contest_round in rounds
        if contest_round.sequence and f"r{contest_round.sequence}" not in known_keys
    )
    for key, round_id in candidate_rounds:
        contest_round = rounds_by_id.get(str(round_id))
        if contest_round is None:
            continue
        label = contest_round.name or contest_round.get_round_type_display()
        round_choices.append((key, f"{key} · {label}"))
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
                ("file", "文件上传"),
                ("notice", "说明"),
            ],
            "file_purposes": sorted(FILE_PURPOSES),
            "file_purpose_options": [
                (purpose, FILE_PURPOSE_LABELS.get(purpose, purpose))
                for purpose in sorted(FILE_PURPOSES)
            ],
            "file_policies": [
                {
                    "purpose": purpose,
                    "label": FILE_PURPOSE_LABELS.get(purpose, purpose),
                    "extensions": sorted(
                        effective_file_policy(purpose, version.ruleset.activity).extensions
                    ),
                    "max_mb": effective_file_policy(purpose, version.ruleset.activity).max_mb,
                    "direct_upload_allowed": effective_file_policy(
                        purpose, version.ruleset.activity
                    ).direct_upload_allowed,
                }
                for purpose in sorted(FILE_PURPOSE_POLICIES)
            ],
            "round_choices": round_choices,
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
