import io

from accounts.decorators import admin_required, staff_required
from accounts.models import User
from accounts.services import change_user_role, set_user_active
from common.audit import audit_export, log_action
from common.business_rules import (
    ensure_activity_unlocked,
    ensure_lifecycle_consistent,
    ensure_round_unlocked,
    ensure_same_activity,
)
from common.lifecycle import runtime_is_test, scope_lifecycle, scope_runtime
from common.models import AuditLog
from common.test_data import (
    clear_activity_test_data,
    leave_test_mode,
    lock_activity_for_runtime_data,
)
from core.models import Activity
from core.policies import ActivityAction, ensure_activity_action_allowed
from core.services import transition_activity_phase, unarchive_activity
from django.contrib import messages
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import Count
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_POST
from exports.models import ArticleTemplate, GeneratedDocument
from exports.services import (
    archive_activity,
    build_archive_package,
    build_execution_package,
    build_package_zip,
    build_score_template_workbook,
)
from farewell_show.models import Program
from files.models import MaterialCheck, MaterialRequirement, StaffNote, SubmissionFile
from files.services import (
    review_material_check,
    store_submission_file,
    sync_program_material_checks,
    sync_singer_material_checks,
)
from incidents.models import IncidentRecord
from openpyxl import Workbook
from openpyxl.worksheet.worksheet import Worksheet
from public_portal.models import PublicPost
from singer_contest.models import (
    Award,
    ContestRound,
    Judge,
    ScoreRecord,
    ScoreSummary,
    SingerRegistration,
)
from singer_contest.services import (
    _active_judges,
    _eligible_singers,
    apply_scores,
    finalize_advancement,
    lock_round,
    missing_score_cells,
    parse_score_workbook,
    prepare_round,
    reset_round_to_draft,
    unlock_round,
)
from voting.models import VoteOption, VoteRecord, VoteSession
from voting.services import (
    close_vote_session,
    lock_vote_session,
    open_vote_session,
    unlock_vote_session,
)

from staff_panel.forms import (
    CREATE_PHASE_CHOICES,
    ActivityForm,
    ContestRoundForm,
    IncidentForm,
    ProgramReviewForm,
    PublicPostForm,
    SingerReviewForm,
    VoteSessionForm,
)


def _choices(enum_class):
    return enum_class.choices


def _form_error(form):
    for field_errors in form.errors.values():
        if field_errors:
            return field_errors[0]
    return "提交的数据无效。"


def _require_admin(user):
    if not user.is_admin:
        raise PermissionDenied("Only admins can manage this resource.")


def _ensure_activity_mutable(activity):
    if activity.phase == Activity.Phase.ARCHIVED:
        raise PermissionDenied("活动已归档，为只读状态。")
    ensure_activity_unlocked(activity)


def _active_worksheet(workbook):
    worksheet = workbook.active
    if not isinstance(worksheet, Worksheet):
        raise ValueError("The active workbook sheet must be a worksheet.")
    return worksheet


@staff_required
def dashboard(request):
    return render(request, "staff_panel/dashboard.html")


@staff_required
def activity_list(request):
    activities = Activity.objects.all()
    return render(request, "staff_panel/activity_list.html", {"activities": activities})


@admin_required
def activity_create(request):
    _require_admin(request.user)
    if request.method == "POST":
        form = ActivityForm(
            request.POST, include_lifecycle=True, phase_choices=CREATE_PHASE_CHOICES
        )
        if not form.is_valid():
            return render(
                request,
                "staff_panel/activity_form.html",
                {
                    "error": _form_error(form),
                    "activity_types": _choices(Activity.Type),
                    "phases": CREATE_PHASE_CHOICES,
                    "data": request.POST,
                },
            )
        # A new activity always starts as a draft; the selected phase on the
        # create form is never trusted to start the activity mid-lifecycle.
        form.cleaned_data["phase"] = Activity.Phase.DRAFT
        activity = Activity.objects.create(**form.cleaned_data)
        if request.FILES.get("cover_image"):
            activity.cover_image = request.FILES["cover_image"]
            activity.save(update_fields=["cover_image"])
        AuditLog.objects.create(
            operator=request.user,
            action_type=AuditLog.ActionType.OTHER,
            target=f"创建活动: {activity.title}",
        )
        return redirect("staff:activity_list")
    return render(
        request,
        "staff_panel/activity_form.html",
        {
            "activity_types": _choices(Activity.Type),
            "phases": CREATE_PHASE_CHOICES,
        },
    )


@admin_required
@transaction.atomic
def activity_edit(request, pk):
    _require_admin(request.user)
    activity = get_object_or_404(Activity, pk=pk)
    if request.method == "POST":
        _ensure_activity_mutable(activity)
        form = ActivityForm(request.POST)
        if not form.is_valid():
            return render(
                request,
                "staff_panel/activity_form.html",
                {
                    "error": _form_error(form),
                    "activity": activity,
                    "activity_types": _choices(Activity.Type),
                    "phases": _choices(Activity.Phase),
                    "data": request.POST,
                },
            )
        data = dict(form.cleaned_data)
        target_phase = data.pop("phase")
        if target_phase != activity.phase:
            activity = transition_activity_phase(activity, target_phase, actor=request.user)
        for key, value in data.items():
            setattr(activity, key, value)
        if request.FILES.get("cover_image"):
            activity.cover_image = request.FILES["cover_image"]
        activity.save()
        AuditLog.objects.create(
            operator=request.user,
            action_type=AuditLog.ActionType.OTHER,
            target=f"更新活动: {activity.title}",
        )
        return redirect("staff:activity_list")
    return render(
        request,
        "staff_panel/activity_form.html",
        {
            "activity": activity,
            "activity_types": _choices(Activity.Type),
            "phases": _choices(Activity.Phase),
        },
    )


@staff_required
def post_list(request):
    posts = PublicPost.objects.all()
    return render(request, "staff_panel/post_list.html", {"posts": posts})


@staff_required
def post_create(request):
    if request.method == "POST":
        form = PublicPostForm(request.POST)
        if not form.is_valid():
            return render(
                request,
                "staff_panel/post_form.html",
                {
                    "error": _form_error(form),
                    "post_types": _choices(PublicPost.PostType),
                    "statuses": _choices(PublicPost.Status),
                    "activities": Activity.objects.all(),
                },
            )
        data = form.cleaned_data
        related_activity = None
        if data["related_activity_id"]:
            related_activity = get_object_or_404(Activity, pk=data["related_activity_id"])
            ensure_activity_unlocked(related_activity)
        post = PublicPost(
            title=data["title"],
            subtitle=data["subtitle"],
            content=data["content"],
            post_type=data["post_type"],
            status=data["status"],
            sort_order=data["sort_order"],
            is_pinned=data["is_pinned"],
            related_activity_id=data["related_activity_id"],
            created_by=request.user,
            updated_by=request.user,
        )
        if request.FILES.get("cover_image"):
            post.cover_image = request.FILES["cover_image"]
        if data["status"] == PublicPost.Status.PUBLISHED:
            post.published_at = timezone.now()
        post.save()
        log_action(
            request,
            AuditLog.ActionType.PUBLISH_POST,
            f"PublicPost:{post.pk}",
            new_value=f"status={post.status}",
        )
        return redirect("staff:post_list")
    return render(
        request,
        "staff_panel/post_form.html",
        {
            "post_types": _choices(PublicPost.PostType),
            "statuses": _choices(PublicPost.Status),
            "activities": Activity.objects.all(),
        },
    )


