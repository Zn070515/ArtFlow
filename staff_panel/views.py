import io
import zipfile

from accounts.decorators import admin_required, staff_required
from archive.models import ArchivePackage
from common.audit import log_action
from common.business_rules import (
    ensure_activity_unlocked,
    ensure_round_unlocked,
    ensure_same_activity,
    ensure_vote_session_unlocked,
)
from common.models import AuditLog
from common.test_data import (
    clear_activity_test_data,
    leave_test_mode,
    lock_activity_for_runtime_data,
)
from core.models import Activity
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
from farewell_show.models import Program
from files.models import MaterialCheck, MaterialRequirement, StaffNote, SubmissionFile
from files.services import (
    store_submission_file,
    sync_program_material_checks,
    sync_singer_material_checks,
)
from incidents.models import IncidentRecord
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
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
    expected_score_cells,
    missing_score_cells,
    parse_score_workbook,
    prepare_round,
)
from voting.models import VoteOption, VoteRecord, VoteSession


def _choices(enum_class):
    return enum_class.choices


def _require_admin(user):
    if not user.is_admin:
        raise PermissionDenied("Only admins can manage this resource.")


def _active_worksheet(workbook):
    worksheet = workbook.active
    if not isinstance(worksheet, Worksheet):
        raise ValueError("The active workbook sheet must be a worksheet.")
    return worksheet


def _get_activity_form_data(request):
    data = {
        "title": request.POST.get("title", "").strip(),
        "subtitle": request.POST.get("subtitle", "").strip(),
        "activity_type": request.POST.get("activity_type", Activity.Type.GENERAL),
        "phase": request.POST.get("phase", Activity.Phase.DRAFT),
        "description": request.POST.get("description", "").strip(),
        "is_test_mode": request.POST.get("is_test_mode") == "on",
    }
    errors = []
    if not data["title"]:
        errors.append("活动标题不能为空")
    return data, errors


def _get_post_form_data(request):
    """Extract and validate post form data from request, returns (data, errors)."""
    data = {}
    errors = []

    title = request.POST.get("title", "").strip()
    if not title:
        errors.append("标题不能为空")
    data["title"] = title

    data["subtitle"] = request.POST.get("subtitle", "").strip()
    data["content"] = request.POST.get("content", "").strip()
    data["post_type"] = request.POST.get("post_type", PublicPost.PostType.NORMAL_ARTICLE)
    data["status"] = request.POST.get("status", PublicPost.Status.DRAFT)
    data["is_pinned"] = request.POST.get("is_pinned", "") == "on"
    data["related_activity_id"] = request.POST.get("related_activity_id") or None

    sort_str = request.POST.get("sort_order", "0").strip()
    try:
        data["sort_order"] = int(sort_str) if sort_str else 0
    except ValueError:
        data["sort_order"] = 0

    return data, errors


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
        data, errors = _get_activity_form_data(request)
        if errors:
            return render(
                request,
                "staff_panel/activity_form.html",
                {
                    "error": errors[0],
                    "activity_types": _choices(Activity.Type),
                    "phases": _choices(Activity.Phase),
                    "data": data,
                },
            )
        activity = Activity.objects.create(**data)
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
            "phases": _choices(Activity.Phase),
        },
    )


@admin_required
def activity_edit(request, pk):
    _require_admin(request.user)
    activity = get_object_or_404(Activity, pk=pk)
    if request.method == "POST":
        data, errors = _get_activity_form_data(request)
        if errors:
            return render(
                request,
                "staff_panel/activity_form.html",
                {
                    "error": errors[0],
                    "activity": activity,
                    "activity_types": _choices(Activity.Type),
                    "phases": _choices(Activity.Phase),
                    "data": data,
                },
            )
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
        data, errors = _get_post_form_data(request)
        if errors:
            return render(
                request,
                "staff_panel/post_form.html",
                {
                    "error": errors[0],
                    "post_types": _choices(PublicPost.PostType),
                    "statuses": _choices(PublicPost.Status),
                    "activities": Activity.objects.all(),
                },
            )
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
        data, errors = _get_post_form_data(request)
        if errors:
            return render(
                request,
                "staff_panel/post_form.html",
                {
                    "error": errors[0],
                    "post": post,
                    "post_types": _choices(PublicPost.PostType),
                    "statuses": _choices(PublicPost.Status),
                    "activities": Activity.objects.all(),
                },
            )
        old_value = f"status={post.status}; title={post.title}"
        related_activity = None
        if data["related_activity_id"]:
            related_activity = get_object_or_404(Activity, pk=data["related_activity_id"])
        ensure_activity_unlocked(related_activity or post.related_activity)
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
    return render(
        request,
        "staff_panel/singer_registration_list.html",
        {
            "registrations": registrations,
        },
    )


