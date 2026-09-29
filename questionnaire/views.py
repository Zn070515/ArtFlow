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
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.http import require_POST
from ruleset.services import current_frozen_version
from singer_contest.models import ContestRound, SingerRegistration

from .registration import (
    build_submission_context,
    current_answer_files,
    get_or_create_draft_registration,
    questionnaire_plan,
    save_draft,
    submit_registration,
    writable_question_keys,
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


def _activity_or_404(request: HttpRequest, activity_pk: int) -> Activity:
    """The activity, scoped the way the legacy apply path scoped it.

    A participant reaches a FORMAL activity only; a test activity is reachable by staff,
    who preview it, and by the private rehearsal — which drives the services directly
    rather than through this view. Guessing a primary key must not open a rehearsal, and
    the legacy path already worked this way by filtering the queryset it looked up in.
    """
    activities = Activity.objects.filter(activity_type=CONTEST_TYPE)
    if not _is_staff(request.user):
        activities = activities.filter(data_lifecycle=Activity.DataLifecycle.FORMAL)
    return get_object_or_404(activities, pk=activity_pk)


def _require_participant_writer(request: HttpRequest, activity: Activity) -> None:
    """Writes through the participant route belong to the participant who owns the row.

    Staff may preview the form; a staff account must not be able to create or fill a
    registration of its own through it.
    """
    if _is_staff(request.user):
        raise PermissionDenied("工作人员不能通过选手入口提交资料。")
    _require_participant_page(activity)


def _stale_or_missing_schema_hash(payload: dict, plan) -> JsonResponse | None:
    """The version the page was rendered under is required on every participant write.

    It is the guard that stops a page which cannot see the current questionnaire from
    writing into it, and a client can omit an optional field — so on this boundary it is
    not optional.
    """
    expected = str(payload.get("schema_hash") or "")
    if not expected:
        return JsonResponse({"error": "缺少问卷版本标识，请刷新后重试。"}, status=400)
    if expected != plan.schema_hash:
        return JsonResponse({"error": "问卷已更新，请刷新后重试。"}, status=409)
    return None


def _frozen_plan(activity: Activity):
    version = current_frozen_version(activity)
    if version is None:
        raise PermissionDenied("当前活动没有已确认的赛制。")
    return version, questionnaire_plan(version)


# Phases in which a participant may open their own questionnaire. Reading it stays open
# after registration closes -- a participant who has submitted is entitled to see what they
# submitted, and the supplement flow needs the page to exist. What they may *write* is a
# per-question question, decided by ``writable_question_keys`` and enforced by the services.
PARTICIPANT_PHASES = frozenset(
    {
        Activity.Phase.REGISTRATION_OPEN,
        Activity.Phase.REGISTRATION_CLOSED,
        Activity.Phase.REVIEWING,
    }
)


def _require_participant_page(activity: Activity) -> None:
    if activity.is_locked:
        raise PermissionDenied("活动已锁定，无法打开报名问卷。")
    if activity.phase not in PARTICIPANT_PHASES:
        raise PermissionDenied("当前活动阶段不允许打开报名问卷。")


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
    "editable": False,
}