@staff_required
def post_edit(request, pk):
    post = get_object_or_404(PublicPost, pk=pk)
    if request.method == "POST":
        form = PublicPostForm(request.POST)
        if not form.is_valid():
            return render(
                request,
                "staff_panel/post_form.html",
                {
                    "error": _form_error(form),
                    "post": post,
                    "post_types": _choices(PublicPost.PostType),
                    "statuses": _choices(PublicPost.Status),
                    "activities": Activity.objects.all(),
                },
            )
        data = form.cleaned_data
        old_value = f"status={post.status}; title={post.title}"
        old_activity = post.related_activity
        new_activity = None
        if data["related_activity_id"]:
            new_activity = get_object_or_404(Activity, pk=data["related_activity_id"])
        # A move from a locked activity to an unlocked one must still be blocked;
        # checking only the new activity would let staff bypass the old lock.
        for activity in (old_activity, new_activity):
            if activity is not None:
                ensure_activity_unlocked(activity)
        post.title = data["title"]
        post.subtitle = data["subtitle"]
        post.content = data["content"]
        post.post_type = data["post_type"]
        old_status = post.status
        post.status = data["status"]
        post.sort_order = data["sort_order"]
        post.is_pinned = data["is_pinned"]
        post.related_activity_id = data["related_activity_id"]
        post.updated_by = request.user
        if request.FILES.get("cover_image"):
            post.cover_image = request.FILES["cover_image"]
        if data["status"] == PublicPost.Status.PUBLISHED and not post.published_at:
            post.published_at = timezone.now()
        elif (
            data["status"] != PublicPost.Status.PUBLISHED
            and old_status == PublicPost.Status.PUBLISHED
        ):
            post.published_at = None
        post.save()
        log_action(
            request,
            AuditLog.ActionType.PUBLISH_POST,
            f"PublicPost:{post.pk}",
            old_value=old_value,
            new_value=f"status={post.status}; title={post.title}",
        )
        return redirect("staff:post_list")

    return render(
        request,
        "staff_panel/post_form.html",
        {
            "post": post,
            "post_types": _choices(PublicPost.PostType),
            "statuses": _choices(PublicPost.Status),
            "activities": Activity.objects.all(),
        },
    )


# --- Singer registration management ---


@staff_required
def singer_registration_list(request):
    registrations = SingerRegistration.objects.select_related("activity", "user")
    activity_id = request.GET.get("activity_id")
    if activity_id:
        registrations = registrations.filter(activity_id=activity_id)
    return render(
        request,
        "staff_panel/singer_registration_list.html",
        {
            "registrations": registrations,
            "activities": Activity.objects.all(),
            "selected_activity_id": activity_id,
        },
    )


@staff_required
def singer_registration_detail(request, pk):
    reg = get_object_or_404(SingerRegistration.objects.select_related("activity", "user"), pk=pk)
    errors = []
    if request.method == "POST":
        ensure_activity_unlocked(reg.activity)
        if "upload_file" in request.POST:
            ensure_activity_action_allowed(reg.activity, ActivityAction.UPLOAD_MATERIAL)
            f = request.FILES.get("file")
            if f:
                try:
                    submission_file = store_submission_file(
                        owner=reg,
                        uploaded_file=f,
                        purpose=request.POST.get("file_purpose", SubmissionFile.Purpose.OTHER),
                        uploaded_by=request.user,
                    )
                except ValidationError as error:
                    errors.extend(error.messages)
                else:
                    sync_singer_material_checks(reg)
                    log_action(
                        request,
                        AuditLog.ActionType.UPLOAD_FILE,
                        f"SubmissionFile:{submission_file.pk}",
                        new_value=submission_file.original_name,
                    )
        else:
            ensure_activity_action_allowed(reg.activity, ActivityAction.REVIEW_REGISTRATION)
            form = SingerReviewForm(request.POST)
            if not form.is_valid():
                errors = [_form_error(form)]
            else:
                old_value = f"pre={reg.pre_status}; live={reg.live_status}"
                reg.pre_status = form.cleaned_data["pre_status"]
                reg.live_status = form.cleaned_data["live_status"]
                note = form.cleaned_data.get("staff_note", "").strip()
                if note:
                    StaffNote.objects.create(
                        singer_registration=reg,
                        content=note,
                        created_by=request.user,
                    )
                reg.save()
                log_action(
                    request,
                    AuditLog.ActionType.UPDATE_STATUS,
                    f"SingerRegistration:{reg.pk}",
                    old_value=old_value,
                    new_value=f"pre={reg.pre_status}; live={reg.live_status}",
                )
                return redirect("staff:singer_registration_detail", pk=reg.pk)
    notes = reg.staff_notes.select_related("created_by")
    files = reg.files.all()
    checks = reg.material_checks.all()
    return render(
        request,
        "staff_panel/singer_registration_detail.html",
        {
            "reg": reg,
            "pre_statuses": _choices(SingerRegistration.PreStatus),
            "live_statuses": _choices(SingerRegistration.LiveStatus),
            "notes": notes,
            "files": files,
            "checks": checks,
            "check_statuses": _choices(MaterialCheck.Status),
            "file_purposes": _choices(SubmissionFile.Purpose),
            "errors": errors,
        },
    )


# --- Program management ---


@staff_required
def program_list(request):
    programs = Program.objects.select_related("activity", "user")
    activity_id = request.GET.get("activity_id")
    if activity_id:
        programs = programs.filter(activity_id=activity_id)
    return render(
        request,
        "staff_panel/program_list.html",
        {
            "programs": programs,
            "activities": Activity.objects.all(),
            "selected_activity_id": activity_id,
        },
    )