@staff_required
def singer_registration_detail(request, pk):
    reg = get_object_or_404(SingerRegistration.objects.select_related("activity", "user"), pk=pk)
    errors = []
    if request.method == "POST":
        ensure_activity_unlocked(reg.activity)
        if "upload_file" in request.POST:
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
            old_value = f"pre={reg.pre_status}; live={reg.live_status}"
            if "pre_status" in request.POST:
                reg.pre_status = request.POST["pre_status"]
            if "live_status" in request.POST:
                reg.live_status = request.POST["live_status"]
            if "staff_note" in request.POST:
                note = request.POST["staff_note"].strip()
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
    return render(request, "staff_panel/program_list.html", {"programs": programs})


@staff_required
def program_detail(request, pk):
    prog = get_object_or_404(Program.objects.select_related("activity", "user"), pk=pk)
    errors = []
    if request.method == "POST":
        ensure_activity_unlocked(prog.activity)
        if "upload_file" in request.POST:
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
            old_value = f"status={prog.status}; sort_order={prog.sort_order}"
            if "status" in request.POST:
                prog.status = request.POST["status"]
            if "sort_order" in request.POST:
                try:
                    prog.sort_order = int(request.POST["sort_order"])
                except ValueError:
                    pass
            if "staff_note" in request.POST:
                note = request.POST["staff_note"].strip()
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


# --- Excel export ---


@staff_required
def export_registrations(request):
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
    for r in SingerRegistration.objects.filter(is_test_data=False).select_related("activity"):
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
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = "attachment; filename=registration_list.xlsx"
    wb.save(response)
    return response