def _question_rows(
    plan, *, registration, answers, context, due_rounds, files, writable=None
) -> list[dict]:
    """One row per block, in document order.

    Walks the plan's own structure rather than ``plan.questions`` so a NOTICE keeps its
    place among the questions around it. ``writable`` is the set of question keys the
    participant may currently write, or ``None`` for all of them; it feeds the row's
    ``editable`` flag, which is a rendering hint — the services are what enforce it.
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
                        "editable": writable is None or key in writable,
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
    activity = _activity_or_404(request, activity_pk)
    version, plan = _frozen_plan(activity)
    staff = _is_staff(request.user)
    if staff:
        # A preview: an unsaved registration, so opening the page never creates a draft
        # for a staff account that is not actually entering the contest.
        registration = SingerRegistration(activity=activity, user=request.user)
        response = None
    else:
        _require_participant_page(activity)
        registration, response = get_or_create_draft_registration(
            version=version, user=request.user
        )
    writable = (
        None
        if staff
        else writable_question_keys(activity=activity, registration=registration, plan=plan)
    )
    editable = writable is None or bool(writable)

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
        writable=writable,
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
            "submitted": bool(response and response.status == "submitted"),
            "autosave_url": f"/questionnaire/{activity.pk}/autosave/",
            "upload_url_template": f"/questionnaire/{activity.pk}/file/__KEY__/",
            "submit_url": f"/questionnaire/{activity.pk}/submit/",
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
    activity = _activity_or_404(request, activity_pk)
    version, plan = _frozen_plan(activity)
    _require_participant_writer(request, activity)
    payload = _json_body(request)
    if payload is None:
        return JsonResponse({"error": "请求体必须是 JSON 对象。"}, status=400)
    answers = payload.get("answers")
    if not isinstance(answers, dict):
        return JsonResponse({"error": "answers 必须是对象。"}, status=400)
    stale = _stale_or_missing_schema_hash(payload, plan)
    if stale is not None:
        return stale

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


def _has_questionnaire(version) -> bool:
    try:
        root = json.loads(version.definition)
    except (TypeError, ValueError):
        return False
    return isinstance(root, dict) and root.get("questionnaire") is not None


@login_required
def register_entry(request: HttpRequest, activity_pk: int | None = None):
    """The one place every registration link lands.

    Resolves to the questionnaire when the activity's current FROZEN ruleset carries one,
    and to the legacy fixed form when it does not. Both paths are live during the Switch
    step, and a *participant* should never have to know which one an activity uses — least
    of all from a QR code, which has to point at that activity's real entry rather than at
    whichever form happened to be written first.
    """
    if activity_pk is None:
        activities = Activity.objects.filter(
            activity_type=CONTEST_TYPE, phase=Activity.Phase.REGISTRATION_OPEN
        ).order_by("-created_at")
        if not _is_staff(request.user):
            # The public path shows FORMAL activities only; a test activity is reachable
            # by staff and by nobody who merely guessed a primary key.
            activities = activities.filter(data_lifecycle=Activity.DataLifecycle.FORMAL)
        return render(
            request,
            "questionnaire/register.html",
            {
                "activities": [
                    {
                        "activity": activity,
                        "uses_questionnaire": (
                            (version := current_frozen_version(activity)) is not None
                            and _has_questionnaire(version)
                        ),
                    }
                    for activity in activities
                ]
            },
        )
    activity = _activity_or_404(request, activity_pk)
    version = current_frozen_version(activity)
    if version is not None and _has_questionnaire(version):
        return redirect("questionnaire:form", activity_pk=activity.pk)
    return redirect(f"{reverse('singer_contest:apply')}?activity={activity.pk}")


@login_required
@require_POST
def submit_view(request: HttpRequest, activity_pk: int):
    """Finish a registration.

    The page's own schema hash is required here even though the service treats it as
    optional: an HTTP caller always has one, and accepting a submission without it would
    let a page that cannot see the current questionnaire write into it.
    """
    activity = _activity_or_404(request, activity_pk)
    version, plan = _frozen_plan(activity)
    _require_participant_writer(request, activity)
    payload = _json_body(request)
    if payload is None:
        return JsonResponse({"error": "请求体必须是 JSON 对象。"}, status=400)
    answers = payload.get("answers")
    if not isinstance(answers, dict):
        return JsonResponse({"error": "answers 必须是对象。"}, status=400)
    stale = _stale_or_missing_schema_hash(payload, plan)
    if stale is not None:
        return stale
    expected = str(payload["schema_hash"])

    registration, _response = get_or_create_draft_registration(version=version, user=request.user)
    try:
        response = submit_registration(
            version=version,
            registration=registration,
            answers=answers,
            due_rounds=_due_rounds(version),
            expected_schema_hash=expected,
        )
    except ValidationError as exc:
        messages = getattr(exc, "messages", None) or [str(exc)]
        return JsonResponse({"error": "；".join(messages)}, status=409)
    return JsonResponse(
        {
            "status": response.status,
            "submitted_at": response.submitted_at.isoformat() if response.submitted_at else "",
            "completion": _completion(
                version,
                registration,
                answers=response.answers or {},
                due_rounds=_due_rounds(version),
                files=current_answer_files(registration),
            ),
        }
    )


@login_required
@require_POST
def upload_view(request: HttpRequest, activity_pk: int, question_key: str):
    """Store one answer file. The question is the address; the purpose is not an input."""
    from files.services import store_questionnaire_file

    activity = _activity_or_404(request, activity_pk)
    version, plan = _frozen_plan(activity)
    _require_participant_writer(request, activity)
    uploaded = request.FILES.get("file")
    if not uploaded:
        return JsonResponse({"error": "请选择要上传的文件。"}, status=400)
    stale = _stale_or_missing_schema_hash({"schema_hash": request.POST.get("schema_hash")}, plan)
    if stale is not None:
        return stale
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