@staff_required
def program_detail(request, pk):
    prog = get_object_or_404(Program.objects.select_related("activity", "user"), pk=pk)
    errors = []
    if request.method == "POST":
        ensure_activity_unlocked(prog.activity)
        if "upload_file" in request.POST:
            ensure_activity_action_allowed(prog.activity, ActivityAction.UPLOAD_MATERIAL)
            f = request.FILES.get("file")
            if f:
                try:
                    submission_file = store_submission_file(
                        owner=prog,
                        uploaded_file=f,
                        purpose=request.POST.get("file_purpose", SubmissionFile.Purpose.OTHER),
                        uploaded_by=request.user,
                    )
                except ValidationError as error:
                    errors.extend(error.messages)
                else:
                    sync_program_material_checks(prog)
                    log_action(
                        request,
                        AuditLog.ActionType.UPLOAD_FILE,
                        f"SubmissionFile:{submission_file.pk}",
                        new_value=submission_file.original_name,
                    )
        else:
            ensure_activity_action_allowed(prog.activity, ActivityAction.REVIEW_REGISTRATION)
            form = ProgramReviewForm(request.POST)
            if not form.is_valid():
                errors = [_form_error(form)]
            else:
                old_value = f"status={prog.status}; sort_order={prog.sort_order}"
                prog.status = form.cleaned_data["status"]
                prog.sort_order = form.cleaned_data["sort_order"]
                note = form.cleaned_data.get("staff_note", "").strip()
                if note:
                    StaffNote.objects.create(
                        program=prog,
                        content=note,
                        created_by=request.user,
                    )
                prog.save()
                log_action(
                    request,
                    AuditLog.ActionType.REVIEW_MATERIAL,
                    f"Program:{prog.pk}",
                    old_value=old_value,
                    new_value=f"status={prog.status}; sort_order={prog.sort_order}",
                )
                return redirect("staff:program_detail", pk=prog.pk)
    notes = prog.staff_notes.select_related("created_by")
    files = prog.files.all()
    checks = prog.material_checks.all()
    return render(
        request,
        "staff_panel/program_detail.html",
        {
            "prog": prog,
            "statuses": _choices(Program.Status),
            "program_types": _choices(Program.ProgramType),
            "notes": notes,
            "files": files,
            "checks": checks,
            "check_statuses": _choices(MaterialCheck.Status),
            "file_purposes": _choices(SubmissionFile.Purpose),
            "errors": errors,
        },
    )


@staff_required
@require_POST
def material_check_review(request):
    check = get_object_or_404(MaterialCheck, pk=request.POST.get("check_id"))
    owner = check.singer_registration or check.program
    if owner is None:
        messages.error(request, "材料检查项未关联有效报名，无法审核。")
        return redirect("staff:export_center")
    ensure_activity_unlocked(owner.activity)
    ensure_activity_action_allowed(owner.activity, ActivityAction.REVIEW_REGISTRATION)
    result = request.POST.get("result")
    if result == "approve":
        status = MaterialCheck.Status.APPROVED
    elif result == "supplement":
        status = MaterialCheck.Status.NEEDS_SUPPLEMENT
    else:
        messages.error(request, "无效的审核操作。")
        return _material_review_redirect(owner)
    review_material_check(
        check,
        status=status,
        note=request.POST.get("note", ""),
        actor=request.user,
    )
    messages.success(request, f"「{check.item_name}」已审核。")
    return _material_review_redirect(owner)


def _material_review_redirect(owner):
    target = (
        "staff:singer_registration_detail"
        if getattr(owner, "student_id", None)
        else "staff:program_detail"
    )
    return redirect(target, pk=owner.pk)


@staff_required
def activity_material_requirements(request, activity_id):
    activity = get_object_or_404(Activity, pk=activity_id)
    if request.method == "POST":
        _ensure_activity_mutable(activity)
        applies_to = request.POST.get("applies_to")
        item_name = request.POST.get("item_name", "").strip()
        if not item_name:
            messages.error(request, "检查项名称不能为空。")
        elif applies_to not in MaterialRequirement.AppliesTo.values:
            messages.error(request, "无效的适用范围。")
        else:
            MaterialRequirement.objects.update_or_create(
                activity=activity,
                applies_to=applies_to,
                item_name=item_name,
                defaults={
                    "file_purpose": request.POST.get("file_purpose", "") or "",
                    "is_required": True,
                    "sort_order": request.POST.get("sort_order", 0),
                },
            )
            messages.success(request, "材料检查项已保存。")
        return redirect("staff:activity_material_requirements", activity_id=activity.pk)
    requirements = MaterialRequirement.objects.filter(activity=activity)
    return render(
        request,
        "staff_panel/material_requirements.html",
        {
            "activity": activity,
            "requirements": requirements,
            "applies_to_choices": _choices(MaterialRequirement.AppliesTo),
            "file_purposes": _choices(SubmissionFile.Purpose),
        },
    )


@staff_required
@require_POST
def activity_material_requirement_delete(request, activity_id, pk):
    activity = get_object_or_404(Activity, pk=activity_id)
    _ensure_activity_mutable(activity)
    MaterialRequirement.objects.filter(pk=pk, activity=activity).delete()
    messages.success(request, "材料检查项已删除。")
    return redirect("staff:activity_material_requirements", activity_id=activity.pk)


# --- Excel export ---


def _export_activity(request):
    """Resolve the ?activity_id= scope, or None for a cross-activity export.

    A staff user must pick an activity; only an admin may export across all
    activities (enforced by the caller). Returns the Activity or None.
    """
    activity_id = request.GET.get("activity_id")
    if not activity_id:
        return None
    return get_object_or_404(Activity, pk=activity_id)


@staff_required
def export_registrations(request):
    activity = _export_activity(request)
    if activity is None and not request.user.is_admin:
        raise PermissionDenied("全量导出仅管理员可用；请先用活动筛选导出单个活动。")
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "报名名单"
    ws.append(
        [
            "姓名",
            "学号",
            "学院",
            "班级",
            "手机",
            "微信",
            "曲目",
            "原创",
            "赛前状态",
            "赛中状态",
            "活动",
            "提交时间",
        ]
    )
    if activity is not None:
        rows = scope_runtime(
            SingerRegistration.objects.select_related("activity").filter(activity=activity),
            activity,
        )
    else:
        rows = SingerRegistration.objects.select_related("activity").filter(is_test_data=False)
    row_count = 0
    for r in rows:
        ws.append(
            [
                r.name,
                r.student_id,
                r.college,
                r.class_name,
                r.phone,
                r.wechat,
                r.song_name,
                "是" if r.is_original else "否",
                r.get_pre_status_display(),
                r.get_live_status_display(),
                r.activity.title,
                r.created_at.strftime("%Y-%m-%d %H:%M"),
            ]
        )
        row_count += 1
    audit_export(request, activity, "registration_list", row_count=row_count)
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = "attachment; filename=registration_list.xlsx"
    wb.save(response)
    return response


