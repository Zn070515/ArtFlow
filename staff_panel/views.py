import io
import json
from decimal import Decimal, InvalidOperation

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
from core.services import (
    lock_activity_for_action,
    transition_activity_phase,
    unarchive_activity,
)
from django.contrib import messages
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import Count
from django.http import Http404, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_POST
from exports.models import ArticleTemplate
from exports.services import (
    archive_activity,
    build_archive_package,
    build_execution_package,
    build_package_zip,
    build_score_template_workbook,
    generate_persistent_document,
    render_document_bytes,
)
from farewell_show.models import Program
from files.models import MaterialCheck, MaterialRequirement, StaffNote, SubmissionFile
from files.services import (
    reconcile_activity_material_checks,
    reconcile_program_material_checks,
    reconcile_singer_material_checks,
    review_material_check,
    store_submission_file,
)
from incidents.models import IncidentRecord
from openpyxl import Workbook
from openpyxl.worksheet.worksheet import Worksheet
from public_portal.models import PublicPost
from ruleset import editor as ruleset_editor
from ruleset.compiler import compile_definition
from ruleset.models import ContestRuleset, RulesetTemplate, RulesetVersion
from ruleset.schema import ENTRY_KEY, NODE_TYPE_SPEC, OutputType, parse_definition
from ruleset.services import (
    RulesetInvalidError,
    _binding_signature,
    create_ruleset_version,
    freeze_ruleset_version,
    supersede_ruleset_version,
    update_ruleset_binding,
    update_ruleset_definition,
)
from singer_contest.models import (
    AudienceScore,
    Award,
    ContestRound,
    Judge,
    RoundEntry,
    RubricCriterion,
    ScoreRecord,
    ScoreSummary,
    ScoringRubric,
    SingerRegistration,
    StageResult,
)
from singer_contest.services import (
    StaleScoreVersionError,
    _active_judges,
    _current_frozen_version,
    _current_resolve_status,
    _eligible_singers,
    _version_binding,
    apply_scores,
    apply_scores_if_version,
    confirm_stage_result,
    ensure_audience_not_consumed_by_confirmed_stage,
    finalize_advancement,
    lock_round,
    maybe_resolve_checkpoints,
    missing_score_cells,
    parse_score_workbook,
    prepare_round,
    reset_round_to_draft,
    stage_decisions_by_blocks,
    unlock_round,
    unlock_stage_result,
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


def _ensure_publication_allowed(related_activity, status):
    if (
        status == PublicPost.Status.PUBLISHED
        and related_activity is not None
        and related_activity.data_lifecycle == Activity.DataLifecycle.TEST
    ):
        raise PermissionDenied("测试活动的公开内容不能直接发布，请保存为草稿或隐藏。")


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
        activity = lock_activity_for_action(activity)
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
        with transaction.atomic():
            related_activity = None
            if data["related_activity_id"]:
                related_activity = lock_activity_for_action(
                    get_object_or_404(Activity, pk=data["related_activity_id"])
                )
            _ensure_publication_allowed(related_activity, data["status"])
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
def post_preview(request, pk):
    post = get_object_or_404(PublicPost, pk=pk)
    media_items = post.media_items.filter(is_published=True)
    return render(
        request,
        "public_portal/post_detail.html",
        {"post": post, "media_items": media_items, "preview": True},
    )


@staff_required
@transaction.atomic
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
        old_hint_activity_id = post.related_activity_id
        new_activity_id = data["related_activity_id"]
        old_value = f"status={post.status}; title={post.title}"
        # A reparent touches up to two activities; lock both in stable ascending
        # PK order so two concurrent reparents cannot deadlock on opposite order.
        activity_ids = sorted({a for a in (old_hint_activity_id, new_activity_id) if a is not None})
        locked_by_pk = {
            a.pk: a
            for a in Activity.objects.select_for_update().filter(pk__in=activity_ids).order_by("pk")
        }
        if len(locked_by_pk) != len(activity_ids):
            raise Http404("关联的活动不存在。")
        # Lock the post too; its current parent is the authority, not the
        # pre-lock hint. If a reparent committed between our hint read and this
        # lock the row no longer matches — reject rather than chase a newly
        # revealed parent, which would break the stable Activity→PublicPost order.
        locked_post = PublicPost.objects.select_for_update().get(pk=post.pk)
        if locked_post.related_activity_id != old_hint_activity_id:
            raise PermissionDenied("页面内容已发生并发修改，请刷新后重新编辑。")
        # Optimistic concurrency: if the client's base_version is behind the
        # current one, another staff member already saved changes. Refuse to
        # silently overwrite them; render the stale form back with an explicit
        # outdated notice so the staff can refresh and re-apply their intent.
        base_version = data.get("base_version")
        if base_version is not None and locked_post.version != base_version:
            return render(
                request,
                "staff_panel/post_form.html",
                {
                    "error": "该内容已被其他人更新，请刷新后重新编辑。",
                    "post": post,
                    "post_types": _choices(PublicPost.PostType),
                    "statuses": _choices(PublicPost.Status),
                    "activities": Activity.objects.all(),
                },
            )
        old_locked = locked_by_pk.get(old_hint_activity_id) if old_hint_activity_id else None
        new_locked = locked_by_pk.get(new_activity_id) if new_activity_id else None
        # A move from a locked activity to an unlocked one must still be blocked;
        # checking only the new activity would let staff bypass the old lock.
        for locked_activity in (old_locked, new_locked):
            if locked_activity is not None:
                ensure_activity_unlocked(locked_activity)
        _ensure_publication_allowed(new_locked, data["status"])
        locked_post.title = data["title"]
        locked_post.subtitle = data["subtitle"]
        locked_post.content = data["content"]
        locked_post.post_type = data["post_type"]
        old_status = locked_post.status
        locked_post.status = data["status"]
        locked_post.sort_order = data["sort_order"]
        locked_post.is_pinned = data["is_pinned"]
        locked_post.related_activity_id = data["related_activity_id"]
        locked_post.updated_by = request.user
        locked_post.version += 1
        if request.FILES.get("cover_image"):
            locked_post.cover_image = request.FILES["cover_image"]
        if data["status"] == PublicPost.Status.PUBLISHED and not locked_post.published_at:
            locked_post.published_at = timezone.now()
        elif (
            data["status"] != PublicPost.Status.PUBLISHED
            and old_status == PublicPost.Status.PUBLISHED
        ):
            locked_post.published_at = None
        locked_post.save()
        log_action(
            request,
            AuditLog.ActionType.PUBLISH_POST,
            f"PublicPost:{locked_post.pk}",
            old_value=old_value,
            new_value=f"status={locked_post.status}; title={locked_post.title}",
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
        is_upload = "upload_file" in request.POST
        action = ActivityAction.UPLOAD_MATERIAL if is_upload else ActivityAction.REVIEW_REGISTRATION
        ensure_activity_action_allowed(reg.activity, action)
        with transaction.atomic():
            activity = lock_activity_for_action(reg.activity, action)
            locked_reg = (
                SingerRegistration.objects.select_for_update()
                .select_related("activity", "user")
                .get(pk=reg.pk)
            )
            if locked_reg.activity_id != activity.pk:
                raise PermissionDenied("报名信息不属于当前活动。")
            if is_upload:
                f = request.FILES.get("file")
                if f:
                    try:
                        submission_file = store_submission_file(
                            owner=locked_reg,
                            uploaded_file=f,
                            purpose=request.POST.get("file_purpose", SubmissionFile.Purpose.OTHER),
                            uploaded_by=request.user,
                        )
                    except ValidationError as error:
                        errors.extend(error.messages)
                    else:
                        reconcile_singer_material_checks(locked_reg)
                        log_action(
                            request,
                            AuditLog.ActionType.UPLOAD_FILE,
                            f"SubmissionFile:{submission_file.pk}",
                            new_value=submission_file.original_name,
                        )
            else:
                form = SingerReviewForm(request.POST)
                if not form.is_valid():
                    errors = [_form_error(form)]
                else:
                    old_value = f"pre={locked_reg.pre_status}; live={locked_reg.live_status}"
                    locked_reg.pre_status = form.cleaned_data["pre_status"]
                    locked_reg.live_status = form.cleaned_data["live_status"]
                    note = form.cleaned_data.get("staff_note", "").strip()
                    if note:
                        StaffNote.objects.create(
                            singer_registration=locked_reg,
                            content=note,
                            created_by=request.user,
                        )
                    locked_reg.save()
                    log_action(
                        request,
                        AuditLog.ActionType.UPDATE_STATUS,
                        f"SingerRegistration:{locked_reg.pk}",
                        old_value=old_value,
                        new_value=f"pre={locked_reg.pre_status}; live={locked_reg.live_status}",
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
        is_upload = "upload_file" in request.POST
        action = ActivityAction.UPLOAD_MATERIAL if is_upload else ActivityAction.REVIEW_REGISTRATION
        ensure_activity_action_allowed(prog.activity, action)
        with transaction.atomic():
            activity = lock_activity_for_action(prog.activity, action)
            locked_prog = (
                Program.objects.select_for_update()
                .select_related("activity", "user")
                .get(pk=prog.pk)
            )
            if locked_prog.activity_id != activity.pk:
                raise PermissionDenied("节目信息不属于当前活动。")
            if is_upload:
                f = request.FILES.get("file")
                if f:
                    try:
                        submission_file = store_submission_file(
                            owner=locked_prog,
                            uploaded_file=f,
                            purpose=request.POST.get("file_purpose", SubmissionFile.Purpose.OTHER),
                            uploaded_by=request.user,
                        )
                    except ValidationError as error:
                        errors.extend(error.messages)
                    else:
                        reconcile_program_material_checks(locked_prog)
                        log_action(
                            request,
                            AuditLog.ActionType.UPLOAD_FILE,
                            f"SubmissionFile:{submission_file.pk}",
                            new_value=submission_file.original_name,
                        )
            else:
                form = ProgramReviewForm(request.POST)
                if not form.is_valid():
                    errors = [_form_error(form)]
                else:
                    old_value = f"status={locked_prog.status}; sort_order={locked_prog.sort_order}"
                    locked_prog.status = form.cleaned_data["status"]
                    locked_prog.sort_order = form.cleaned_data["sort_order"]
                    note = form.cleaned_data.get("staff_note", "").strip()
                    if note:
                        StaffNote.objects.create(
                            program=locked_prog,
                            content=note,
                            created_by=request.user,
                        )
                    locked_prog.save()
                    log_action(
                        request,
                        AuditLog.ActionType.REVIEW_MATERIAL,
                        f"Program:{locked_prog.pk}",
                        old_value=old_value,
                        new_value=(
                            f"status={locked_prog.status}; sort_order={locked_prog.sort_order}"
                        ),
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
    result = request.POST.get("result")
    if result == "approve":
        status = MaterialCheck.Status.APPROVED
    elif result == "supplement":
        status = MaterialCheck.Status.NEEDS_SUPPLEMENT
    else:
        messages.error(request, "无效的审核操作。")
        return _material_review_redirect(owner)
    try:
        review_material_check(
            check,
            status=status,
            note=request.POST.get("note", ""),
            actor=request.user,
        )
    except ValidationError as error:
        messages.error(request, "；".join(error.messages))
        return _material_review_redirect(owner)
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
        with transaction.atomic():
            locked_activity = lock_activity_for_action(activity)
            _ensure_activity_mutable(locked_activity)
            applies_to = request.POST.get("applies_to")
            item_name = request.POST.get("item_name", "").strip()
            if not item_name:
                messages.error(request, "检查项名称不能为空。")
            elif applies_to not in MaterialRequirement.AppliesTo.values:
                messages.error(request, "无效的适用范围。")
            else:
                MaterialRequirement.objects.update_or_create(
                    activity=locked_activity,
                    applies_to=applies_to,
                    item_name=item_name,
                    defaults={
                        "file_purpose": request.POST.get("file_purpose", "") or "",
                        "is_required": True,
                        "sort_order": request.POST.get("sort_order", 0),
                    },
                )
                reconcile_activity_material_checks(locked_activity, applies_to)
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
    with transaction.atomic():
        locked_activity = lock_activity_for_action(activity)
        _ensure_activity_mutable(locked_activity)
        requirement = MaterialRequirement.objects.filter(pk=pk, activity=locked_activity).first()
        if requirement is not None:
            applies_to = requirement.applies_to
            requirement.delete()
            reconcile_activity_material_checks(locked_activity, applies_to)
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
        activity = get_object_or_404(Activity, pk=request.POST.get("activity_id"))
        form = ContestRoundForm(
            request.POST, rubrics=ScoringRubric.objects.filter(activity=activity)
        )
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
                    "roster_sources": [("", "自动判定"), *_choices(ContestRound.RosterSource)],
                    "rubrics": ScoringRubric.objects.select_related("activity").all(),
                },
            )
        with transaction.atomic():
            locked_activity = lock_activity_for_action(activity)
            contest_round = ContestRound.objects.create(
                activity=locked_activity,
                round_type=form.cleaned_data["round_type"],
                scoring_mode=form.cleaned_data["scoring_mode"],
                name=form.cleaned_data["name"],
                advance_count=form.cleaned_data["advance_count"],
                sequence=form.cleaned_data["sequence"],
                roster_source=form.cleaned_data["roster_source"],
                roster_source_stage=form.cleaned_data["roster_source_stage"],
                rubric=form.cleaned_data["rubric"],
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
            "roster_sources": [("", "自动判定"), *_choices(ContestRound.RosterSource)],
            "rubrics": ScoringRubric.objects.select_related("activity").all(),
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

    return render(
        request,
        "staff_panel/round_score_entry.html",
        {
            "round": contest_round,
            "grid_payload": _round_grid_payload(contest_round),
            "is_locked": contest_round.is_locked
            or contest_round.status == ContestRound.Status.LOCKED,
        },
    )


def _round_grid_payload(contest_round: ContestRound) -> dict:
    singers = list(_eligible_singers(contest_round))
    judges = list(_active_judges(contest_round))
    scores = {
        (s.singer_id, s.judge_id): str(s.score)
        for s in ScoreRecord.objects.filter(round=contest_round)
    }
    grid = [
        {
            "singer_id": singer.pk,
            "singer_name": singer.name,
            "song": singer.song_name,
            "cells": [
                {
                    "judge_id": judge.pk,
                    "judge_name": judge.name,
                    "score": scores.get((singer.pk, judge.pk), ""),
                }
                for judge in judges
            ],
        }
        for singer in singers
    ]
    return {
        "version": contest_round.score_version,
        "matrix_complete": not missing_score_cells(contest_round),
        "grid": grid,
        "judges": [{"id": judge.pk, "name": judge.name} for judge in judges],
    }


@staff_required
def round_scores_api(request, pk):
    """Backstage rapid-entry endpoint (M1-H).

    GET returns the current grid + ``score_version`` (the client's base version).
    POST accepts sparse ``cells`` and ``base_version``; a version mismatch is a 409
    (stale edit) so two staff never silently overwrite each other. When the save
    completes the score matrix the server re-resolves the activity's bound ruleset
    (best-effort) and reports the resulting stage status.
    """
    contest_round = get_object_or_404(ContestRound, pk=pk)

    if request.method == "GET":
        return JsonResponse({**_round_grid_payload(contest_round)})

    try:
        payload = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"detail": "请求体不是有效 JSON。"}, status=400)
    base_version = payload.get("base_version")
    cells = payload.get("cells", [])
    if base_version is None:
        return JsonResponse({"detail": "缺少 base_version。"}, status=400)

    score_values = {}
    for cell in cells:
        try:
            singer_id = int(cell["singer_id"])
            judge_id = int(cell["judge_id"])
        except (KeyError, TypeError, ValueError):
            return JsonResponse({"detail": "单元格缺少 singer_id/judge_id。"}, status=400)
        score_values[(singer_id, judge_id)] = str(cell.get("score", "")).strip()

    # ``apply_scores_if_version`` owns the Activity→Round transaction and its locks;
    # the view holds no row lock itself (M0 canonical order, §13.2 stale-guard).
    try:
        result = apply_scores_if_version(contest_round.pk, base_version, score_values, request.user)
    except StaleScoreVersionError:
        contest_round.refresh_from_db()
        return JsonResponse({**_round_grid_payload(contest_round), "conflict": True}, status=409)
    except ValidationError as error:
        return JsonResponse({"detail": error.messages}, status=400)
    except PermissionDenied:
        return JsonResponse({"detail": "权限不足。"}, status=403)

    resolved_status = None
    resolve_warning = None
    if result["matrix_complete"]:
        try:
            maybe_resolve_checkpoints(contest_round.activity, request.user)
        except (ValidationError, PermissionDenied) as exc:
            # Surface a ruleset/resolve problem to the operator instead of silently
            # dropping it (M1-INTEGRATION-CLOSE Item 7): the scores are saved but the
            # stage that could not auto-resolve must be visible, not invisible.
            resolve_warning = "；".join(getattr(exc, "messages", [])) or "该赛段无法自动核定，请人工核定。"
        # Report the stage's true current status (not just whether this save newly resolved
        # it): a no-op re-save of an already-READY stage must not read as "未计算".
        resolved_status = _current_resolve_status(contest_round.activity)
    response = {**result, "resolved_status": resolved_status}
    if resolve_warning:
        response["resolve_warning"] = resolve_warning
    return JsonResponse(response)


def _audience_pool(activity, version, audience_key):
    """The roster an audience score-group scores, derived from the frozen definition.

    ``audience_key`` is a binding key matching an ASSESS node's ``vote_source``; that
    node's ``source`` declares the pool: :data:`ENTRY_KEY` → the check-in pool, or the
    name of a SELECT node → the checkpoint that outputs it, bridged to the round that
    consumes that stage (its :class:`RoundEntry`). Falls back to the check-in pool when
    the roster has not materialised yet, mirroring the resolver's conservative scoping
    (its ``within`` filter is still the correctness backstop).
    """
    try:
        parsed = parse_definition(version.definition)
    except (ValidationError, TypeError, ValueError):
        return SingerRegistration.objects.filter(activity=activity).order_by("pk")
    source = None
    for node in parsed["nodes"]:
        if node.get("vote_source") == audience_key:
            source = node.get("source")
            break
    if not source or source == ENTRY_KEY:
        return SingerRegistration.objects.filter(activity=activity).order_by("pk")
    checkpoint_key = None
    for cp in parsed["checkpoints"]:
        if cp.get("output") == source:
            checkpoint_key = cp.get("key")
            break
    if checkpoint_key:
        advance_round = (
            ContestRound.objects.filter(
                activity=activity,
                roster_source=ContestRound.RosterSource.STAGE,
                roster_source_stage=checkpoint_key,
                status__in=[
                    ContestRound.Status.PREPARED,
                    ContestRound.Status.SCORING,
                    ContestRound.Status.LOCKED,
                ],
            )
            .order_by("-sequence")
            .first()
        )
        if advance_round is not None:
            singer_ids = list(
                RoundEntry.objects.filter(round=advance_round).values_list("singer_id", flat=True)
            )
            return list(
                SingerRegistration.objects.filter(pk__in=singer_ids, activity=activity).order_by(
                    "pk"
                )
            )
    return SingerRegistration.objects.filter(activity=activity).order_by("pk")


def _audience_sets(activity, version):
    """Build the audience grid, scoped per stage to its real roster.

    Each binding ``audience_key → set_name`` exposes the roster the stage actually scores
    (its ``within`` pool), derived from the frozen definition via :func:`_audience_pool`.
    This prevents a staff member from entering audience scores for singers who are no
    longer in that stage (e.g. audience4 over all 15).
    """
    if version is None:
        return []
    binding = _version_binding(version)
    audience_keys = binding.get("audience_keys") or {}
    stored = {
        (s.singer_id, s.stage_key): str(s.score)
        for s in AudienceScore.objects.filter(
            activity=activity, is_test_data=runtime_is_test(activity)
        )
    }
    sets = []
    for set_key, set_name in audience_keys.items():
        singers = _audience_pool(activity, version, set_key)
        sets.append(
            {
                "set_key": set_key,
                "stage_key": set_name,
                "rows": [
                    {
                        "singer_id": singer.pk,
                        "singer_name": singer.name,
                        "song": singer.song_name,
                        "score": stored.get((singer.pk, set_name), ""),
                    }
                    for singer in singers
                ],
            }
        )
    return sets


@staff_required
def audience_score_entry(request, activity_id):
    """Minimal staff page for entering backstage audience scores."""
    activity = get_object_or_404(Activity, pk=activity_id)
    try:
        version = _current_frozen_version(activity)
    except ValidationError as error:
        messages.error(request, "；".join(error.messages))
        return redirect("staff:audience_score_entry", activity_id=activity_id)
    sets = _audience_sets(activity, version)
    return render(
        request,
        "staff_panel/audience_score_entry.html",
        {
            "activity": activity,
            "sets": sets,
            "api_url": reverse("staff:audience_scores_api", kwargs={"activity_id": activity_id}),
        },
    )


@staff_required
def audience_scores_api(request, activity_id):
    """Backstage audience-score entry (M1-INTEGRATION-2).

    GET returns the audience grid: one group per binding ``audience_keys`` entry, each
    listing every activity singer plus its stored score (scale ``hundred``). POST accepts
    sparse ``cells`` as ``[{singer_id, set_key, score}]``, maps each ``set_key`` to its
    ``stage_key``, upserts :class:`~singer_contest.models.AudienceScore` rows, then
    auto-resolves any now-satisfiable checkpoint.
    """
    activity = get_object_or_404(Activity, pk=activity_id)
    try:
        version = _current_frozen_version(activity)
    except ValidationError as error:
        return JsonResponse({"detail": error.messages}, status=400)
    binding = _version_binding(version) if version is not None else {}
    audience_keys = binding.get("audience_keys") or {}
    if not audience_keys:
        return JsonResponse({"detail": "该活动未绑定观众分。"}, status=400)

    if request.method == "GET":
        return JsonResponse({"sets": _audience_sets(activity, version)})

    try:
        payload = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"detail": "请求体不是有效 JSON。"}, status=400)
    cells = payload.get("cells", [])
    if not cells:
        return JsonResponse({"detail": "缺少 cells。"}, status=400)

    valid_singer_ids = set(
        SingerRegistration.objects.filter(activity=activity).values_list("pk", flat=True)
    )
    rows: list[tuple[int, str, Decimal]] = []
    stage_keys: set[str] = set()
    errors: list[str] = []
    for cell in cells:
        try:
            singer_id = int(cell["singer_id"])
            score = Decimal(str(cell.get("score", "")).strip())
        except (KeyError, TypeError, ValueError, InvalidOperation):
            errors.append("单元格缺少 singer_id 或 score 不是有效数字。")
            continue
        if singer_id not in valid_singer_ids:
            errors.append(f"选手 {singer_id} 不属于该活动。")
            continue
        if not 0 <= score <= 100:
            errors.append(f"选手 {singer_id} 的观众分必须在 0-100 之间。")
            continue
        # AudienceScore.score is Decimal(max_digits=8, decimal_places=2); reject more than
        # two decimal places so SQLite (stores verbatim) and Postgres (rounds to 0.01) agree.
        if score != score.quantize(Decimal("0.01")):
            errors.append(f"选手 {singer_id} 的观众分最多保留两位小数。")
            continue
        set_key = str(cell.get("set_key", "")).strip()
        stage_key = audience_keys.get(set_key)
        if not stage_key:
            errors.append(f"未知观众分组 {set_key}。")
            continue
        rows.append((singer_id, stage_key, score))
        stage_keys.add(stage_key)
    if errors:
        return JsonResponse({"detail": errors}, status=400)

    # Hold the Activity FOR UPDATE lock across the guard + write so the check and the rows
    # are serialized against a concurrent confirm_stage_result (which takes the same lock);
    # otherwise a confirm could commit a stage consuming this audience set between our guard
    # and our insert. The auto-resolve runs in its own transaction afterwards.
    try:
        with transaction.atomic():
            lock_activity_for_action(activity)
            for stage_key in stage_keys:
                ensure_audience_not_consumed_by_confirmed_stage(activity, stage_key)
            test_flag = runtime_is_test(activity)
            for singer_id, stage_key, score in rows:
                AudienceScore.objects.update_or_create(
                    activity=activity,
                    stage_key=stage_key,
                    singer_id=singer_id,
                    defaults={
                        "score": score,
                        "entered_by": request.user,
                        "is_test_data": test_flag,
                    },
                )
    except ValidationError as error:
        return JsonResponse({"detail": error.messages}, status=400)
    except PermissionDenied:
        return JsonResponse({"detail": "权限不足。"}, status=403)

    # Resolve after the save transaction commits so a ruleset misconfiguration (missing bound
    # rounds, duplicate auto rulesets) reports an error without rolling back entered scores.
    # Surface it as resolve_warning (M1-INTEGRATION-CLOSE Item 7) so the operator sees that
    # a stage could not auto-resolve, instead of it disappearing silently.
    resolve_warning = None
    try:
        maybe_resolve_checkpoints(activity, request.user)
    except (ValidationError, PermissionDenied) as exc:
        resolve_warning = "；".join(getattr(exc, "messages", [])) or "该赛段无法自动核定，请人工核定。"

    response = {
        "saved": len(rows),
        "resolved_status": _current_resolve_status(activity),
    }
    if resolve_warning:
        response["resolve_warning"] = resolve_warning
    return JsonResponse(response)


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
def activity_result_board(request, activity_id):
    """List the latest StageResult per stage_key with HOLD/REVIEW/READY banners (M1-H)."""
    activity = get_object_or_404(Activity, pk=activity_id)
    stages = []
    seen = set()
    for stage in (
        StageResult.objects.filter(activity=activity)
        .select_related("ruleset_version__ruleset", "created_by")
        .order_by("-computed_at", "-pk")
    ):
        if stage.stage_key in seen:
            continue
        seen.add(stage.stage_key)
        stages.append(stage)
    return render(
        request,
        "staff_panel/activity_result_board.html",
        {"activity": activity, "stages": stages},
    )


