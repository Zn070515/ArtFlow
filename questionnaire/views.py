"""P4 — the participant questionnaire page, its autosave, and its file uploads.

The page is a *container*: the questions, their order, their conditions, their options and
their file limits all come from the frozen plan, so no template names a field. A template
that did would be a second source of truth, and it would drift the first time a question
was added.

Autosave goes through the same services the submit path uses, so there is one write path
and one set of rules rather than two that agree today.

Authority: a participant may open and fill the form only while registration is open; staff
may open it in any phase, read-only, to see what a participant would see. Nothing here is
the authorization boundary for the *content* — the services decide that.
"""

from __future__ import annotations

import json

from accounts.models import User as AccountUser
from core.models import Activity
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied, ValidationError
from django.http import HttpRequest, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.http import require_POST
from ruleset.services import current_frozen_version
from singer_contest.models import ContestRound, SingerRegistration

from .registration import (
    build_submission_context,
    current_answer_files,
    get_or_create_draft_registration,
    questionnaire_plan,
    save_draft,
)
from .runtime import completion_summary, resolve_question_value, resolve_questions
from .schema import NOTICE_TYPE

CONTEST_TYPE = Activity.Type.SINGER_CONTEST


def _is_staff(user) -> bool:
    """Whether the request's account is staff or admin.

    request.user is typed as the abstract user or AnonymousUser, so the project's
    own role helpers are only visible behind an isinstance on the concrete model.
    """
    return isinstance(user, AccountUser) and user.is_staff_or_admin


def _activity_or_404(activity_pk: int) -> Activity:
    return get_object_or_404(Activity, pk=activity_pk, activity_type=CONTEST_TYPE)


def _frozen_plan(activity: Activity):
    version = current_frozen_version(activity)
    if version is None:
        raise PermissionDenied("当前活动没有已确认的赛制。")
    return version, questionnaire_plan(version)


def _require_participant_editable(activity: Activity) -> None:
    if activity.is_locked:
        raise PermissionDenied("活动已锁定，无法填写报名问卷。")
    if activity.phase != Activity.Phase.REGISTRATION_OPEN:
        raise PermissionDenied("当前活动阶段不允许填写报名问卷。")


def _due_rounds(version) -> frozenset[str]:
    """Rounds whose material is owed now.

    A ``before_round`` question is shown from the start but not owed until its round is
    actually under way — a round still in DRAFT has not started, so its material is shown
    early rather than marked missing.
    """
    round_keys = (version.binding or {}).get("round_keys") or {}
    if not round_keys:
        return frozenset()
    started = set(
        ContestRound.objects.filter(
            activity=version.ruleset.activity, pk__in=list(round_keys.values())
        )
        .exclude(status=ContestRound.Status.DRAFT)
        .values_list("pk", flat=True)
    )
    return frozenset(key for key, pk in round_keys.items() if pk in started)


NOTICE_ROW = {
    "options": [],
    "file": None,
    "round": "",
    "visible": True,
    "due": True,
    "required": False,
    "value": "",
    "value_text": "",
    "checked": False,
    "file_name": "",
}


def _question_rows(plan, *, registration, answers, context, due_rounds, files) -> list[dict]:
    """One row per block, in document order.

    Walks the plan's own structure rather than ``plan.questions`` so a NOTICE keeps its
    place among the questions around it.
    """
    resolved_by_key = {
        resolved.question["key"]: resolved
        for resolved in resolve_questions(
            plan, answers=answers, context=context, due_rounds=due_rounds
        )
    }
    rows = []
    for page in plan.pages:
        for section in page["sections"]:
            for block in section["questions"]:
                key = block["key"]
                if block["type"] == NOTICE_TYPE:
                    rows.append(
                        {
                            **NOTICE_ROW,
                            "key": key,
                            "label": block["label"],
                            "description": block.get("description", ""),
                            "type": NOTICE_TYPE,
                        }
                    )
                    continue
                resolved = resolved_by_key[key]
                question = resolved.question
                value = resolve_question_value(
                    question, answers=answers, registration=registration, files=files
                )
                rows.append(
                    {
                        "key": key,
                        "label": question["label"],
                        "description": question.get("description", ""),
                        "type": question["type"],
                        "options": question.get("options", []),
                        "file": question.get("file"),
                        "round": question.get("round") or "",
                        "visible": resolved.visible,
                        "due": resolved.due,
                        "required": resolved.required,
                        "value": "" if value is None else value,
                        "value_text": value if isinstance(value, str) else "",
                        "checked": value is True,
                        "file_name": getattr(value, "original_name", ""),
                    }
                )
    return rows