@staff_required
def export_programs(request):
    activity = _export_activity(request)
    if activity is None and not request.user.is_admin:
        raise PermissionDenied("全量导出仅管理员可用；请先用活动筛选导出单个活动。")
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "节目单"
    ws.append(
        [
            "顺序",
            "节目名称",
            "类型",
            "负责人",
            "联系方式",
            "所属",
            "演员",
            "时长",
            "麦克风需求",
            "道具需求",
            "状态",
            "活动",
            "提交时间",
        ]
    )
    if activity is not None:
        rows = scope_runtime(
            Program.objects.select_related("activity").filter(activity=activity), activity
        )
    else:
        rows = Program.objects.select_related("activity").filter(is_test_data=False)
    row_count = 0
    for p in rows:
        ws.append(
            [
                p.sort_order,
                p.name,
                p.get_program_type_display(),
                p.contact_name,
                p.contact_phone,
                p.class_name,
                p.performers,
                p.estimated_duration,
                p.mic_requirements,
                p.prop_requirements,
                p.get_status_display(),
                p.activity.title,
                p.created_at.strftime("%Y-%m-%d %H:%M"),
            ]
        )
        row_count += 1
    audit_export(request, activity, "program_list", row_count=row_count)
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = "attachment; filename=program_list.xlsx"
    wb.save(response)
    return response


# --- Singer contest scoring ---


@staff_required
def round_list(request):
    rounds = ContestRound.objects.select_related("activity").annotate(
        entry_count=Count("entries", distinct=True),
        judge_count=Count("round_judges", distinct=True),
    )
    return render(request, "staff_panel/round_list.html", {"rounds": rounds})


@staff_required
def round_create(request):
    if request.method == "POST":
        form = ContestRoundForm(request.POST)
        activity = get_object_or_404(Activity, pk=request.POST.get("activity_id"))
        ensure_activity_unlocked(activity)
        if not form.is_valid():
            return render(
                request,
                "staff_panel/round_form.html",
                {
                    "error": _form_error(form),
                    "activities": Activity.objects.filter(
                        activity_type=Activity.Type.SINGER_CONTEST
                    ),
                    "round_types": _choices(ContestRound.RoundType),
                    "scoring_modes": _choices(ContestRound.ScoringMode),
                },
            )
        contest_round = ContestRound.objects.create(
            activity=activity,
            round_type=form.cleaned_data["round_type"],
            scoring_mode=form.cleaned_data["scoring_mode"],
            name=form.cleaned_data["name"],
            advance_count=form.cleaned_data["advance_count"],
        )
        log_action(
            request,
            AuditLog.ActionType.OTHER,
            f"ContestRound:{contest_round.pk}",
            new_value=contest_round.name,
        )
        return redirect("staff:round_list")

    activities = Activity.objects.filter(activity_type=Activity.Type.SINGER_CONTEST)
    return render(
        request,
        "staff_panel/round_form.html",
        {
            "activities": activities,
            "round_types": _choices(ContestRound.RoundType),
            "scoring_modes": _choices(ContestRound.ScoringMode),
        },
    )


@staff_required
@require_POST
def round_prepare(request, pk):
    contest_round = get_object_or_404(ContestRound.objects.select_related("activity"), pk=pk)
    ensure_activity_unlocked(contest_round.activity)
    ensure_activity_action_allowed(contest_round.activity, ActivityAction.SCORE)
    prepare_round(contest_round, request.user)
    return redirect("staff:round_list")