@staff_required
def stage_result_detail(request, pk):
    """Render a single stage result's decisions grouped into handcard blocks (M1-H)."""
    stage = get_object_or_404(
        StageResult.objects.select_related("ruleset_version__ruleset", "activity", "created_by"),
        pk=pk,
    )
    return render(
        request,
        "staff_panel/stage_result_detail.html",
        {
            "stage": stage,
            "activity": stage.activity,
            "blocks": stage_decisions_by_blocks(stage),
        },
    )


@staff_required
@require_POST
def stage_result_confirm(request, pk):
    """核定并锁定 a stage result into its final handcard state (M1-H §36-37)."""
    stage = get_object_or_404(StageResult, pk=pk)
    ensure_activity_action_allowed(stage.activity, ActivityAction.PUBLISH_RESULT)
    try:
        confirm_stage_result(stage, confirmed_by=request.user)
    except ValidationError as error:
        messages.error(request, "；".join(error.messages))
    else:
        messages.success(request, "已核定并锁定该赛段结果，可抄主持手卡。")
    return redirect("staff:stage_result_detail", pk=pk)


@admin_required
@require_POST
def stage_result_unlock(request, pk):
    """Admin-only: unlock a confirmed stage result so its raw facts can be corrected."""
    _require_admin(request.user)
    stage = get_object_or_404(StageResult, pk=pk)
    try:
        unlock_stage_result(stage, operator=request.user, note=request.POST.get("note", "").strip())
    except ValidationError as error:
        messages.error(request, "；".join(error.messages))
    else:
        messages.success(request, "已解锁该赛段结果，可修正原始数据后重新核定。")
    return redirect("staff:stage_result_detail", pk=pk)


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
    try:
        maybe_resolve_checkpoints(contest_round.activity, request.user)
    except (ValidationError, PermissionDenied):
        pass
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
        with transaction.atomic():
            locked_activity = lock_activity_for_action(activity)
            judge = Judge.objects.create(
                activity=locked_activity,
                name=request.POST["name"],
            )
            log_action(
                request, AuditLog.ActionType.OTHER, f"Judge:{judge.pk}", new_value=judge.name
            )
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
    try:
        maybe_resolve_checkpoints(vote_session.activity, request.user)
    except (ValidationError, PermissionDenied):
        pass
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
    if activity.phase == Activity.Phase.ARCHIVED:
        # Read-only preview/download for an archived activity. Archived data is
        # immutable, so this never creates a persistent asset and the official
        # archive package stays the authoritative record of it.
        content = render_document_bytes(template, activity)
        audit_export(request, activity, "word_preview")
        return _docx_response(content, template, activity.pk)
    doc_obj, content = generate_persistent_document(activity, template, request.user)
    return _docx_response(content, template, activity.pk)


