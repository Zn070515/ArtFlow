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
from typing import cast

from accounts.models import User as AccountUser
from core.models import Activity
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied, ValidationError
from django.http import HttpRequest, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.http import require_POST
from files.policies import effective_file_policy
from ruleset.services import current_frozen_version
from singer_contest.group_chorus import current_group_members
from singer_contest.models import ContestRound, Group, GroupStage, SingerRegistration

from .registration import (
    build_group_submission_context,
    build_submission_context,
    current_answer_files,
    current_group_answer_files,
    get_or_create_draft_registration,
    get_or_create_group_response,
    questionnaire_plan,
    save_draft,
    save_group_draft,
    submit_group_response,
    submit_registration,
    writable_group_question_keys,
    writable_question_keys,
)
from .runtime import completion_summary, resolve_question_value, resolve_questions
from .schema import NOTICE_TYPE
from .services import QuestionStale, answer_bases

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


def _group_or_404(request: HttpRequest, group_pk: int) -> Group:
    groups = Group.objects.select_related("stage__activity").filter(
        is_active=True,
        stage__status__in=[GroupStage.Status.CONFIRMED, GroupStage.Status.FROZEN],
    )
    if not _is_staff(request.user):
        if not isinstance(request.user, AccountUser):
            return get_object_or_404(groups.none(), pk=group_pk)
        groups = groups.filter(
            stage__activity__data_lifecycle=Activity.DataLifecycle.FORMAL,
            memberships__is_current=True,
            memberships__singer__user=request.user,
        )
    return get_object_or_404(groups.distinct(), pk=group_pk)


def _require_group_page(activity: Activity) -> None:
    """A group member may always *read* their group's material page.

    Only a locked activity closes the page. What may be *written* is the stage's material
    window (``GroupStage.material_status``), enforced by ``writable_group_question_keys``
    and the file services — not by the activity's registration phase. Gating reading on
    the phase too would hide a group's own submitted material from them for the rest of
    the contest, and would tie a group drawn during the live show to a registration
    deadline that closed weeks earlier.
    """
    if activity.is_locked:
        raise PermissionDenied("活动已锁定，无法打开分组合唱材料页。")


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


def _invalid_questionnaire_response() -> JsonResponse:
    """Return a bounded client error without reflecting exception details."""
    return JsonResponse({"error": "问卷内容未通过校验，请检查后重试。"}, status=409)


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


NOTICE_ROW: dict[str, object] = {
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
    "file_version": 0,
    "editable": False,
}