@staff_required
def round_score_entry(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    if contest_round.status == ContestRound.Status.DRAFT:
        return render(
            request,
            "staff_panel/round_score_entry.html",
            {"round": contest_round, "preparation_required": True},
        )

    singers = _eligible_singers(contest_round)
    judges = _active_judges(contest_round)
    scores = {
        (s.singer_id, s.judge_id): s.score for s in ScoreRecord.objects.filter(round=contest_round)
    }

    errors = []
    if request.method == "POST":
        ensure_round_unlocked(contest_round)
        ensure_activity_action_allowed(contest_round.activity, ActivityAction.SCORE)
        score_values = {}
        for singer in singers:
            for judge in judges:
                key = f"score_{singer.pk}_{judge.pk}"
                value = request.POST.get(key, "").strip()
                if value:
                    score_values[(singer.pk, judge.pk)] = value
        try:
            apply_scores(contest_round, score_values, request.user)
        except ValidationError as error:
            errors.extend(error.messages)
        else:
            return redirect("staff:round_score_entry", pk=pk)

    # Pre-compute score grid: list of (singer, [(judge_pk, score), ...])
    score_grid = []
    for singer in singers:
        row = [(judge.pk, scores.get((singer.pk, judge.pk), "")) for judge in judges]
        score_grid.append((singer, row))

    return render(
        request,
        "staff_panel/round_score_entry.html",
        {
            "round": contest_round,
            "judges": judges,
            "score_grid": score_grid,
            "errors": errors,
        },
    )


@staff_required
def round_ranking(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    summaries = ScoreSummary.objects.filter(
        round=contest_round, singer__round_entries__round=contest_round
    ).select_related("singer")
    missing_cells = missing_score_cells(contest_round)
    return render(
        request,
        "staff_panel/round_ranking.html",
        {
            "round": contest_round,
            "summaries": summaries,
            "preparation_required": contest_round.status == ContestRound.Status.DRAFT,
            "has_missing": bool(missing_cells),
            "missing_cells": missing_cells,
        },
    )


@staff_required
@require_POST
def round_finalize_advancement(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    ensure_activity_action_allowed(contest_round.activity, ActivityAction.SCORE)
    try:
        finalize_advancement(
            contest_round, request.POST.getlist("selected_singer_ids"), request.user
        )
    except ValidationError as error:
        messages.error(request, "；".join(error.messages))
    else:
        messages.success(request, "已核定晋级名单。")
    return redirect("staff:round_ranking", pk=pk)


@staff_required
@require_POST
def round_lock(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    lock_round(contest_round, request.user)
    return redirect("staff:round_ranking", pk=pk)


@admin_required
@require_POST
def round_unlock(request, pk):
    _require_admin(request.user)
    contest_round = get_object_or_404(ContestRound, pk=pk)
    unlock_round(contest_round, request.user, note=request.POST.get("note", "").strip())
    return redirect("staff:round_ranking", pk=pk)


@admin_required
@require_POST
def round_reset(request, pk):
    _require_admin(request.user)
    contest_round = get_object_or_404(ContestRound, pk=pk)
    reason = request.POST.get("reason", "")
    if not reason.strip():
        raise PermissionDenied("重置轮次必须填写原因。")
    reset_round_to_draft(contest_round, request.user, reason=reason)
    return redirect("staff:round_list")


@staff_required
def judge_list(request):
    judges = Judge.objects.select_related("activity")
    return render(request, "staff_panel/judge_list.html", {"judges": judges})


@staff_required
def judge_create(request):
    if request.method == "POST":
        activity = get_object_or_404(Activity, pk=request.POST["activity_id"])
        ensure_activity_unlocked(activity)
        judge = Judge.objects.create(
            activity=activity,
            name=request.POST["name"],
        )
        log_action(request, AuditLog.ActionType.OTHER, f"Judge:{judge.pk}", new_value=judge.name)
        return redirect("staff:judge_list")

    activities = Activity.objects.filter(activity_type=Activity.Type.SINGER_CONTEST)
    return render(request, "staff_panel/judge_form.html", {"activities": activities})


@staff_required
def award_list(request):
    awards = Award.objects.select_related("singer", "activity")
    return render(request, "staff_panel/award_list.html", {"awards": awards})


@staff_required
@transaction.atomic
def award_create(request):
    if request.method == "POST":
        activity = get_object_or_404(Activity, pk=request.POST["activity_id"])
        activity = lock_activity_for_runtime_data(activity)
        ensure_activity_unlocked(activity)
        ensure_activity_action_allowed(activity, ActivityAction.MANAGE_AWARD)
        singer_id = request.POST.get("singer_id")
        if singer_id:
            singer = get_object_or_404(SingerRegistration, pk=singer_id)
            ensure_same_activity(activity, singer, label="Award singer")
            ensure_lifecycle_consistent(activity, singer, label="Award 选手")
            award = Award.objects.create(
                activity=activity,
                singer=singer,
                name=request.POST["name"],
                is_test_data=activity.is_test_mode,
            )
            log_action(
                request, AuditLog.ActionType.OTHER, f"Award:{award.pk}", new_value=award.name
            )
        return redirect("staff:award_list")

    activities = Activity.objects.filter(activity_type=Activity.Type.SINGER_CONTEST)
    singers = scope_lifecycle(
        SingerRegistration.objects.select_related("activity").filter(
            pre_status=SingerRegistration.PreStatus.APPROVED
        )
    )
    return render(
        request,
        "staff_panel/award_form.html",
        {
            "activities": activities,
            "singers": singers,
        },
    )


# --- Vote session management ---


@staff_required
def vote_session_list(request):
    sessions = VoteSession.objects.select_related("activity")
    return render(request, "staff_panel/vote_session_list.html", {"sessions": sessions})


@staff_required
@transaction.atomic
def vote_session_create(request):
    if request.method == "POST":
        form = VoteSessionForm(request.POST)
        activity = get_object_or_404(Activity, pk=request.POST["activity_id"])
        activity = lock_activity_for_runtime_data(activity)
        ensure_activity_unlocked(activity)
        ensure_activity_action_allowed(activity, ActivityAction.MANAGE_VOTE)
        if not form.is_valid():
            return render(
                request,
                "staff_panel/vote_session_form.html",
                {
                    "error": _form_error(form),
                    "activities": Activity.objects.filter(
                        activity_type=Activity.Type.SINGER_CONTEST
                    ),
                    "singers": scope_lifecycle(
                        SingerRegistration.objects.select_related("activity").filter(
                            pre_status=SingerRegistration.PreStatus.APPROVED
                        )
                    ),
                    "selection_types": _choices(VoteSession.SelectionType),
                },
            )
        singer_ids = request.POST.getlist("singers")
        if len(singer_ids) != len(set(singer_ids)):
            raise PermissionDenied("Vote options cannot contain duplicate singers.")
        selected_singers = list(
            SingerRegistration.objects.filter(
                pk__in=singer_ids,
                pre_status=SingerRegistration.PreStatus.APPROVED,
            )
        )
        if len(selected_singers) != len(singer_ids):
            raise PermissionDenied("Every vote option must be an approved singer.")
        for singer in selected_singers:
            ensure_same_activity(activity, singer, label="Vote option singer")
            ensure_lifecycle_consistent(activity, singer, label="投票候选选手")
        vote_session = VoteSession.objects.create(
            activity=activity,
            name=form.cleaned_data["name"],
            passcode=form.cleaned_data["passcode"],
            start_time=form.cleaned_data["start_time"],
            end_time=form.cleaned_data["end_time"],
            selection_type=form.cleaned_data["selection_type"],
            max_selections=form.cleaned_data["max_selections"],
            is_test_data=activity.is_test_mode,
        )
        for i, sid in enumerate(singer_ids):
            VoteOption.objects.create(
                vote_session=vote_session,
                singer_id=sid,
                sort_order=i,
                is_test_data=activity.is_test_mode,
            )
        log_action(
            request,
            AuditLog.ActionType.VOTE_MANAGE,
            f"VoteSession:{vote_session.pk}",
            new_value=vote_session.name,
        )
        return redirect("staff:vote_session_list")

    activities = Activity.objects.filter(activity_type=Activity.Type.SINGER_CONTEST)
    singers = scope_lifecycle(
        SingerRegistration.objects.select_related("activity").filter(
            pre_status=SingerRegistration.PreStatus.APPROVED
        )
    )
    return render(
        request,
        "staff_panel/vote_session_form.html",
        {
            "activities": activities,
            "singers": singers,
            "selection_types": _choices(VoteSession.SelectionType),
        },
    )


@staff_required
def vote_session_detail(request, pk):
    vote_session = get_object_or_404(VoteSession.objects.select_related("activity"), pk=pk)
    options = vote_session.options.select_related("singer")
    # Annotate with vote count

    options = options.annotate(vote_count=Count("records"))
    total_votes = VoteRecord.objects.filter(vote_session=vote_session).count()
    _, top = _popularity_top_tie(vote_session)
    return render(
        request,
        "staff_panel/vote_session_detail.html",
        {
            "vote_session": vote_session,
            "options": options,
            "total_votes": total_votes,
            "popularity_tie": len(top) > 1,
        },
    )


@staff_required
@require_POST
def vote_session_open(request, pk):
    vote_session = get_object_or_404(VoteSession.objects.select_related("activity"), pk=pk)
    ensure_activity_action_allowed(vote_session.activity, ActivityAction.MANAGE_VOTE)
    open_vote_session(vote_session, request.user)
    return redirect("staff:vote_session_detail", pk=pk)


@staff_required
@require_POST
def vote_session_close(request, pk):
    vote_session = get_object_or_404(VoteSession.objects.select_related("activity"), pk=pk)
    ensure_activity_action_allowed(vote_session.activity, ActivityAction.MANAGE_VOTE)
    close_vote_session(vote_session, request.user)
    return redirect("staff:vote_session_detail", pk=pk)


@staff_required
@require_POST
@transaction.atomic
def vote_session_lock(request, pk):
    vote_session = get_object_or_404(VoteSession.objects.select_related("activity"), pk=pk)
    ensure_activity_action_allowed(vote_session.activity, ActivityAction.MANAGE_VOTE)
    lock_vote_session(vote_session, request.user)
    outcome = _generate_popularity_award(vote_session)
    if outcome["status"] == "tie":
        messages.warning(request, "最佳人气奖存在同分，请人工核定获奖名单。")
    elif outcome["status"] == "created":
        messages.success(request, "已生成最佳人气奖。")
    return redirect("staff:vote_session_detail", pk=pk)


@admin_required
@require_POST
def vote_session_unlock(request, pk):
    _require_admin(request.user)
    vote_session = get_object_or_404(VoteSession, pk=pk)
    note = request.POST.get("note", "").strip()
    unlock_vote_session(vote_session, request.user, note=note)
    return redirect("staff:vote_session_detail", pk=pk)


@staff_required
def vote_session_export(request, pk):
    vote_session = get_object_or_404(VoteSession, pk=pk)
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "投票结果"
    ws.append(["选手", "票数"])
    from django.db.models import Count

    option_list = list(
        vote_session.options.select_related("singer").annotate(vote_count=Count("records"))
    )
    for opt in option_list:
        ws.append([opt.singer.name, opt.vote_count])
    audit_export(request, vote_session.activity, "vote_result", row_count=len(option_list))
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = f"attachment; filename=vote_result_{vote_session.pk}.xlsx"
    wb.save(response)
    return response


def _popularity_top_tie(vote_session):
    """Return (top_vote_count, tied_top_options).

    An empty tuple result means there are no winning ballots. The tie list is
    deliberately order-independent so a database sort can never decide who wins.
    """
    leaderboard = list(
        vote_session.options.select_related("singer")
        .annotate(vote_count=Count("records"))
        .filter(vote_count__gt=0)
        .order_by("-vote_count", "sort_order", "pk")
    )
    if not leaderboard:
        return None, []
    top_count = leaderboard[0].vote_count
    return top_count, [option for option in leaderboard if option.vote_count == top_count]


def _generate_popularity_award(vote_session):
    from django.db import transaction

    top_count, top = _popularity_top_tie(vote_session)
    if top_count is None:
        return {"status": "no_votes", "count": 0, "top": []}
    if len(top) > 1:
        return {"status": "tie", "count": top_count, "top": top}
    winner = top[0]
    with transaction.atomic():
        legacy_awards = Award.objects.filter(
            activity=vote_session.activity,
            name="最佳人气奖",
            source_vote_session__isnull=True,
        ).order_by("pk")
        award = legacy_awards.first()
        if award:
            legacy_awards.exclude(pk=award.pk).delete()
            award.source_vote_session = vote_session
            award.singer = winner.singer
            award.is_test_data = vote_session.is_test_data
            award.save(update_fields=["source_vote_session", "singer", "is_test_data"])
        else:
            award, _ = Award.objects.update_or_create(
                source_vote_session=vote_session,
                defaults={
                    "activity": vote_session.activity,
                    "singer": winner.singer,
                    "name": "最佳人气奖",
                    "is_test_data": vote_session.is_test_data,
                },
            )
    return {"status": "created", "count": top_count, "top": top, "award": award}


# --- QR code center ---


@staff_required
def qr_center(request):
    activities = Activity.objects.all()
    return render(request, "staff_panel/qr_center.html", {"activities": activities})


@staff_required
def qr_generate(request, pk):
    activity = get_object_or_404(Activity, pk=pk)
    return render(request, "staff_panel/qr_detail.html", {"activity": activity})


@staff_required
def qr_image(request, pk, kind):
    activity = get_object_or_404(Activity, pk=pk)
    if kind == "registration":
        path = f"{reverse('singer_contest:apply')}?activity={activity.pk}"
    elif kind == "vote":
        vote_session = activity.vote_sessions.order_by("-created_at").first()
        if not vote_session:
            return HttpResponse("No vote session", status=404)
        path = reverse("voting:vote_entry", args=[vote_session.pk])
    elif kind == "results":
        path = reverse("public_portal:result_list")
    else:
        return HttpResponse("Unknown QR code kind", status=404)

    import qrcode

    image = qrcode.make(request.build_absolute_uri(path))
    buffer = io.BytesIO()
    image.save(buffer)
    response = HttpResponse(buffer.getvalue(), content_type="image/png")
    response["Content-Disposition"] = f'inline; filename="{kind}_{activity.pk}.png"'
    return response


# --- Export center ---


@staff_required
def export_center(request):
    activities = Activity.objects.all()
    templates = ArticleTemplate.objects.all()
    return render(
        request,
        "staff_panel/export_center.html",
        {
            "activities": activities,
            "templates": templates,
        },
    )


@staff_required
def _legacy_excel_material_checklist(request, activity_id):
    activity = get_object_or_404(Activity, pk=activity_id)
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "材料清单"
    ws.append(["姓名", "项目", "状态"])
    checks = MaterialCheck.objects.filter(
        singer_registration__activity=activity,
        singer_registration__is_test_data=runtime_is_test(activity),
    )
    for c in checks.select_related("singer_registration"):
        ws.append(
            [
                c.singer_registration.name if c.singer_registration else "",
                c.item_name,
                c.get_status_display(),
            ]
        )
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = "attachment; filename=material_checklist.xlsx"
    wb.save(response)
    return response


@staff_required
def excel_material_checklist(request, activity_id):
    activity = get_object_or_404(Activity, pk=activity_id)
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Material Checklist"
    ws.append(["Owner Type", "Owner", "Item", "Status"])
    row_count = 0
    for c in MaterialCheck.objects.filter(
        singer_registration__activity=activity,
        singer_registration__is_test_data=runtime_is_test(activity),
    ).select_related("singer_registration"):
        ws.append(
            [
                "singer",
                c.singer_registration.name if c.singer_registration else "",
                c.item_name,
                c.get_status_display(),
            ]
        )
        row_count += 1
    for c in MaterialCheck.objects.filter(
        program__activity=activity,
        program__is_test_data=runtime_is_test(activity),
    ).select_related("program"):
        ws.append(
            [
                "program",
                c.program.name if c.program else "",
                c.item_name,
                c.get_status_display(),
            ]
        )
        row_count += 1
    audit_export(request, activity, "material_checklist", row_count=row_count)
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = "attachment; filename=material_checklist.xlsx"
    wb.save(response)
    return response


@staff_required
def excel_score_template(request, round_id):
    contest_round = get_object_or_404(ContestRound, pk=round_id)
    singers = list(_eligible_singers(contest_round))
    wb = build_score_template_workbook(contest_round)
    audit_export(request, contest_round.activity, "score_template", row_count=len(singers))
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = "attachment; filename=score_template.xlsx"
    wb.save(response)
    return response


@staff_required
def excel_import_scores(request, round_id):
    contest_round = get_object_or_404(ContestRound, pk=round_id)
    errors = []
    if request.method == "POST" and request.FILES.get("file"):
        ensure_round_unlocked(contest_round)
        try:
            scores, errors = parse_score_workbook(request.FILES["file"], contest_round)
            if not errors:
                apply_scores(contest_round, scores, request.user, note="excel import")
                return redirect("staff:round_score_entry", pk=round_id)
        except ValidationError as error:
            errors.extend(error.messages)
        except Exception:
            errors.append("文件解析失败，请上传有效的 xlsx 评分表。")
    elif request.method == "POST":
        errors.append("请选择要导入的 xlsx 评分表。")
    return render(
        request,
        "staff_panel/excel_import.html",
        {
            "round": contest_round,
            "errors": errors,
        },
    )


# --- Word generation ---


@staff_required
@require_POST
def word_generate(request, template_id, activity_id):
    template = get_object_or_404(ArticleTemplate, pk=template_id)
    activity = get_object_or_404(Activity, pk=activity_id)
    from docx import Document

    doc = Document()
    doc.add_heading(activity.title, 0)
    body = template.body
    singers = scope_runtime(
        SingerRegistration.objects.filter(
            activity=activity,
            pre_status=SingerRegistration.PreStatus.APPROVED,
        ),
        activity,
    )
    singer_lines = "\n".join(f"{s.name} — {s.song_name}" for s in singers)
    programs = scope_runtime(Program.objects.filter(activity=activity), activity)
    program_lines = "\n".join(f"{p.sort_order}. {p.name} — {p.contact_name}" for p in programs)
    body = body.replace("{title}", activity.title)
    body = body.replace("{subtitle}", activity.subtitle or "")
    body = body.replace("{date}", activity.created_at.strftime("%Y年%m月%d日"))
    body = body.replace("{time}", "")
    body = body.replace("{venue}", "")
    body = body.replace("{content}", "")
    body = body.replace("{singers}", singer_lines)
    body = body.replace("{programs}", program_lines)
    body = body.replace("{sign_off}", "浙江工业大学 信息工程学院 文艺部")
    for para_text in body.split("\n"):
        doc.add_paragraph(para_text)
    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    with transaction.atomic():
        activity = lock_activity_for_runtime_data(activity)
        doc_obj = GeneratedDocument.objects.create(
            template=template,
            activity=activity,
            title=template.name,
            created_by=request.user,
            is_test_data=activity.is_test_mode,
        )
        doc_obj.file.save(
            f"{template.template_type}_{activity_id}.docx", ContentFile(buf.getvalue())
        )
    audit_export(request, activity, "word_generate")
    response = HttpResponse(
        buf.read(),
        content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    response["Content-Disposition"] = (
        f"attachment; filename={template.template_type}_{activity_id}.docx"
    )
    return response


# --- Execution & archive packages ---


@staff_required
def execution_package(request, activity_id):
    activity = get_object_or_404(Activity, pk=activity_id)
    artifacts = build_execution_package(activity, request)
    response = HttpResponse(build_package_zip(artifacts), content_type="application/zip")
    response["Content-Disposition"] = f"attachment; filename=execution_{activity_id}.zip"
    audit_export(request, activity, "execution_package")
    return response


@staff_required
@require_POST
def archive_package_create(request, activity_id):
    """Produce a source-of-truth-free preview ZIP; never mutates the activity."""
    activity = get_object_or_404(Activity, pk=activity_id)
    artifacts = build_archive_package(activity)
    response = HttpResponse(build_package_zip(artifacts), content_type="application/zip")
    response["Content-Disposition"] = f"attachment; filename=archive_{activity_id}.zip"
    audit_export(request, activity, "archive_preview")
    return response


@admin_required
@require_POST
def activity_archive(request, pk):
    activity = get_object_or_404(Activity, pk=pk)
    try:
        archive_activity(activity, request.user, note=request.POST.get("note", "").strip())
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, str(error))
        return redirect("staff:export_center")
    messages.success(request, "活动已归档并锁定。")
    return redirect("staff:export_center")


# --- Incident records ---


@staff_required
def incident_list(request):
    incidents = IncidentRecord.objects.select_related("activity", "singer", "handled_by")
    return render(request, "staff_panel/incident_list.html", {"incidents": incidents})


@staff_required
@transaction.atomic
def incident_create(request):
    if request.method == "POST":
        form = IncidentForm(request.POST)
        activity = get_object_or_404(Activity, pk=request.POST["activity_id"])
        activity = lock_activity_for_runtime_data(activity)
        ensure_activity_unlocked(activity)
        if not form.is_valid():
            return render(
                request,
                "staff_panel/incident_form.html",
                {
                    "error": _form_error(form),
                    "activities": Activity.objects.all(),
                    "singers": scope_lifecycle(
                        SingerRegistration.objects.select_related("activity").filter(
                            pre_status=SingerRegistration.PreStatus.APPROVED
                        )
                    ),
                    "event_types": _choices(IncidentRecord.EventType),
                },
            )
        singer = None
        if request.POST.get("singer_id"):
            singer = get_object_or_404(SingerRegistration, pk=request.POST["singer_id"])
            ensure_same_activity(activity, singer, label="Incident singer")
            ensure_lifecycle_consistent(activity, singer, label="涉事选手")
        program = None
        if request.POST.get("program_id"):
            program = get_object_or_404(Program, pk=request.POST["program_id"])
            ensure_same_activity(activity, program, label="Incident program")
            ensure_lifecycle_consistent(activity, program, label="涉事节目")
        incident = IncidentRecord.objects.create(
            activity=activity,
            occurred_at=form.cleaned_data["occurred_at"],
            event_type=form.cleaned_data["event_type"],
            singer=singer,
            program=program,
            handled_by_id=request.user.pk,
            resolution=form.cleaned_data.get("resolution", ""),
            remark=form.cleaned_data.get("remark", ""),
            is_test=activity.is_test_mode,
        )
        log_action(
            request,
            AuditLog.ActionType.OTHER,
            f"IncidentRecord:{incident.pk}",
            new_value=incident.event_type,
        )
        return redirect("staff:incident_list")
    activities = Activity.objects.all()
    singers = scope_lifecycle(
        SingerRegistration.objects.select_related("activity").filter(
            pre_status=SingerRegistration.PreStatus.APPROVED
        )
    )
    return render(
        request,
        "staff_panel/incident_form.html",
        {
            "activities": activities,
            "singers": singers,
            "event_types": _choices(IncidentRecord.EventType),
        },
    )


@staff_required
def incident_export(request):
    activity = _export_activity(request)
    if activity is None and not request.user.is_admin:
        raise PermissionDenied("全量导出仅管理员可用；请先用活动筛选导出单个活动。")
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "异常记录"
    ws.append(["活动", "时间", "类型", "选手", "处理人", "处理结果", "备注"])
    if activity is not None:
        incidents = IncidentRecord.objects.select_related(
            "activity", "singer", "handled_by"
        ).filter(activity=activity, is_test=runtime_is_test(activity))
    else:
        incidents = IncidentRecord.objects.select_related(
            "activity", "singer", "handled_by"
        ).filter(is_test=False)
    row_count = 0
    for inc in incidents:
        ws.append(
            [
                inc.activity.title,
                inc.occurred_at.strftime("%Y-%m-%d %H:%M"),
                inc.get_event_type_display(),
                inc.singer.name if inc.singer else "",
                inc.handled_by.username if inc.handled_by else "",
                inc.resolution,
                inc.remark,
            ]
        )
        row_count += 1
    audit_export(request, activity, "incident_list", row_count=row_count)
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = "attachment; filename=incident_list.xlsx"
    wb.save(response)
    return response


# --- Test mode management ---


@admin_required
@require_POST
def activity_test_toggle(request, pk):
    _require_admin(request.user)
    activity = get_object_or_404(Activity, pk=pk)
    if not activity.is_test_mode:
        raise PermissionDenied(
            "Formal activities cannot re-enter test mode. Clone the activity instead."
        )
    leave_test_mode(
        activity,
        operator=request.user,
        clear=request.POST.get("clear") == "on",
        reason=request.POST.get("reason", ""),
    )
    return redirect("staff:export_center")


@admin_required
@require_POST
def activity_clear_test_data(request, pk):
    _require_admin(request.user)
    activity = get_object_or_404(Activity, pk=pk)
    if not activity.is_test_mode:
        raise PermissionDenied("Test data can only be cleared while the activity is in test mode.")
    clear_activity_test_data(activity, operator=request.user)
    return redirect("staff:export_center")


# --- Activity management ---


@admin_required
@require_POST
@transaction.atomic
def activity_lock(request, pk):
    _require_admin(request.user)
    activity = get_object_or_404(Activity.objects.select_for_update(), pk=pk)
    activity.is_locked = True
    activity.locked_at = timezone.now()
    activity.locked_by = request.user
    activity.save(update_fields=["is_locked", "locked_at", "locked_by"])
    log_action(
        request, AuditLog.ActionType.RELOCK_RESULT, f"Activity:{activity.pk}", new_value="locked"
    )
    return redirect("staff:export_center")


@admin_required
@require_POST
@transaction.atomic
def activity_unlock(request, pk):
    _require_admin(request.user)
    note = request.POST.get("note", "").strip()
    activity = get_object_or_404(Activity.objects.select_for_update(), pk=pk)
    if activity.phase == Activity.Phase.ARCHIVED:
        raise PermissionDenied("活动已归档，请使用解归档功能。")
    activity.is_locked = False
    activity.locked_at = None
    activity.locked_by = None
    activity.save(update_fields=["is_locked", "locked_at", "locked_by"])
    log_action(
        request,
        AuditLog.ActionType.UNLOCK_RESULT,
        f"Activity:{activity.pk}",
        old_value="locked",
        new_value="unlocked",
        note=note,
    )
    return redirect("staff:export_center")


@admin_required
@require_POST
def activity_unarchive(request, pk):
    _require_admin(request.user)
    activity = get_object_or_404(Activity, pk=pk)
    unarchive_activity(activity, actor=request.user, note=request.POST.get("note", "").strip())
    messages.success(request, "活动已解归档并恢复到结果公示阶段。")
    return redirect("staff:export_center")


@admin_required
@require_POST
@transaction.atomic
def activity_clone(request, pk):
    _require_admin(request.user)
    original = get_object_or_404(Activity, pk=pk)
    new_activity = Activity.objects.create(
        title=f"{original.title}（副本）",
        subtitle=original.subtitle,
        activity_type=original.activity_type,
        phase=Activity.Phase.DRAFT,
        description=original.description,
        is_test_mode=True,
    )
    for req in MaterialRequirement.objects.filter(activity=original):
        MaterialRequirement.objects.create(
            activity=new_activity,
            applies_to=req.applies_to,
            item_name=req.item_name,
            file_purpose=req.file_purpose,
            is_required=req.is_required,
            sort_order=req.sort_order,
        )
    for judge in Judge.objects.filter(activity=original):
        Judge.objects.create(
            activity=new_activity,
            name=judge.name,
            is_active=judge.is_active,
        )
    for contest_round in ContestRound.objects.filter(activity=original):
        ContestRound.objects.create(
            activity=new_activity,
            round_type=contest_round.round_type,
            scoring_mode=contest_round.scoring_mode,
            name=contest_round.name,
            advance_count=contest_round.advance_count,
            is_locked=False,
        )
    # Vote sessions are runtime state (passcode, start/end window, open/locked),
    # not reusable template config. Cloning would copy a stale passcode and time
    # window into the new activity, so staff create sessions fresh per activity.
    log_action(
        request,
        AuditLog.ActionType.OTHER,
        f"Activity:{original.pk}",
        new_value=f"cloned_to={new_activity.pk}",
    )
    return redirect("staff:export_center")


# --- Audit log ---


@staff_required
def audit_log_list(request):
    logs = AuditLog.objects.select_related("operator")[:200]
    return render(request, "staff_panel/audit_log_list.html", {"logs": logs})


# --- User & role administration ---


@admin_required
def user_list(request):
    _require_admin(request.user)
    users = User.objects.order_by("-date_joined", "username")
    return render(request, "staff_panel/user_list.html", {"users": users})


@admin_required
@require_POST
def user_role_update(request, pk):
    _require_admin(request.user)
    target = get_object_or_404(User, pk=pk)
    try:
        updated = change_user_role(
            target=target, new_role=request.POST.get("new_role", ""), actor=request.user
        )
    except (ValidationError, PermissionDenied) as error:
        messages.error(request, str(error))
    else:
        messages.success(
            request, f"已将 {updated.username} 的角色改为 {updated.get_role_display()}。"
        )
    return redirect("staff:user_list")


@admin_required
@require_POST
def user_set_active(request, pk):
    _require_admin(request.user)
    target = get_object_or_404(User, pk=pk)
    is_active = request.POST.get("active") == "1"
    try:
        updated = set_user_active(target=target, is_active=is_active, actor=request.user)
    except (ValidationError, PermissionDenied) as error:
        messages.error(request, str(error))
    else:
        messages.success(
            request, f"已{'启用' if updated.is_active else '停用'}账号 {updated.username}。"
        )
    return redirect("staff:user_list")
