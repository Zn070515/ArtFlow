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
from django.urls import reverse
from files.policies import FILE_PURPOSE_LABELS, FILE_PURPOSE_POLICIES, effective_file_policy
from ruleset.models import RulesetVersion
from ruleset.services import (
    LIVE_CHALLENGE_FORMAT_KEY,
    newer_ruleset_version,
    update_ruleset_definition_sections,
    version_is_editable,
)
from ruleset.templates import live_2026_group_questionnaire

from .builder import (
    add_question,
    delete_question,
    duplicate_question,
    move_question,
    update_question,
)
from .compiler import compile_questionnaire
from .runtime import completion_summary, resolve_question_value, resolve_questions
from .schema import FILE_PURPOSES, QUESTIONNAIRE_ROOT_KEYS, parse_questionnaire

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

# The designer's starter is the same document the built-in template ships, so the two
# cannot drift. ``_current_questionnaire`` returns a copy before any edit.
EMPTY_GROUP_QUESTIONNAIRE = live_2026_group_questionnaire()


def _definition_root(version: RulesetVersion) -> dict:
    try:
        root = json.loads(version.definition)
    except (TypeError, ValueError) as exc:
        raise ValidationError("赛制定义不是合法 JSON。") from exc
    if not isinstance(root, dict):
        raise ValidationError("赛制定义的根必须是对象。")
    return root


def _current_questionnaire(version: RulesetVersion, *, subject: str = "participant") -> dict:
    if subject not in QUESTIONNAIRE_ROOT_KEYS:
        raise ValidationError("未知的问卷主体。")
    root = _definition_root(version)
    raw = root.get(QUESTIONNAIRE_ROOT_KEYS[subject])
    if raw is None and subject == "group":
        legacy = root.get("questionnaire")
        if legacy is not None:
            try:
                if compile_questionnaire(legacy).subject == "group":
                    return legacy
            except ValidationError:
                pass
    if raw is not None:
        return raw
    starter = EMPTY_GROUP_QUESTIONNAIRE if subject == "group" else EMPTY_QUESTIONNAIRE
    return dict(starter)


def _require_subject(questionnaire: dict, subject: str) -> dict:
    if questionnaire.get("subject", "participant") != subject:
        raise ValidationError("问卷主体与当前编辑页不一致，请刷新后重试。")
    return questionnaire


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
        "file_version": getattr(value, "version", 0),
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
            accepts = [
                purpose.strip()
                for purpose in post.getlist("file_accepts")
                if purpose.strip()
            ]
            file_config = {
                "purpose": post.get("file_purpose") or "",
                "extensions": extensions,
                "max_mb": max_mb,
                "max_files": 1,
            }
            if accepts:
                file_config["accepts"] = accepts
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


def _read_only_reason(version: RulesetVersion) -> str:
    """Why this version's designer is read-only, in the operator's words.

    "Not editable" has two causes and they need different next steps: a frozen version is
    the authority and the way on is a successor draft, while a draft that a newer version
    has replaced is history and the way on is that newer version. The write path has always
    refused both; the page has to say which one this is.
    """

    if version.status == RulesetVersion.Status.FROZEN:
        return "已冻结赛制版本不可编辑。若要修改问卷，请先创建后继版本。"
    newer = newer_ruleset_version(version)
    if newer is not None:
        return f"这一版赛制已被 v{newer.version} 替代，不能继续编辑。请在最新版本上修改问卷。"
    return "这一版赛制不能编辑。"


def _round_identity_binding(version: RulesetVersion) -> dict:
    """The round identity this version's questions are written against.

    A FROZEN version answers for itself: its snapshot is the binding its questions were
    authored against, and the shared ``ContestRuleset`` may already have been rebound for a
    successor draft. While the version is a draft, the live ruleset *is* what will be
    snapshotted at freeze, so that is what it reads.
    """

    if version.status == RulesetVersion.Status.FROZEN:
        return version.binding or {}
    ruleset = version.ruleset
    return {
        "round_keys": dict(ruleset.round_keys or {}),
        "live_challenge": dict(ruleset.live_challenge or {}),
    }