@staff_required
def export_programs(request):
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
    for p in Program.objects.filter(is_test_data=False).select_related("activity"):
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
        activity = get_object_or_404(Activity, pk=request.POST["activity_id"])
        ensure_activity_unlocked(activity)
        contest_round = ContestRound.objects.create(
            activity=activity,
            round_type=request.POST["round_type"],
            scoring_mode=request.POST.get("scoring_mode", ContestRound.ScoringMode.AVERAGE),
            name=request.POST.get("name", ""),
            advance_count=int(request.POST.get("advance_count", 0) or 0),
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
@transaction.atomic
def round_lock(request, pk):
    contest_round = get_object_or_404(
        ContestRound.objects.select_for_update().select_related("activity"), pk=pk
    )
    if (
        contest_round.status
        not in {
            ContestRound.Status.PREPARED,
            ContestRound.Status.SCORING,
        }
        or contest_round.is_locked
    ):
        raise PermissionDenied("该比赛轮次已锁定。")
    if not expected_score_cells(contest_round):
        raise PermissionDenied("当前轮次没有可锁定的完整评分矩阵。")
    missing_cells = missing_score_cells(contest_round)
    if missing_cells:
        raise PermissionDenied("仍有未完成的评委评分，不能锁定结果。")
    contest_round.is_locked = True
    contest_round.status = ContestRound.Status.LOCKED
    contest_round.save(update_fields=["is_locked", "status"])
    log_action(request, AuditLog.ActionType.RELOCK_RESULT, f"ContestRound:{contest_round.pk}")
    return redirect("staff:round_ranking", pk=pk)


@admin_required
@require_POST
@transaction.atomic
def round_unlock(request, pk):
    _require_admin(request.user)
    contest_round = get_object_or_404(
        ContestRound.objects.select_for_update().select_related("activity"), pk=pk
    )
    note = request.POST.get("note", "").strip()
    if not note:
        raise PermissionDenied("解锁结果必须填写原因。")
    if contest_round.status != ContestRound.Status.LOCKED or not contest_round.is_locked:
        raise PermissionDenied("该比赛轮次未锁定。")
    contest_round.is_locked = False
    contest_round.status = ContestRound.Status.SCORING
    contest_round.save(update_fields=["is_locked", "status"])
    log_action(
        request,
        AuditLog.ActionType.UNLOCK_RESULT,
        f"ContestRound:{contest_round.pk}",
        note=note,
    )
    return redirect("staff:round_ranking", pk=pk)


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
        singer_id = request.POST.get("singer_id")
        if singer_id:
            singer = get_object_or_404(SingerRegistration, pk=singer_id)
            ensure_same_activity(activity, singer, label="Award singer")
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
    singers = SingerRegistration.objects.filter(
        pre_status=SingerRegistration.PreStatus.APPROVED,
        is_test_data=False,
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
        activity = get_object_or_404(Activity, pk=request.POST["activity_id"])
        activity = lock_activity_for_runtime_data(activity)
        ensure_activity_unlocked(activity)
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
        vote_session = VoteSession.objects.create(
            activity=activity,
            name=request.POST["name"],
            passcode=request.POST["passcode"],
            start_time=request.POST["start_time"],
            end_time=request.POST["end_time"],
            selection_type=request.POST.get("selection_type", VoteSession.SelectionType.SINGLE),
            max_selections=int(request.POST.get("max_selections", 1) or 1),
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
    singers = SingerRegistration.objects.filter(
        pre_status=SingerRegistration.PreStatus.APPROVED,
        is_test_data=False,
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
    return render(
        request,
        "staff_panel/vote_session_detail.html",
        {
            "vote_session": vote_session,
            "options": options,
            "total_votes": total_votes,
        },
    )


@staff_required
@require_POST
def vote_session_toggle(request, pk):
    vote_session = get_object_or_404(VoteSession, pk=pk)
    ensure_vote_session_unlocked(vote_session)
    old_value = f"is_open={vote_session.is_open}"
    vote_session.is_open = not vote_session.is_open
    vote_session.save()
    log_action(
        request,
        AuditLog.ActionType.VOTE_MANAGE,
        f"VoteSession:{vote_session.pk}",
        old_value=old_value,
        new_value=f"is_open={vote_session.is_open}",
    )
    return redirect("staff:vote_session_detail", pk=pk)


@staff_required
@require_POST
@transaction.atomic
def vote_session_lock(request, pk):
    vote_session = get_object_or_404(VoteSession, pk=pk)
    vote_session.is_locked = True
    vote_session.is_open = False
    vote_session.save()
    _generate_popularity_award(vote_session)
    log_action(request, AuditLog.ActionType.RELOCK_RESULT, f"VoteSession:{vote_session.pk}")
    return redirect("staff:vote_session_detail", pk=pk)


@admin_required
@require_POST
def vote_session_unlock(request, pk):
    _require_admin(request.user)
    vote_session = get_object_or_404(VoteSession, pk=pk)
    note = request.POST.get("note", "").strip()
    if not note:
        raise PermissionDenied("解锁投票必须填写原因。")
    vote_session.is_locked = False
    vote_session.save()
    log_action(
        request,
        AuditLog.ActionType.UNLOCK_RESULT,
        f"VoteSession:{vote_session.pk}",
        note=note,
    )
    return redirect("staff:vote_session_detail", pk=pk)


@staff_required
def vote_session_export(request, pk):
    vote_session = get_object_or_404(VoteSession, pk=pk)
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "投票结果"
    ws.append(["选手", "票数"])
    from django.db.models import Count

    options = vote_session.options.select_related("singer").annotate(vote_count=Count("records"))
    for opt in options:
        ws.append([opt.singer.name, opt.vote_count])
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = f"attachment; filename=vote_result_{vote_session.pk}.xlsx"
    wb.save(response)
    return response


def _generate_popularity_award(vote_session):
    from django.db import transaction
    from django.db.models import Count

    winner = (
        vote_session.options.select_related("singer")
        .annotate(vote_count=Count("records"))
        .filter(vote_count__gt=0)
        .order_by("-vote_count", "sort_order", "pk")
        .first()
    )
    if not winner:
        return None
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
    return award


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
        singer_registration__is_test_data=False,
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
    for c in MaterialCheck.objects.filter(
        singer_registration__activity=activity,
        singer_registration__is_test_data=False,
    ).select_related("singer_registration"):
        ws.append(
            [
                "singer",
                c.singer_registration.name if c.singer_registration else "",
                c.item_name,
                c.get_status_display(),
            ]
        )
    for c in MaterialCheck.objects.filter(
        program__activity=activity,
        program__is_test_data=False,
    ).select_related("program"):
        ws.append(
            [
                "program",
                c.program.name if c.program else "",
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
def excel_score_template(request, round_id):
    contest_round = get_object_or_404(ContestRound, pk=round_id)
    singers = _eligible_singers(contest_round)
    judges = _active_judges(contest_round)
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "评分表模板"
    header = ["选手\\评委"] + [j.name for j in judges]
    ws.append(header)
    for singer in singers:
        ws.append([singer.name] + ["" for _ in judges])
    for col_idx, judge in enumerate(judges, 2):
        ws.cell(row=1, column=col_idx).font = Font(bold=True)
        ws.cell(row=1, column=col_idx).alignment = Alignment(horizontal="center")
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
    singers = SingerRegistration.objects.filter(
        activity=activity,
        pre_status=SingerRegistration.PreStatus.APPROVED,
        is_test_data=False,
    )
    singer_lines = "\n".join(f"{s.name} — {s.song_name}" for s in singers)
    programs = Program.objects.filter(activity=activity, is_test_data=False)
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
    AuditLog.objects.create(
        operator=request.user,
        action_type=AuditLog.ActionType.EXPORT,
        target=f"生成Word: {template.name}",
    )
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
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for label, gen in _complete_activity_excel_generators(activity):
            wb = gen()
            stream = io.BytesIO()
            wb.save(stream)
            zf.writestr(f"{label}.xlsx", stream.getvalue())
    buf.seek(0)
    response = HttpResponse(buf.read(), content_type="application/zip")
    response["Content-Disposition"] = f"attachment; filename=execution_{activity_id}.zip"
    return response


@staff_required
@require_POST
def archive_package_create(request, activity_id):
    activity = get_object_or_404(Activity, pk=activity_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for label, gen in _complete_activity_excel_generators(activity):
            wb = gen()
            stream = io.BytesIO()
            wb.save(stream)
            zf.writestr(f"{label}.xlsx", stream.getvalue())
        # Include generated docs
        for doc in GeneratedDocument.objects.filter(activity=activity, is_test_data=False):
            if doc.file:
                with doc.file.open("rb") as document_file:
                    zf.writestr(f"推文_{doc.pk}.docx", document_file.read())
    buf.seek(0)
    package = ArchivePackage.objects.create(
        activity=activity,
        includes=", ".join(label for label, _ in _complete_activity_excel_generators(activity)),
        note="Generated archive package",
        created_by=request.user,
    )
    package.file.save(f"archive_{activity_id}.zip", ContentFile(buf.getvalue()))
    AuditLog.objects.create(
        operator=request.user,
        action_type=AuditLog.ActionType.ARCHIVE_ACTIVITY,
        target=f"归档: {activity.title}",
    )
    response = HttpResponse(buf.read(), content_type="application/zip")
    response["Content-Disposition"] = f"attachment; filename=archive_{activity_id}.zip"
    return response


def _activity_excel_generators(activity):
    """Yield (label, callable returning Workbook) for common exports."""

    def _registration_list():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "报名名单"
        ws.append(["姓名", "学号", "学院", "班级", "手机", "微信", "曲目", "原创", "赛前状态"])
        for r in SingerRegistration.objects.filter(activity=activity, is_test_data=False):
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
                ]
            )
        return wb

    def _material_checklist():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "材料清单"
        ws.append(["姓名", "项目", "状态"])
        for c in MaterialCheck.objects.filter(
            singer_registration__activity=activity,
            singer_registration__is_test_data=False,
        ):
            ws.append(
                [
                    c.singer_registration.name if c.singer_registration else "",
                    c.item_name,
                    c.get_status_display(),
                ]
            )
        return wb

    def _incidents():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "异常记录"
        ws.append(["时间", "类型", "选手", "处理人", "处理结果", "备注"])
        for inc in IncidentRecord.objects.filter(activity=activity, is_test=False):
            ws.append(
                [
                    inc.occurred_at.strftime("%m/%d %H:%M"),
                    inc.get_event_type_display(),
                    inc.singer.name if inc.singer else "",
                    inc.handled_by.username if inc.handled_by else "",
                    inc.resolution,
                    inc.remark,
                ]
            )
        return wb

    def _staff_notes():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "工作人员备注"
        ws.append(["关联", "内容", "创建人", "时间"])
        for n in StaffNote.objects.filter(
            singer_registration__activity=activity,
            singer_registration__is_test_data=False,
        ).select_related("created_by"):
            ws.append(
                [
                    f"选手: {n.singer_registration.name}" if n.singer_registration else "",
                    n.content,
                    n.created_by.username if n.created_by else "",
                    n.created_at.strftime("%m/%d %H:%M"),
                ]
            )
        return wb

    def _contacts():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "联系方式表"
        ws.append(["姓名", "学号", "手机", "微信", "学院", "班级", "曲目"])
        for r in SingerRegistration.objects.filter(activity=activity, is_test_data=False):
            ws.append(
                [r.name, r.student_id, r.phone, r.wechat, r.college, r.class_name, r.song_name]
            )
        return wb

    return [
        ("报名名单", _registration_list),
        ("材料清单", _material_checklist),
        ("联系方式表", _contacts),
        ("异常记录", _incidents),
        ("工作人员备注", _staff_notes),
    ]


def _autosize_sheet(ws):
    for column in ws.columns:
        letter = column[0].column_letter
        width = max(len(str(cell.value or "")) for cell in column)
        ws.column_dimensions[letter].width = min(max(width + 2, 10), 36)


def _complete_activity_excel_generators(activity):
    """Yield stable workbook exports for execution and archive packages."""

    def _registration_list():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "Registration List"
        ws.append(
            [
                "Name",
                "Student ID",
                "College",
                "Class",
                "Phone",
                "Wechat",
                "Song",
                "Original",
                "Pre Status",
                "Live Status",
            ]
        )
        for r in SingerRegistration.objects.filter(activity=activity, is_test_data=False):
            ws.append(
                [
                    r.name,
                    r.student_id,
                    r.college,
                    r.class_name,
                    r.phone,
                    r.wechat,
                    r.song_name,
                    "yes" if r.is_original else "no",
                    r.get_pre_status_display(),
                    r.get_live_status_display(),
                ]
            )
        _autosize_sheet(ws)
        return wb

    def _program_list():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "Program List"
        ws.append(
            [
                "Order",
                "Name",
                "Type",
                "Contact",
                "Phone",
                "Class/Dept",
                "Performers",
                "Duration",
                "Status",
                "Mic",
                "Props",
                "Notes",
            ]
        )
        for p in Program.objects.filter(activity=activity, is_test_data=False):
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
                    p.get_status_display(),
                    p.mic_requirements,
                    p.prop_requirements,
                    p.special_notes,
                ]
            )
        _autosize_sheet(ws)
        return wb

    def _material_checklist():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "Material Checklist"
        ws.append(["Owner Type", "Owner", "Item", "Status"])
        for c in MaterialCheck.objects.filter(
            singer_registration__activity=activity, singer_registration__is_test_data=False
        ).select_related("singer_registration"):
            ws.append(
                [
                    "singer",
                    c.singer_registration.name if c.singer_registration else "",
                    c.item_name,
                    c.get_status_display(),
                ]
            )
        for c in MaterialCheck.objects.filter(
            program__activity=activity, program__is_test_data=False
        ).select_related("program"):
            ws.append(
                [
                    "program",
                    c.program.name if c.program else "",
                    c.item_name,
                    c.get_status_display(),
                ]
            )
        _autosize_sheet(ws)
        return wb

    def _contact_list():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "Contacts"
        ws.append(["Owner Type", "Name", "Student ID", "Phone", "Wechat", "College/Class", "Item"])
        for r in SingerRegistration.objects.filter(activity=activity, is_test_data=False):
            ws.append(
                [
                    "singer",
                    r.name,
                    r.student_id,
                    r.phone,
                    r.wechat,
                    f"{r.college} {r.class_name}",
                    r.song_name,
                ]
            )
        for p in Program.objects.filter(activity=activity, is_test_data=False):
            ws.append(["program", p.contact_name, "", p.contact_phone, "", p.class_name, p.name])
        _autosize_sheet(ws)
        return wb

    def _score_results():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "Score Results"
        ws.append(["Round", "Singer", "Average Score", "Rank", "Advanced"])
        summaries = (
            ScoreSummary.objects.filter(round__activity=activity, is_test_data=False)
            .select_related("round", "singer")
            .order_by("round_id", "rank")
        )
        for s in summaries:
            ws.append(
                [
                    s.round.name or s.round.get_round_type_display(),
                    s.singer.name,
                    s.average_score,
                    s.rank,
                    "yes" if s.is_advanced else "no",
                ]
            )
        _autosize_sheet(ws)
        return wb

    def _vote_results():
        from django.db.models import Count

        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "Vote Results"
        ws.append(["Session", "Singer", "Song", "Votes"])
        options = (
            VoteOption.objects.filter(
                vote_session__activity=activity, vote_session__is_test_data=False
            )
            .select_related("vote_session", "singer")
            .annotate(vote_count=Count("records"))
        )
        for opt in options:
            ws.append(
                [opt.vote_session.name, opt.singer.name, opt.singer.song_name, opt.vote_count]
            )
        _autosize_sheet(ws)
        return wb

    def _award_list():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "Awards"
        ws.append(["Singer", "Song", "Award"])
        for award in Award.objects.filter(activity=activity, is_test_data=False).select_related(
            "singer"
        ):
            ws.append([award.singer.name, award.singer.song_name, award.name])
        _autosize_sheet(ws)
        return wb

    def _attachment_index():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "Attachment Index"
        ws.append(
            [
                "Owner Type",
                "Owner",
                "Purpose",
                "Original Name",
                "Size",
                "Uploaded By",
                "Uploaded At",
                "Current",
                "Public",
            ]
        )
        singer_files = SubmissionFile.objects.filter(
            singer_registration__activity=activity,
            singer_registration__is_test_data=False,
            is_test_data=False,
        ).select_related("singer_registration", "uploaded_by")
        for f in singer_files:
            ws.append(
                [
                    "singer",
                    f.singer_registration.name if f.singer_registration else "",
                    f.get_file_purpose_display(),
                    f.original_name,
                    f.file_size,
                    f.uploaded_by.username if f.uploaded_by else "",
                    f.uploaded_at.strftime("%Y-%m-%d %H:%M"),
                    "yes" if f.is_current else "no",
                    "yes" if f.is_public else "no",
                ]
            )
        program_files = SubmissionFile.objects.filter(
            program__activity=activity, program__is_test_data=False, is_test_data=False
        ).select_related("program", "uploaded_by")
        for f in program_files:
            ws.append(
                [
                    "program",
                    f.program.name if f.program else "",
                    f.get_file_purpose_display(),
                    f.original_name,
                    f.file_size,
                    f.uploaded_by.username if f.uploaded_by else "",
                    f.uploaded_at.strftime("%Y-%m-%d %H:%M"),
                    "yes" if f.is_current else "no",
                    "yes" if f.is_public else "no",
                ]
            )
        _autosize_sheet(ws)
        return wb

    def _public_content_index():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "Public Content"
        ws.append(["Title", "Type", "Status", "Pinned", "Published At", "Updated By"])
        for post in PublicPost.objects.filter(related_activity=activity).select_related(
            "updated_by"
        ):
            ws.append(
                [
                    post.title,
                    post.get_post_type_display(),
                    post.get_status_display(),
                    "yes" if post.is_pinned else "no",
                    post.published_at.strftime("%Y-%m-%d %H:%M") if post.published_at else "",
                    post.updated_by.username if post.updated_by else "",
                ]
            )
        _autosize_sheet(ws)
        return wb

    def _incident_list():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "Incidents"
        ws.append(["Time", "Type", "Singer", "Program", "Handler", "Resolution", "Remark"])
        for inc in IncidentRecord.objects.filter(activity=activity, is_test=False).select_related(
            "singer", "program", "handled_by"
        ):
            ws.append(
                [
                    inc.occurred_at.strftime("%Y-%m-%d %H:%M"),
                    inc.get_event_type_display(),
                    inc.singer.name if inc.singer else "",
                    inc.program.name if inc.program else "",
                    inc.handled_by.username if inc.handled_by else "",
                    inc.resolution,
                    inc.remark,
                ]
            )
        _autosize_sheet(ws)
        return wb

    def _staff_notes():
        wb = Workbook()
        ws = _active_worksheet(wb)
        ws.title = "Staff Notes"
        ws.append(["Owner Type", "Owner", "Content", "Created By", "Time"])
        singer_notes = StaffNote.objects.filter(
            singer_registration__activity=activity, singer_registration__is_test_data=False
        ).select_related("singer_registration", "created_by")
        for n in singer_notes:
            ws.append(
                [
                    "singer",
                    n.singer_registration.name if n.singer_registration else "",
                    n.content,
                    n.created_by.username if n.created_by else "",
                    n.created_at.strftime("%Y-%m-%d %H:%M"),
                ]
            )
        program_notes = StaffNote.objects.filter(
            program__activity=activity, program__is_test_data=False
        ).select_related("program", "created_by")
        for n in program_notes:
            ws.append(
                [
                    "program",
                    n.program.name if n.program else "",
                    n.content,
                    n.created_by.username if n.created_by else "",
                    n.created_at.strftime("%Y-%m-%d %H:%M"),
                ]
            )
        _autosize_sheet(ws)
        return wb

    return [
        ("registration_list", _registration_list),
        ("program_list", _program_list),
        ("material_checklist", _material_checklist),
        ("contact_list", _contact_list),
        ("score_results", _score_results),
        ("vote_results", _vote_results),
        ("award_list", _award_list),
        ("attachment_index", _attachment_index),
        ("public_content_index", _public_content_index),
        ("incident_list", _incident_list),
        ("staff_notes", _staff_notes),
    ]


# --- Incident records ---


@staff_required
def incident_list(request):
    incidents = IncidentRecord.objects.select_related("activity", "singer", "handled_by")
    return render(request, "staff_panel/incident_list.html", {"incidents": incidents})


@staff_required
@transaction.atomic
def incident_create(request):
    if request.method == "POST":
        activity = get_object_or_404(Activity, pk=request.POST["activity_id"])
        activity = lock_activity_for_runtime_data(activity)
        ensure_activity_unlocked(activity)
        singer = None
        if request.POST.get("singer_id"):
            singer = get_object_or_404(SingerRegistration, pk=request.POST["singer_id"])
            ensure_same_activity(activity, singer, label="Incident singer")
        program = None
        if request.POST.get("program_id"):
            program = get_object_or_404(Program, pk=request.POST["program_id"])
            ensure_same_activity(activity, program, label="Incident program")
        incident = IncidentRecord.objects.create(
            activity=activity,
            occurred_at=request.POST["occurred_at"],
            event_type=request.POST.get("event_type", IncidentRecord.EventType.OTHER),
            singer=singer,
            program=program,
            handled_by_id=request.user.pk,
            resolution=request.POST.get("resolution", ""),
            remark=request.POST.get("remark", ""),
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
    singers = SingerRegistration.objects.filter(pre_status=SingerRegistration.PreStatus.APPROVED)
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
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "异常记录"
    ws.append(["活动", "时间", "类型", "选手", "处理人", "处理结果", "备注"])
    for inc in IncidentRecord.objects.filter(is_test=False).select_related(
        "activity", "singer", "handled_by"
    ):
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
    if not note:
        raise PermissionDenied("解锁活动必须填写原因。")
    activity = get_object_or_404(Activity.objects.select_for_update(), pk=pk)
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
    for vote_session in VoteSession.objects.filter(activity=original):
        VoteSession.objects.create(
            activity=new_activity,
            name=vote_session.name,
            passcode=vote_session.passcode,
            start_time=vote_session.start_time,
            end_time=vote_session.end_time,
            is_open=False,
            is_locked=False,
            selection_type=vote_session.selection_type,
            max_selections=vote_session.max_selections,
            is_test_data=True,
        )
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