def _page_model(plan, rows) -> list[dict]:
    """The plan's structure with its questions resolved, for the template to walk."""
    by_key = {row["key"]: row for row in rows}
    pages = []
    for page in plan.pages:
        sections = []
        for section in page["sections"]:
            questions = [by_key[q["key"]] for q in section["questions"] if q["key"] in by_key]
            if questions:
                sections.append({**section, "questions": questions})
        if sections:
            pages.append({**page, "sections": sections})
    return pages


def _completion(version, registration, *, answers, due_rounds, files) -> dict:
    plan = questionnaire_plan(version)
    return completion_summary(
        plan,
        registration=registration,
        answers=answers,
        context=build_submission_context(version=version, registration=registration),
        due_rounds=due_rounds,
        files=files,
    )


@login_required
def form_view(request: HttpRequest, activity_pk: int):
    activity = _activity_or_404(activity_pk)
    version, plan = _frozen_plan(activity)
    staff = _is_staff(request.user)
    editable = False
    if staff:
        # A preview: an unsaved registration, so opening the page never creates a draft
        # for a staff account that is not actually entering the contest.
        registration = SingerRegistration(activity=activity, user=request.user)
        response = None
    else:
        _require_participant_editable(activity)
        registration, response = get_or_create_draft_registration(
            version=version, user=request.user
        )
        editable = activity.phase == Activity.Phase.REGISTRATION_OPEN

    answers = (response.answers if response else {}) or {}
    # A staff preview holds an unsaved registration, which has no files to look up.
    files = current_answer_files(registration) if registration.pk else {}
    due_rounds = _due_rounds(version)
    context = (
        build_submission_context(version=version, registration=registration)
        if registration.pk
        else {"activity.phase": activity.phase}
    )
    rows = _question_rows(
        plan,
        registration=registration,
        answers=answers,
        context=context,
        due_rounds=due_rounds,
        files=files,
    )
    return render(
        request,
        "questionnaire/form.html",
        {
            "activity": activity,
            "version": version,
            "plan": plan,
            "pages": _page_model(plan, rows),
            "editable": editable,
            "preview": staff,
            "schema_hash": plan.schema_hash,
            "completion": completion_summary(
                plan,
                registration=registration,
                answers=answers,
                context=context,
                due_rounds=due_rounds,
                files=files,
            ),
            "form_url": request.path,
            "autosave_url": f"/questionnaire/{activity.pk}/autosave/",
            "upload_url_template": f"/questionnaire/{activity.pk}/file/__KEY__/",
        },
    )


def _json_body(request: HttpRequest) -> dict | None:
    try:
        payload = json.loads(request.body or b"{}")
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


@login_required
@require_POST
def autosave_view(request: HttpRequest, activity_pk: int):
    activity = _activity_or_404(activity_pk)
    version, _plan = _frozen_plan(activity)
    if not _is_staff(request.user):
        _require_participant_editable(activity)
    payload = _json_body(request)
    if payload is None:
        return JsonResponse({"error": "请求体必须是 JSON 对象。"}, status=400)
    answers = payload.get("answers")
    if not isinstance(answers, dict):
        return JsonResponse({"error": "answers 必须是对象。"}, status=400)

    registration, _response = get_or_create_draft_registration(version=version, user=request.user)
    try:
        saved = save_draft(
            version=version,
            registration=registration,
            answers=answers,
            schema_hash=str(payload.get("schema_hash") or ""),
        )
    except ValidationError as exc:
        # A stale form and a submitted one are both "this page is out of date", which is
        # what the client acts on; the message says which.
        messages = getattr(exc, "messages", None) or [str(exc)]
        return JsonResponse({"error": "；".join(messages)}, status=409)
    files = current_answer_files(registration)
    return JsonResponse(
        {
            "completion": _completion(
                version,
                registration,
                answers=saved.answers or {},
                due_rounds=_due_rounds(version),
                files=files,
            ),
            "schema_hash": saved.schema_hash,
        }
    )


@login_required
@require_POST
def upload_view(request: HttpRequest, activity_pk: int, question_key: str):
    """Store one answer file. The question is the address; the purpose is not an input."""
    from files.services import store_questionnaire_file

    activity = _activity_or_404(activity_pk)
    version, _plan = _frozen_plan(activity)
    if not _is_staff(request.user):
        _require_participant_editable(activity)
    uploaded = request.FILES.get("file")
    if not uploaded:
        return JsonResponse({"error": "请选择要上传的文件。"}, status=400)
    registration, _response = get_or_create_draft_registration(version=version, user=request.user)
    try:
        stored = store_questionnaire_file(
            registration=registration,
            question_key=question_key,
            uploaded_file=uploaded,
            actor=request.user,
            expected_schema_hash=str(request.POST.get("schema_hash") or ""),
        )
    except ValidationError as exc:
        messages = getattr(exc, "messages", None) or [str(exc)]
        return JsonResponse({"error": "；".join(messages)}, status=409)
    return JsonResponse(
        {
            "question_key": stored.question_key,
            "file_name": stored.original_name,
        }
    )