def _round_choices(version: RulesetVersion, questionnaire: dict) -> list[tuple[str, str]]:
    """Every round key a question may be bound to, named as well as the server can name it.

    Three sources, because a round key is not always a physical round: the version's binding,
    the logical rounds the format declares (2026's r2/r3 — their scoring rounds are created
    live by the challenge and only after a confirmed session, so neither is in ``round_keys``
    when the questionnaire is written), and whatever the questionnaire already uses.

    What is *not* a source is ``ContestRound.sequence``: guessing ``r{sequence}`` is how an
    existing question silently changed meaning, because a round cloned for a successor
    carries ``sequence = max + 1`` and appeared as "r2" — the challenge round's key.
    """

    from singer_contest.materials import LIVE_PERSONAL_ROUND_NAMES, LIVE_PERSONAL_ROUNDS
    from singer_contest.models import ContestRound

    binding = _round_identity_binding(version)
    rounds_by_id = {
        str(contest_round.pk): contest_round
        for contest_round in ContestRound.objects.filter(activity=version.ruleset.activity)
    }
    choices: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(key: str, label: str) -> None:
        if key and key not in seen:
            seen.add(key)
            choices.append((key, f"{key} · {label or key}"))

    for key, round_id in (binding.get("round_keys") or {}).items():
        contest_round = rounds_by_id.get(str(round_id))
        label = ""
        if contest_round is not None:
            label = contest_round.name or contest_round.get_round_type_display()
        add(str(key), label)

    live = binding.get("live_challenge") or {}
    if str(live.get("format_key") or "") == LIVE_CHALLENGE_FORMAT_KEY:
        for key in LIVE_PERSONAL_ROUNDS:
            add(key, LIVE_PERSONAL_ROUND_NAMES.get(key, ""))

    for page in questionnaire.get("pages") or []:
        for section in page.get("sections") or []:
            for question in section.get("questions") or []:
                add(str(question.get("round") or "").strip(), "")
    return choices