def _docx_response(content: bytes, template: ArticleTemplate, activity_id: int) -> HttpResponse:
    response = HttpResponse(
        content,
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
    rubric_map: dict[int | None, ScoringRubric] = {}
    for rubric in ScoringRubric.objects.filter(activity=original):
        new_rubric = ScoringRubric.objects.create(
            activity=new_activity,
            name=rubric.name,
            description=rubric.description,
            sequence=rubric.sequence,
            is_test_data=rubric.is_test_data,
        )
        for criterion in rubric.criteria.all():
            RubricCriterion.objects.create(
                rubric=new_rubric,
                name=criterion.name,
                max_score=criterion.max_score,
                sequence=criterion.sequence,
                description=criterion.description,
                is_test_data=criterion.is_test_data,
            )
        rubric_map[rubric.pk] = new_rubric
    for contest_round in ContestRound.objects.filter(activity=original):
        ContestRound.objects.create(
            activity=new_activity,
            round_type=contest_round.round_type,
            scoring_mode=contest_round.scoring_mode,
            name=contest_round.name,
            advance_count=contest_round.advance_count,
            sequence=contest_round.sequence,
            roster_source=contest_round.roster_source,
            roster_source_stage=contest_round.roster_source_stage,
            rubric=rubric_map.get(contest_round.rubric_id),
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


@staff_required
def ruleset_template_list(request):
    templates = RulesetTemplate.objects.all()
    activities = Activity.objects.all().order_by("-created_at")
    return render(
        request,
        "staff_panel/ruleset_template_list.html",
        {"templates": templates, "total": templates.count(), "activities": activities},
    )


@staff_required
def ruleset_template_detail(request, pk):
    template = get_object_or_404(RulesetTemplate, pk=pk)
    nodes = parse_definition(template.definition)["nodes"] if template.definition else []
    activities = Activity.objects.all().order_by("-created_at")
    return render(
        request,
        "staff_panel/ruleset_template_detail.html",
        {"template": template, "nodes": nodes, "activities": activities},
    )


def _starter_definition():
    """Minimal forward-only graph a blank ruleset starts from."""
    return json.dumps(
        {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
                {"key": "top10", "type": "SELECT", "source": "rank1", "count": 10},
            ],
        },
        ensure_ascii=False,
    )


def _unique_key(nodes, base):
    used = {n["key"] for n in nodes}
    candidate = base
    counter = 1
    while candidate in used:
        candidate = f"{base}_{counter}"
        counter += 1
    return candidate


def _last_node_of(output_types, nodes):
    for node in reversed(nodes):
        if NODE_TYPE_SPEC[node["type"]].output_type in output_types:
            return node["key"]
    return ENTRY_KEY


def _default_node(new_type, nodes):
    best_spec = NODE_TYPE_SPEC.get(new_type)
    if best_spec is None:
        raise ValueError(f"unknown node type {new_type!r}")
    node = {"key": _unique_key(nodes, new_type.lower()), "type": new_type}
    expects = (best_spec.expects or {}).get("source")
    if expects and OutputType.SCOREMAP in expects:
        source = _last_node_of({OutputType.SCOREMAP, OutputType.RANKED_ROSTER}, nodes)
    elif expects and OutputType.RANKED_ROSTER in expects:
        source = _last_node_of({OutputType.RANKED_ROSTER}, nodes)
    else:
        source = ENTRY_KEY
    for field in best_spec.required:
        if field == "source":
            node["source"] = source
        elif field == "count":
            node["count"] = 1
        elif field == "sources":
            node["sources"] = [ENTRY_KEY]
        elif field == "by":
            node["by"] = "组1"
        elif field == "aggregate":
            src = _last_node_of({OutputType.SCOREMAP}, nodes)
            node["aggregate"] = {
                "type": "weighted_sum",
                "components": [{"source": src or ENTRY_KEY, "weight": 1.0}],
            }
        elif field == "branches":
            node["branches"] = [{"when": "default", "into": ENTRY_KEY}]
        elif field == "minuend":
            node["minuend"] = ENTRY_KEY
        elif field == "subtrahend":
            node["subtrahend"] = ENTRY_KEY
        elif field == "quota":
            node["quota"] = 1
        elif field == "groups":
            node["groups"] = 1
        elif field == "from":
            node["from"] = ENTRY_KEY
        elif field == "into":
            node["into"] = _last_node_of({OutputType.GROUP_MAP}, nodes)
        elif field == "award":
            node["award"] = "默认奖项"
    if new_type == "ASSESS":
        node["round"] = f"r{len(nodes) + 1}"
    return node


def _swap_nodes(nodes, key, delta):
    index = next((i for i, n in enumerate(nodes) if n["key"] == key), None)
    if index is None:
        return nodes
    target = index + delta
    if target < 0 or target >= len(nodes):
        return nodes
    nodes = list(nodes)
    nodes[index], nodes[target] = nodes[target], nodes[index]
    return nodes


def _edit_nodes(post, nodes):
    action = post.get("action")
    if action == "add":
        new_type = post.get("new_type", "ASSESS")
        if new_type in ("BRANCH", "AWARD"):
            raise ValueError(f"node type {new_type!r} is not supported at runtime")
        nodes = nodes + [_default_node(new_type, nodes)]
    elif action == "delete":
        key = post.get("key")
        nodes = [n for n in nodes if n["key"] != key]
    elif action == "move_up":
        nodes = _swap_nodes(nodes, post.get("key"), -1)
    elif action == "move_down":
        nodes = _swap_nodes(nodes, post.get("key"), +1)
    elif action == "save":
        return ruleset_editor.definition_from_form(post)
    else:
        raise ValueError(f"unknown action {action!r}")
    return {"schema_version": 1, "nodes": nodes}


def _node_field_entries(node, index, sources):
    """Render data-driven edit fields for one node card (select/text/checkbox/json/aggregate)."""
    labels = ruleset_editor.field_labels()
    allowed = ruleset_editor.field_allowed()
    spec = NODE_TYPE_SPEC.get(node.get("type"))
    fields: list[dict] = []
    if spec is None:
        return fields
    for field in list(spec.required) + list(spec.optional):
        label = labels.get(field, field)
        base = f"node_{index}_{field}"
        value = node.get(field)
        if field == "aggregate":
            aggregate = node.get("aggregate", {})
            fields.append(
                {
                    "kind": "aggregate",
                    "label": label,
                    "index": index,
                    "aggregate_type": aggregate.get("type", "weighted_sum"),
                    "components": [
                        {"source": c.get("source", ""), "weight": c.get("weight", 1.0)}
                        for c in aggregate.get("components", [])
                    ],
                }
            )
        elif field == "within":
            fields.append(
                {
                    "kind": "select",
                    "label": label,
                    "name": base,
                    "value": value or "",
                    "options": sources,
                }
            )
        elif field in ("branches", "conversion"):
            fields.append(
                {
                    "kind": "json",
                    "label": label,
                    "name": f"{base}_json",
                    "value": json.dumps(value, ensure_ascii=False) if value else "",
                }
            )
        elif isinstance(value, bool):
            fields.append({"kind": "checkbox", "label": label, "name": base, "value": value})
        elif allowed.get(field):
            fields.append(
                {
                    "kind": "select",
                    "label": label,
                    "name": base,
                    "value": value if value is not None else "",
                    "options": allowed[field],
                }
            )
        elif field in ("source", "by", "minuend", "subtrahend", "from", "into", "round"):
            options = sources if field == "source" else ([value] if value else [""])
            fields.append(
                {
                    "kind": "select",
                    "label": label,
                    "name": base,
                    "value": value or "",
                    "options": options,
                }
            )
        elif field == "sources":
            fields.append(
                {
                    "kind": "text",
                    "label": label,
                    "name": base,
                    "value": ", ".join(value) if value else "",
                }
            )
        else:
            fields.append(
                {
                    "kind": "text",
                    "label": label,
                    "name": base,
                    "value": value if value is not None else "",
                }
            )
    return fields


def _build_card(node, index, sources):
    return {
        "node": node,
        "index": index,
        "type": node.get("type"),
        "sources": sources,
        "fields": _node_field_entries(node, index, sources),
    }


@staff_required
@transaction.atomic
def contest_ruleset_create(request):
    if request.method == "POST":
        activity = get_object_or_404(Activity, pk=request.POST.get("activity"))
        activity = lock_activity_for_action(activity)
        name = (request.POST.get("name") or "").strip()
        if not name:
            messages.error(request, "请填写赛制名称。")
            return redirect("staff:contest_ruleset_create")
        template = None
        template_pk = request.POST.get("template")
        if template_pk:
            template = get_object_or_404(RulesetTemplate, pk=template_pk)
        # One activity owns one ContestRuleset (versions live on RulesetVersion). If a
        # ruleset already exists, reuse it instead of creating a competing authority that
        # would make recompute_activity_result's single-authority assumption ambiguous.
        existing = ContestRuleset.objects.filter(activity=activity).first()
        if existing is not None:
            if template is not None:
                existing.source_template = template
                existing.name = name or existing.name
                existing.is_test_data = runtime_is_test(activity)
                existing.save()
                version = create_ruleset_version(
                    existing, definition=template.definition, created_by=request.user
                )
                messages.success(request, f"已将「{template.name}」克隆到该活动，进入编辑。")
            else:
                # Reuse the single authority: edit the latest DRAFT, or supersede a frozen
                # current into a fresh editing DRAFT — never redirect into a frozen version.
                draft = (
                    existing.versions.filter(status=RulesetVersion.Status.DRAFT)
                    .order_by("-version")
                    .first()
                )
                if draft is None:
                    frozen = (
                        existing.versions.filter(status=RulesetVersion.Status.FROZEN)
                        .order_by("-version")
                        .first()
                    )
                    version = (
                        supersede_ruleset_version(frozen, created_by=request.user)
                        if frozen is not None
                        else create_ruleset_version(
                            existing,
                            definition=_starter_definition(),
                            created_by=request.user,
                        )
                    )
                else:
                    version = draft
                messages.info(request, "该活动已有赛制，进入现有赛制编辑。")
            return redirect("staff:ruleset_edit", pk=version.pk)
        definition = template.definition if template else _starter_definition()
        ruleset = ContestRuleset.objects.create(
            activity=activity,
            name=name,
            source_template=template,
            is_test_data=runtime_is_test(activity),
            created_by=request.user,
        )
        version = create_ruleset_version(ruleset, definition=definition, created_by=request.user)
        messages.success(request, "赛制已创建，进入编辑。")
        return redirect("staff:ruleset_edit", pk=version.pk)
    activities = Activity.objects.all().order_by("-created_at")
    templates = RulesetTemplate.objects.all().order_by("name")
    return render(
        request,
        "staff_panel/ruleset_create.html",
        {"activities": activities, "templates": templates},
    )


@staff_required
@transaction.atomic
def ruleset_edit(request, pk):
    version = get_object_or_404(RulesetVersion, pk=pk)
    if version.status == RulesetVersion.Status.FROZEN:
        raise PermissionDenied("已冻结赛制版本不可编辑。")
    if request.method == "POST":
        try:
            current = parse_definition(version.definition)["nodes"]
            definition = _edit_nodes(request.POST, current)
            parse_definition(definition)
        except (ValueError, ValidationError) as exc:
            messages.error(request, f"保存失败：{exc}")
            return redirect("staff:ruleset_edit", pk=pk)
        try:
            update_ruleset_definition(
                version,
                definition=json.dumps(definition, ensure_ascii=False),
                operator=request.user,
                base_content_hash=request.POST.get("base_content_hash") or None,
            )
        except ValidationError as exc:
            messages.error(request, str(exc))
            return redirect("staff:ruleset_edit", pk=pk)
        messages.success(request, "赛制已保存。")
        return redirect("staff:ruleset_edit", pk=pk)
    try:
        nodes = parse_definition(version.definition)["nodes"]
    except ValidationError:
        nodes = []
    cards = [
        _build_card(node, i, ruleset_editor.available_sources(nodes, i))
        for i, node in enumerate(nodes)
    ]
    ruleset = version.ruleset
    return render(
        request,
        "staff_panel/ruleset_editor.html",
        {
            "version": version,
            "ruleset": ruleset,
            "cards": cards,
            # §28 capability matrix: BRANCH/AWARD are rejected at compile
            # (NODE_UNSUPPORTED_RUNTIME) and must not be offered in the editor.
            "node_types": sorted(t for t in NODE_TYPE_SPEC if t not in ("BRANCH", "AWARD")),
            "binding_json": {
                "round_keys": json.dumps(ruleset.round_keys or {}, ensure_ascii=False),
                "vote_keys": json.dumps(ruleset.vote_keys or {}, ensure_ascii=False),
                "group_keys": json.dumps(ruleset.group_keys or {}, ensure_ascii=False),
                "audience_keys": json.dumps(ruleset.audience_keys or {}, ensure_ascii=False),
                "announcement_blocks": json.dumps(
                    ruleset.announcement_blocks or [], ensure_ascii=False
                ),
                "announcement_blocks_by_checkpoint": json.dumps(
                    ruleset.announcement_blocks_by_checkpoint or {},
                    ensure_ascii=False,
                ),
            },
            "binding_signature": _binding_signature(ruleset),
        },
    )


@staff_required
@require_POST
@transaction.atomic
def ruleset_bind(request, pk):
    """Save the activity-owning binding (stage/round/vote/group/announcement) to a ruleset (§32).

    Only the editable input surface (ContestRuleset) is written here; the snapshot runs at
    freeze time via ``_snapshot_binding``.
    """
    version = get_object_or_404(RulesetVersion, pk=pk)
    lock_activity_for_action(version.ruleset.activity)

    def _parse_json(name, empty):
        raw = (request.POST.get(name) or "").strip()
        if not raw:
            return empty
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise ValidationError(f"{name} 不是合法 JSON。")

    try:
        update_ruleset_binding(
            version.ruleset,
            binding={
                "stage_key": request.POST.get("stage_key"),
                "round_keys": _parse_json("round_keys", {}),
                "vote_keys": _parse_json("vote_keys", {}),
                "group_keys": _parse_json("group_keys", {}),
                "audience_keys": _parse_json("audience_keys", {}),
                "announcement_blocks": _parse_json("announcement_blocks", []),
                "announcement_blocks_by_checkpoint": _parse_json(
                    "announcement_blocks_by_checkpoint", {}
                ),
            },
            operator=request.user,
            base_binding=request.POST.get("base_binding") or None,
        )
    except ValidationError as exc:
        messages.error(request, "；".join(exc.messages))
        return redirect("staff:ruleset_edit", pk=pk)
    except PermissionDenied as exc:
        messages.error(request, str(exc))
        return redirect("staff:ruleset_edit", pk=pk)
    messages.success(request, "生产绑定已保存。")
    return redirect("staff:ruleset_edit", pk=pk)


@staff_required
def ruleset_validate(request, pk):
    version = get_object_or_404(RulesetVersion, pk=pk)
    report, plan = compile_definition(version.definition)
    return render(
        request,
        "staff_panel/ruleset_validate.html",
        {
            "version": version,
            "passes": report.passes(),
            "issues": [i.to_dict() for i in report.issues],
            "counts": report.counts(),
            "summary": plan.summary if plan else None,
        },
    )


@staff_required
def ruleset_preview(request, pk):
    version = get_object_or_404(RulesetVersion, pk=pk)
    report, plan, result = ruleset_editor.preview_definition(version.definition)
    return render(
        request,
        "staff_panel/ruleset_preview.html",
        {
            "version": version,
            "passes": report.passes(),
            "issues": [i.to_dict() for i in report.issues],
            "summary": plan.summary if plan else None,
            "status": result.status.value if result else "—",
            "node_values": result.node_values if result else None,
            "decisions": [d.to_dict() for d in result.decisions][:20] if result else None,
        },
    )


@staff_required
@require_POST
def ruleset_freeze(request, pk):
    version = get_object_or_404(RulesetVersion, pk=pk)
    try:
        freeze_ruleset_version(version, request.user)
    except PermissionDenied as exc:
        messages.error(request, str(exc))
    except RulesetInvalidError as exc:
        errors = [i.message for i in exc.report.issues if i.severity.value == "error"]
        messages.error(request, "赛制排版未通过校验：" + ("；".join(errors) or "存在 ERROR"))
    except ValidationError as exc:
        messages.error(request, "；".join(exc.messages))
    else:
        messages.success(request, "赛制已冻结。")
    return redirect("staff:ruleset_edit", pk=pk)


@staff_required
@require_POST
@transaction.atomic
def ruleset_clone_from_template(request, template_pk):
    template = get_object_or_404(RulesetTemplate, pk=template_pk)
    activity = get_object_or_404(Activity, pk=request.POST.get("activity"))
    activity = lock_activity_for_action(activity)
    name = (request.POST.get("name") or "").strip() or template.name
    ruleset, _created = ContestRuleset.objects.get_or_create(
        activity=activity,
        defaults={
            "name": name,
            "source_template": template,
            "is_test_data": runtime_is_test(activity),
            "created_by": request.user,
        },
    )
    ruleset.name = name
    ruleset.source_template = template
    ruleset.is_test_data = runtime_is_test(activity)
    ruleset.save()
    version = create_ruleset_version(
        ruleset, definition=template.definition, created_by=request.user
    )
    messages.success(request, f"已从「{template.name}」克隆到活动，进入编辑。")
    return redirect("staff:ruleset_edit", pk=version.pk)


@staff_required
@require_POST
def ruleset_clone_last_year(request):
    template = get_object_or_404(RulesetTemplate, name="院十佳")
    return ruleset_clone_from_template(request, template.pk)