def _question_rows(
    plan, *, activity, registration, answers, context, due_rounds, files, writable=None
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
                file_config = question.get("file")
                if file_config:
                    file_config = dict(file_config)
                    policy = effective_file_policy(file_config["purpose"], activity)
                    file_config.update(
                        {
                            "max_mb": min(
                                int(file_config.get("max_mb") or policy.max_mb), policy.max_mb
                            ),
                            "direct_upload_allowed": policy.direct_upload_allowed,
                        }
                    )
                rows.append(
                    {
                        "key": key,
                        "label": question["label"],
                        "description": question.get("description", ""),
                        "type": question["type"],
                        "options": question.get("options", []),
                        "file": file_config,
                        "round": question.get("round") or "",
                        "visible": resolved.visible,
                        "due": resolved.due,
                        "required": resolved.required,
                        "value": "" if value is None else value,
                        "value_text": value if isinstance(value, str) else "",
                        "checked": value is True,
                        "selected_values": value if isinstance(value, list) else [],
                        "file_name": getattr(value, "original_name", ""),
                        # The version the page is showing, so an upload can say which
                        # current file it is replacing (group material is shared).
                        "file_version": getattr(value, "version", 0),
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
    version = current_frozen_version(activity)
    if version is not None and not _has_questionnaire(version):
        # A stale QR/bookmark for the questionnaire must land on the activity's real
        # legacy entry, not expose an internal "no questionnaire" error page.
        return redirect(f"{reverse('singer_contest:apply')}?activity={activity.pk}")
    version, plan = _frozen_plan(activity)
    staff = _is_staff(request.user)
    if staff:
        # A preview: an unsaved registration, so opening the page never creates a draft
        # for a staff account that is not actually entering the contest.
        registration = SingerRegistration(activity=activity, user=cast(AccountUser, request.user))
        response = None
    else:
        _require_participant_page(activity)
        registration, response = get_or_create_draft_registration(
            version=version, user=cast(AccountUser, request.user)
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
        activity=activity,
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
            "answer_bases": answer_bases(answers),
        },
    )


@login_required
def group_form_view(request: HttpRequest, group_pk: int):
    group = _group_or_404(request, group_pk)
    activity = group.stage.activity
    if not _is_staff(request.user):
        _require_group_page(activity)
    version, plan = _frozen_plan(activity)
    if plan.subject != "group":
        raise PermissionDenied("当前赛制没有启用分组合唱组问卷。")
    staff = _is_staff(request.user)
    response = (
        get_or_create_group_response(
            group=group, ruleset_version=version, questionnaire_key=plan.key
        )
        if not staff
        else None
    )
    writable = None if staff else writable_group_question_keys(group=group, plan=plan)
    answers = (response.answers if response else {}) or {}
    files = current_group_answer_files(group)
    due_rounds = _due_rounds(version)
    context = build_group_submission_context(version=version, group=group)
    rows = _question_rows(
        plan,
        activity=activity,
        registration=None,
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
            "editable": writable is None or bool(writable),
            "preview": staff,
            "schema_hash": plan.schema_hash,
            "completion": completion_summary(
                plan,
                registration=None,
                answers=answers,
                context=context,
                due_rounds=due_rounds,
                files=files,
            ),
            "form_url": request.path,
            "submitted": bool(response and response.status == "submitted"),
            "autosave_url": f"/questionnaire/group/{group.pk}/autosave/",
            "upload_url_template": f"/questionnaire/group/{group.pk}/file/__KEY__/",
            "submit_url": f"/questionnaire/group/{group.pk}/submit/",
            "answer_bases": answer_bases(answers),
            "group": group,
            "current_members": current_group_members(group),
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
    except ValidationError:
        return _invalid_questionnaire_response()
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
    except ValidationError:
        return _invalid_questionnaire_response()
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
    except ValidationError:
        return _invalid_questionnaire_response()
    return JsonResponse(
        {
            "question_key": stored.question_key,
            "file_name": stored.original_name,
        }
    )


@login_required
@require_POST
def group_autosave_view(request: HttpRequest, group_pk: int):
    group = _group_or_404(request, group_pk)
    if _is_staff(request.user):
        raise PermissionDenied("工作人员不能通过选手入口修改分组合唱资料。")
    _require_group_page(group.stage.activity)
    version, plan = _frozen_plan(group.stage.activity)
    if plan.subject != "group":
        raise PermissionDenied("当前赛制没有启用分组合唱组问卷。")
    payload = _json_body(request)
    changes = payload.get("changes") if payload else None
    if payload is None or (changes is None and not isinstance(payload.get("answers"), dict)):
        return JsonResponse({"error": "请求体必须包含 answers 或 changes。"}, status=400)
    stale = _stale_or_missing_schema_hash(payload, plan)
    if stale is not None:
        return stale
    try:
        saved = save_group_draft(
            version=version,
            group=group,
            actor=request.user,
            answers=payload.get("answers"),
            changes=changes,
            schema_hash=str(payload.get("schema_hash") or ""),
        )
    except QuestionStale as conflict:
        # One member's text, not a corrupted form: the client shows the difference and the
        # author decides, instead of the later writer silently winning.
        return JsonResponse(
            {
                "error": "部分题目已被其他成员修改。",
                "code": "QUESTION_STALE",
                "conflicts": conflict.conflicts,
            },
            status=409,
        )
    except ValidationError:
        return _invalid_questionnaire_response()
    return JsonResponse(
        {
            "completion": completion_summary(
                plan,
                registration=None,
                answers=saved.answers or {},
                context=build_group_submission_context(version=version, group=group),
                due_rounds=_due_rounds(version),
                files=current_group_answer_files(group),
            ),
            "schema_hash": saved.schema_hash,
            # The bases to edit against next, so a second save does not report a conflict
            # against a value the page has never seen.
            "answer_bases": answer_bases(saved.answers or {}),
        }
    )


@login_required
@require_POST
def group_submit_view(request: HttpRequest, group_pk: int):
    group = _group_or_404(request, group_pk)
    if _is_staff(request.user):
        raise PermissionDenied("工作人员不能通过选手入口提交分组合唱资料。")
    _require_group_page(group.stage.activity)
    version, plan = _frozen_plan(group.stage.activity)
    if plan.subject != "group":
        raise PermissionDenied("当前赛制没有启用分组合唱组问卷。")
    payload = _json_body(request)
    if payload is None or not isinstance(payload.get("answers"), dict):
        return JsonResponse({"error": "请求体必须包含 answers 对象。"}, status=400)
    # A submission carries the whole form, and a group shares one response between its
    # members, so the whole-form branch is exactly where a page opened before a teammate's
    # edit could put its older text back. The bases are the same evidence the autosave path
    # already uses; requiring them here means an old page is told to refresh instead of
    # silently winning.
    bases = payload.get("bases")
    if not isinstance(bases, dict):
        return JsonResponse({"error": "缺少表单基准版本，请刷新页面后重试。"}, status=400)
    stale = _stale_or_missing_schema_hash(payload, plan)
    if stale is not None:
        return stale
    try:
        response = submit_group_response(
            version=version,
            group=group,
            answers=payload["answers"],
            actor=request.user,
            due_rounds=_due_rounds(version),
            expected_schema_hash=str(payload["schema_hash"]),
            bases={str(key): str(value) for key, value in bases.items()},
        )
    except QuestionStale as conflict:
        return JsonResponse(
            {
                "error": "部分题目已被其他成员修改。",
                "code": "QUESTION_STALE",
                "conflicts": conflict.conflicts,
            },
            status=409,
        )
    except ValidationError:
        return _invalid_questionnaire_response()
    return JsonResponse(
        {
            "status": response.status,
            "submitted_at": response.submitted_at.isoformat() if response.submitted_at else "",
            "completion": completion_summary(
                plan,
                registration=None,
                answers=response.answers or {},
                context=build_group_submission_context(version=version, group=group),
                due_rounds=_due_rounds(version),
                files=current_group_answer_files(group),
            ),
        }
    )


@login_required
@require_POST
def group_upload_view(request: HttpRequest, group_pk: int, question_key: str):
    from files.services import FileSlotStale, store_questionnaire_group_file

    group = _group_or_404(request, group_pk)
    if _is_staff(request.user):
        raise PermissionDenied("工作人员不能通过选手入口上传分组合唱材料。")
    _require_group_page(group.stage.activity)
    uploaded = request.FILES.get("file")
    if not uploaded:
        return JsonResponse({"error": "请选择要上传的文件。"}, status=400)
    version, plan = _frozen_plan(group.stage.activity)
    stale = _stale_or_missing_schema_hash({"schema_hash": request.POST.get("schema_hash")}, plan)
    if stale is not None:
        return stale
    expected_raw = str(request.POST.get("expected_current_version") or "").strip()
    if not expected_raw.isdigit():
        # The page has always rendered the slot's version (`data-file-version`, absent for
        # an as-yet-empty slot, which the client sends as 0). Treating a missing value as
        # "this client does not do the check" made the upload the one group-material write
        # that could replace a teammate's file with no evidence and no conflict — silently,
        # which is the whole failure the version check exists to prevent.
        return JsonResponse({"error": "缺少材料版本标识，请刷新页面后重试。"}, status=400)
    try:
        stored = store_questionnaire_group_file(
            group=group,
            question_key=question_key,
            uploaded_file=uploaded,
            actor=request.user,
            expected_schema_hash=str(request.POST.get("schema_hash") or ""),
            expected_current_version=int(expected_raw),
        )
    except FileSlotStale as conflict:
        # A distinct code, because the client's next move is a choice rather than a
        # refresh: keep the teammate's upload, or replace it deliberately.
        return JsonResponse(
            {
                "error": "该材料槽位已被其他成员更新。",
                "code": "FILE_SLOT_STALE",
                "current_version": conflict.current_version,
                "current_name": conflict.current_name,
            },
            status=409,
        )
    except ValidationError:
        return _invalid_questionnaire_response()
    return JsonResponse(
        {
            "question_key": stored.question_key,
            "file_name": stored.original_name,
            "version": stored.version,
        }
    )