def builder_view(request: HttpRequest, pk: int, subject: str = "participant"):
    """The designer, its JSON mode, and the write path they share."""
    if subject not in QUESTIONNAIRE_ROOT_KEYS:
        raise PermissionDenied("未知的问卷主体。")
    builder_route = (
        "staff:ruleset_group_questionnaire"
        if subject == "group"
        else "staff:ruleset_questionnaire"
    )
    preview_route = (
        "staff:ruleset_group_questionnaire_preview"
        if subject == "group"
        else "staff:ruleset_questionnaire_preview"
    )
    require_current_staff(request.user)
    version = get_object_or_404(RulesetVersion, pk=pk)
    # The same rule every other editor asks: the newest row, and only while it is a DRAFT.
    # Reading the status alone left a superseded draft looking editable, so the operator
    # filled the form in and met the refusal at save time.
    read_only = not version_is_editable(version)
    read_only_reason = _read_only_reason(version) if read_only else ""
    if request.method == "POST":
        if read_only:
            raise PermissionDenied(read_only_reason)
        action = request.POST.get("action") or ""
        try:
            base_content_hash = request.POST.get("base_content_hash") or ""
            if not base_content_hash:
                raise ValidationError("问卷已更新，请刷新后再操作。")
            before = parse_questionnaire(_current_questionnaire(version, subject=subject))
            questionnaire = _apply_action(before, action, request.POST)
            _require_subject(questionnaire, subject)
            if action in {"move_up", "move_down"} and questionnaire == before:
                direction = "上" if action == "move_up" else "下"
                messages.warning(
                    request, f"这道题不能再向{direction}移动：条件依赖必须保持在前面。"
                )
                return redirect(builder_route, pk=version.pk)
            sections = {QUESTIONNAIRE_ROOT_KEYS[subject]: questionnaire}
            if subject == "group":
                # A pre-split version stored its group document in the participant slot.
                # Saving the group designer is the migration seam: move it out, so the
                # participant slot is no longer a group document.
                legacy = _definition_root(version).get("questionnaire")
                if legacy is not None:
                    try:
                        legacy_is_group = compile_questionnaire(legacy).subject == "group"
                    except ValidationError:
                        legacy_is_group = False
                    if legacy_is_group:
                        sections["questionnaire"] = None
            update_ruleset_definition_sections(
                version,
                sections=sections,
                operator=request.user,
                base_content_hash=base_content_hash,
            )
        except ValidationError as exc:
            messages.error(request, "；".join(getattr(exc, "messages", None) or [str(exc)]))
            return redirect(builder_route, pk=version.pk)
        messages.success(request, f"{ACTION_LABELS.get(action, action)}成功。")
        return redirect(builder_route, pk=version.pk)

    questionnaire = _current_questionnaire(version, subject=subject)
    plan = compile_questionnaire(questionnaire)
    rows = _rows(plan, answers={}, context={}, due_rounds=_bound_rounds(version))
    round_choices = [("", "不限定轮次")]
    round_choices.extend(_round_choices(version, questionnaire))
    return render(
        request,
        "staff_panel/questionnaire_builder.html",
        {
            "version": version,
            "ruleset": version.ruleset,
            "activity": version.ruleset.activity,
            "subject": subject,
            "subject_label": "分组合唱问卷" if subject == "group" else "选手问卷",
            "is_group": subject == "group",
            "builder_url": reverse(builder_route, args=[version.pk]),
            "preview_url_name": preview_route,
            "preview_links": [
                (key, label, reverse(preview_route, args=[version.pk, key]))
                for key, label in PREVIEW_CONTEXTS.items()
            ],
            "participant_builder_url": reverse("staff:ruleset_questionnaire", args=[version.pk]),
            "group_builder_url": reverse("staff:ruleset_group_questionnaire", args=[version.pk]),
            "read_only": read_only,
            "read_only_reason": read_only_reason,
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


def preview_view(
    request: HttpRequest, pk: int, context: str, subject: str = "participant"
):
    """Render the form in one of the four states staff need to see."""
    if subject not in QUESTIONNAIRE_ROOT_KEYS:
        raise PermissionDenied("未知的问卷主体。")
    builder_route = (
        "staff:ruleset_group_questionnaire"
        if subject == "group"
        else "staff:ruleset_questionnaire"
    )
    preview_route = (
        "staff:ruleset_group_questionnaire_preview"
        if subject == "group"
        else "staff:ruleset_questionnaire_preview"
    )
    require_current_staff(request.user)
    if context not in PREVIEW_CONTEXTS:
        raise PermissionDenied("未知的预览语境。")
    version = get_object_or_404(RulesetVersion, pk=pk)
    plan = compile_questionnaire(_current_questionnaire(version, subject=subject))
    activity = version.ruleset.activity
    server_context: dict[str, object] = {"activity.phase": activity.phase}
    if subject == "group":
        server_context.update(
            {
                "group.stage": "chorus",
                "group.order": 1,
                "group.member_count": 3,
            }
        )
    else:
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
            "subject": subject,
            "subject_label": "分组合唱问卷" if subject == "group" else "选手问卷",
            "is_group": subject == "group",
            "builder_url": reverse(builder_route, args=[version.pk]),
            "preview_url_name": preview_route,
            "preview_links": [
                (key, label, reverse(preview_route, args=[version.pk, key]))
                for key, label in PREVIEW_CONTEXTS.items()
            ],
            "participant_builder_url": reverse("staff:ruleset_questionnaire", args=[version.pk]),
            "group_builder_url": reverse("staff:ruleset_group_questionnaire", args=[version.pk]),
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
