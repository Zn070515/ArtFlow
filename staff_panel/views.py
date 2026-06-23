from django.contrib.admin.views.decorators import staff_member_required
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from openpyxl import Workbook

from files.models import MaterialCheck, StaffNote, SubmissionFile
from farewell_show.models import Program
from public_portal.models import PublicPost
from singer_contest.models import Award, ContestRound, Judge, ScoreRecord, ScoreSummary, SingerRegistration


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

    sort_str = request.POST.get("sort_order", "0").strip()
    try:
        data["sort_order"] = int(sort_str) if sort_str else 0
    except ValueError:
        data["sort_order"] = 0

    return data, errors


@staff_member_required
def dashboard(request):
    return render(request, "staff_panel/dashboard.html")


@staff_member_required
def post_list(request):
    posts = PublicPost.objects.all()
    return render(request, "staff_panel/post_list.html", {"posts": posts})


@staff_member_required
def post_create(request):
    if request.method == "POST":
        data, errors = _get_post_form_data(request)
        if errors:
            return render(request, "staff_panel/post_form.html", {
                "error": errors[0],
                "post_types": PublicPost.PostType,
                "statuses": PublicPost.Status,
            })
        post = PublicPost(
            title=data["title"],
            subtitle=data["subtitle"],
            content=data["content"],
            post_type=data["post_type"],
            status=data["status"],
            sort_order=data["sort_order"],
            created_by=request.user,
            updated_by=request.user,
        )
        if request.FILES.get("cover_image"):
            post.cover_image = request.FILES["cover_image"]
        if data["status"] == PublicPost.Status.PUBLISHED:
            post.published_at = timezone.now()
        post.save()
        return redirect("staff:post_list")
    return render(request, "staff_panel/post_form.html", {
        "post_types": PublicPost.PostType,
        "statuses": PublicPost.Status,
    })


@staff_member_required
def post_edit(request, pk):
    post = get_object_or_404(PublicPost, pk=pk)
    if request.method == "POST":
        data, errors = _get_post_form_data(request)
        if errors:
            return render(request, "staff_panel/post_form.html", {
                "error": errors[0],
                "post": post,
                "post_types": PublicPost.PostType,
                "statuses": PublicPost.Status,
            })
        post.title = data["title"]
        post.subtitle = data["subtitle"]
        post.content = data["content"]
        post.post_type = data["post_type"]
        old_status = post.status
        post.status = data["status"]
        post.sort_order = data["sort_order"]
        post.updated_by = request.user
        if request.FILES.get("cover_image"):
            post.cover_image = request.FILES["cover_image"]
        if data["status"] == PublicPost.Status.PUBLISHED and not post.published_at:
            post.published_at = timezone.now()
        elif data["status"] != PublicPost.Status.PUBLISHED and old_status == PublicPost.Status.PUBLISHED:
            post.published_at = None
        post.save()
        return redirect("staff:post_list")
    return render(request, "staff_panel/post_form.html", {
        "post": post,
        "post_types": PublicPost.PostType,
        "statuses": PublicPost.Status,
    })


# --- Singer registration management ---


@staff_member_required
def singer_registration_list(request):
    registrations = SingerRegistration.objects.select_related("activity", "user")
    return render(request, "staff_panel/singer_registration_list.html", {
        "registrations": registrations,
    })


@staff_member_required
def singer_registration_detail(request, pk):
    reg = get_object_or_404(SingerRegistration.objects.select_related("activity", "user"), pk=pk)
    if request.method == "POST":
        if "upload_file" in request.POST:
            f = request.FILES.get("file")
            if f:
                SubmissionFile.objects.create(
                    singer_registration=reg,
                    file=f,
                    original_name=f.name,
                    file_size=f.size,
                    file_purpose=request.POST.get("file_purpose", SubmissionFile.Purpose.OTHER),
                    uploaded_by=request.user,
                )
        else:
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
        return redirect("staff:singer_registration_detail", pk=reg.pk)
    notes = reg.staff_notes.select_related("created_by")
    files = reg.files.all()
    checks = reg.material_checks.all()
    return render(request, "staff_panel/singer_registration_detail.html", {
        "reg": reg,
        "pre_statuses": SingerRegistration.PreStatus,
        "live_statuses": SingerRegistration.LiveStatus,
        "notes": notes,
        "files": files,
        "checks": checks,
        "check_statuses": MaterialCheck.Status,
        "file_purposes": SubmissionFile.Purpose,
    })


# --- Program management ---


@staff_member_required
def program_list(request):
    programs = Program.objects.select_related("activity", "user")
    return render(request, "staff_panel/program_list.html", {"programs": programs})


@staff_member_required
def program_detail(request, pk):
    prog = get_object_or_404(Program.objects.select_related("activity", "user"), pk=pk)
    if request.method == "POST":
        if "upload_file" in request.POST:
            f = request.FILES.get("file")
            if f:
                SubmissionFile.objects.create(
                    program=prog,
                    file=f,
                    original_name=f.name,
                    file_size=f.size,
                    file_purpose=request.POST.get("file_purpose", SubmissionFile.Purpose.OTHER),
                    uploaded_by=request.user,
                )
        else:
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
        return redirect("staff:program_detail", pk=prog.pk)
    notes = prog.staff_notes.select_related("created_by")
    files = prog.files.all()
    checks = prog.material_checks.all()
    return render(request, "staff_panel/program_detail.html", {
        "prog": prog,
        "statuses": Program.Status,
        "program_types": Program.ProgramType,
        "notes": notes,
        "files": files,
        "checks": checks,
        "check_statuses": MaterialCheck.Status,
        "file_purposes": SubmissionFile.Purpose,
    })


# --- Excel export ---


@staff_member_required
def export_registrations(request):
    wb = Workbook()
    ws = wb.active
    ws.title = "报名名单"
    ws.append(["姓名", "学号", "学院", "班级", "手机", "微信", "曲目", "原创", "赛前状态", "赛中状态", "活动", "提交时间"])
    for r in SingerRegistration.objects.select_related("activity"):
        ws.append([
            r.name, r.student_id, r.college, r.class_name,
            r.phone, r.wechat, r.song_name,
            "是" if r.is_original else "否",
            r.get_pre_status_display(), r.get_live_status_display(),
            r.activity.title, r.created_at.strftime("%Y-%m-%d %H:%M"),
        ])
    response = HttpResponse(content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    response["Content-Disposition"] = "attachment; filename=registration_list.xlsx"
    wb.save(response)
    return response


@staff_member_required
def export_programs(request):
    wb = Workbook()
    ws = wb.active
    ws.title = "节目单"
    ws.append(["顺序", "节目名称", "类型", "负责人", "联系方式", "所属", "演员", "时长", "麦克风需求", "道具需求", "状态", "活动", "提交时间"])
    for p in Program.objects.select_related("activity"):
        ws.append([
            p.sort_order, p.name, p.get_program_type_display(),
            p.contact_name, p.contact_phone, p.class_name,
            p.performers, p.estimated_duration,
            p.mic_requirements, p.prop_requirements,
            p.get_status_display(), p.activity.title,
            p.created_at.strftime("%Y-%m-%d %H:%M"),
        ])
    response = HttpResponse(content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    response["Content-Disposition"] = "attachment; filename=program_list.xlsx"
    wb.save(response)
    return response


# --- Singer contest scoring ---


@staff_member_required
def round_list(request):
    rounds = ContestRound.objects.select_related("activity")
    return render(request, "staff_panel/round_list.html", {"rounds": rounds})


@staff_member_required
def round_create(request):
    if request.method == "POST":
        ContestRound.objects.create(
            activity_id=request.POST["activity_id"],
            round_type=request.POST["round_type"],
            scoring_mode=request.POST.get("scoring_mode", ContestRound.ScoringMode.AVERAGE),
            name=request.POST.get("name", ""),
            advance_count=int(request.POST.get("advance_count", 0) or 0),
        )
        return redirect("staff:round_list")
    from core.models import Activity
    activities = Activity.objects.filter(activity_type=Activity.Type.SINGER_CONTEST)
    return render(request, "staff_panel/round_form.html", {
        "activities": activities,
        "round_types": ContestRound.RoundType,
        "scoring_modes": ContestRound.ScoringMode,
    })


@staff_member_required
def round_score_entry(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    singers = SingerRegistration.objects.filter(
        activity=contest_round.activity,
        pre_status=SingerRegistration.PreStatus.APPROVED,
    )
    judges = Judge.objects.filter(activity=contest_round.activity, is_active=True)
    scores = {
        (s.singer_id, s.judge_id): s.score
        for s in ScoreRecord.objects.filter(round=contest_round)
    }

    if request.method == "POST" and not contest_round.is_locked:
        for singer in singers:
            for judge in judges:
                key = f"score_{singer.pk}_{judge.pk}"
                if key in request.POST:
                    val = request.POST[key].strip()
                    if val:
                        ScoreRecord.objects.update_or_create(
                            round=contest_round, singer=singer, judge=judge,
                            defaults={"score": val},
                        )
        _recalc_round(contest_round)
        return redirect("staff:round_score_entry", pk=pk)

    # Pre-compute score grid: list of (singer, [(judge_pk, score), ...])
    score_grid = []
    for singer in singers:
        row = [(judge.pk, scores.get((singer.pk, judge.pk), "")) for judge in judges]
        score_grid.append((singer, row))

    return render(request, "staff_panel/round_score_entry.html", {
        "round": contest_round,
        "judges": judges,
        "score_grid": score_grid,
    })


@staff_member_required
def round_ranking(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    summaries = ScoreSummary.objects.filter(round=contest_round).select_related("singer")
    missing = ScoreRecord.objects.filter(round=contest_round, score__isnull=True).exists()
    return render(request, "staff_panel/round_ranking.html", {
        "round": contest_round,
        "summaries": summaries,
        "has_missing": missing,
    })


@staff_member_required
def round_lock(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    contest_round.is_locked = True
    contest_round.save()
    return redirect("staff:round_ranking", pk=pk)


@staff_member_required
def round_unlock(request, pk):
    if request.user.is_admin:
        contest_round = get_object_or_404(ContestRound, pk=pk)
        contest_round.is_locked = False
        contest_round.save()
    return redirect("staff:round_ranking", pk=pk)


@staff_member_required
def judge_list(request):
    judges = Judge.objects.select_related("activity")
    return render(request, "staff_panel/judge_list.html", {"judges": judges})


@staff_member_required
def judge_create(request):
    if request.method == "POST":
        Judge.objects.create(
            activity_id=request.POST["activity_id"],
            name=request.POST["name"],
        )
        return redirect("staff:judge_list")
    from core.models import Activity
    activities = Activity.objects.filter(activity_type=Activity.Type.SINGER_CONTEST)
    return render(request, "staff_panel/judge_form.html", {"activities": activities})


@staff_member_required
def award_list(request):
    awards = Award.objects.select_related("singer", "activity")
    return render(request, "staff_panel/award_list.html", {"awards": awards})


@staff_member_required
def award_create(request):
    if request.method == "POST":
        singer_id = request.POST.get("singer_id")
        if singer_id:
            Award.objects.create(
                activity_id=request.POST["activity_id"],
                singer_id=singer_id,
                name=request.POST["name"],
            )
        return redirect("staff:award_list")
    from core.models import Activity
    activities = Activity.objects.filter(activity_type=Activity.Type.SINGER_CONTEST)
    singers = SingerRegistration.objects.filter(pre_status=SingerRegistration.PreStatus.APPROVED)
    return render(request, "staff_panel/award_form.html", {
        "activities": activities,
        "singers": singers,
    })


def _recalc_round(contest_round):
    """Recalculate ScoreSummary for all singers in a round."""
    singers = SingerRegistration.objects.filter(activity=contest_round.activity)
    for singer in singers:
        singer_scores = list(
            ScoreRecord.objects.filter(round=contest_round, singer=singer, score__isnull=False)
            .values_list("score", flat=True)
        )
        if not singer_scores:
            continue
        if contest_round.scoring_mode == ContestRound.ScoringMode.DROP_HIGH_LOW and len(singer_scores) >= 3:
            singer_scores.remove(max(singer_scores))
            singer_scores.remove(min(singer_scores))
        avg = sum(singer_scores) / len(singer_scores)
        ScoreSummary.objects.update_or_create(
            round=contest_round, singer=singer,
            defaults={"average_score": avg},
        )
    # Re-rank
    summaries = ScoreSummary.objects.filter(round=contest_round).order_by("-average_score")
    for i, s in enumerate(summaries, 1):
        s.rank = i
        s.is_advanced = i <= contest_round.advance_count if contest_round.advance_count else False
        s.save()
    # Update singer live_status for advanced/not_advanced
    if contest_round.round_type == ContestRound.RoundType.PRELIMINARY and contest_round.advance_count:
        for s in summaries:
            singer = s.singer
            if s.is_advanced:
                singer.live_status = SingerRegistration.LiveStatus.ADVANCED
            else:
                singer.live_status = SingerRegistration.LiveStatus.NOT_ADVANCED
            singer.save()
