import io
import zipfile
from datetime import datetime

from django.contrib.admin.views.decorators import staff_member_required
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment

from archive.models import ArchivePackage
from common.models import AuditLog
from core.models import Activity
from exports.models import ArticleTemplate, ExportTask, GeneratedDocument
from farewell_show.models import Program
from files.models import MaterialCheck, StaffNote, SubmissionFile
from incidents.models import IncidentRecord
from public_portal.models import PublicPost
from singer_contest.models import Award, ContestRound, Judge, ScoreRecord, ScoreSummary, SingerRegistration
from voting.models import VoteOption, VoteRecord, VoteSession


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
        return redirect("staff:post_list")
    return render(request, "staff_panel/post_form.html", {
        "post_types": PublicPost.PostType,
        "statuses": PublicPost.Status,
        "activities": Activity.objects.all(),
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
        post.is_pinned = data["is_pinned"]
        post.related_activity_id = data["related_activity_id"]
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
        "activities": Activity.objects.all(),
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


# --- Vote session management ---


@staff_member_required
def vote_session_list(request):
    sessions = VoteSession.objects.select_related("activity")
    return render(request, "staff_panel/vote_session_list.html", {"sessions": sessions})


@staff_member_required
def vote_session_create(request):
    if request.method == "POST":
        vote_session = VoteSession.objects.create(
            activity_id=request.POST["activity_id"],
            name=request.POST["name"],
            passcode=request.POST["passcode"],
            start_time=request.POST["start_time"],
            end_time=request.POST["end_time"],
            selection_type=request.POST.get("selection_type", VoteSession.SelectionType.SINGLE),
            max_selections=int(request.POST.get("max_selections", 1) or 1),
        )
        singer_ids = request.POST.getlist("singers")
        for i, sid in enumerate(singer_ids):
            VoteOption.objects.create(
                vote_session=vote_session,
                singer_id=sid,
                sort_order=i,
            )
        return redirect("staff:vote_session_list")

    activities = Activity.objects.filter(activity_type=Activity.Type.SINGER_CONTEST)
    singers = SingerRegistration.objects.filter(pre_status=SingerRegistration.PreStatus.APPROVED)
    return render(request, "staff_panel/vote_session_form.html", {
        "activities": activities,
        "singers": singers,
        "selection_types": VoteSession.SelectionType,
    })


@staff_member_required
def vote_session_detail(request, pk):
    vote_session = get_object_or_404(VoteSession.objects.select_related("activity"), pk=pk)
    options = vote_session.options.select_related("singer")
    # Annotate with vote count
    from django.db.models import Count
    options = options.annotate(vote_count=Count("records"))
    total_votes = VoteRecord.objects.filter(vote_session=vote_session).count()
    return render(request, "staff_panel/vote_session_detail.html", {
        "vote_session": vote_session,
        "options": options,
        "total_votes": total_votes,
    })


@staff_member_required
def vote_session_toggle(request, pk):
    vote_session = get_object_or_404(VoteSession, pk=pk)
    vote_session.is_open = not vote_session.is_open
    vote_session.save()
    return redirect("staff:vote_session_detail", pk=pk)


@staff_member_required
def vote_session_lock(request, pk):
    vote_session = get_object_or_404(VoteSession, pk=pk)
    vote_session.is_locked = True
    vote_session.is_open = False
    vote_session.save()
    return redirect("staff:vote_session_detail", pk=pk)


@staff_member_required
def vote_session_export(request, pk):
    vote_session = get_object_or_404(VoteSession, pk=pk)
    wb = Workbook()
    ws = wb.active
    ws.title = "投票结果"
    ws.append(["选手", "票数"])
    from django.db.models import Count
    options = vote_session.options.select_related("singer").annotate(vote_count=Count("records"))
    for opt in options:
        ws.append([opt.singer.name, opt.vote_count])
    response = HttpResponse(content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    response["Content-Disposition"] = f"attachment; filename=vote_result_{vote_session.pk}.xlsx"
    wb.save(response)
    return response


# --- QR code center ---


@staff_member_required
def qr_center(request):
    activities = Activity.objects.all()
    return render(request, "staff_panel/qr_center.html", {"activities": activities})


@staff_member_required
def qr_generate(request, pk):
    activity = get_object_or_404(Activity, pk=pk)
    return render(request, "staff_panel/qr_detail.html", {"activity": activity})


# --- Export center ---


@staff_member_required
def export_center(request):
    activities = Activity.objects.all()
    templates = ArticleTemplate.objects.all()
    return render(request, "staff_panel/export_center.html", {
        "activities": activities,
        "templates": templates,
    })


@staff_member_required
def excel_material_checklist(request, activity_id):
    activity = get_object_or_404(Activity, pk=activity_id)
    wb = Workbook()
    ws = wb.active
    ws.title = "材料清单"
    ws.append(["姓名", "项目", "状态"])
    checks = MaterialCheck.objects.filter(singer_registration__activity=activity)
    for c in checks.select_related("singer_registration"):
        ws.append([c.singer_registration.name, c.item_name, c.get_status_display()])
    response = HttpResponse(content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    response["Content-Disposition"] = "attachment; filename=material_checklist.xlsx"
    wb.save(response)
    return response


@staff_member_required
def excel_score_template(request, round_id):
    contest_round = get_object_or_404(ContestRound, pk=round_id)
    singers = SingerRegistration.objects.filter(
        activity=contest_round.activity,
        pre_status=SingerRegistration.PreStatus.APPROVED,
    )
    judges = Judge.objects.filter(activity=contest_round.activity, is_active=True)
    wb = Workbook()
    ws = wb.active
    ws.title = "评分表模板"
    header = ["选手\\评委"] + [j.name for j in judges]
    ws.append(header)
    for singer in singers:
        ws.append([singer.name] + ["" for _ in judges])
    for col_idx, judge in enumerate(judges, 2):
        ws.cell(row=1, column=col_idx).font = Font(bold=True)
        ws.cell(row=1, column=col_idx).alignment = Alignment(horizontal="center")
    response = HttpResponse(content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    response["Content-Disposition"] = "attachment; filename=score_template.xlsx"
    wb.save(response)
    return response


@staff_member_required
def excel_import_scores(request, round_id):
    contest_round = get_object_or_404(ContestRound, pk=round_id)
    errors = []
    if request.method == "POST" and request.FILES.get("file"):
        from openpyxl import load_workbook
        try:
            wb = load_workbook(request.FILES["file"], data_only=True)
            ws = wb.active
            header = [cell.value for cell in ws[1]]
            judges_by_name = {j.name: j for j in Judge.objects.filter(activity=contest_round.activity)}
            singer_by_name = {s.name: s for s in SingerRegistration.objects.filter(activity=contest_round.activity)}
            for row in ws.iter_rows(min_row=2, values_only=True):
                singer_name = row[0]
                if not singer_name:
                    continue
                singer = singer_by_name.get(singer_name.strip())
                if not singer:
                    errors.append(f"选手不存在: {singer_name}")
                    continue
                for col_idx, score_val in enumerate(row[1:], 1):
                    if score_val is None or str(score_val).strip() == "":
                        continue
                    judge_name = header[col_idx]
                    judge = judges_by_name.get(judge_name)
                    if not judge:
                        errors.append(f"评委不存在: {judge_name}")
                        continue
                    try:
                        score = float(score_val)
                    except ValueError:
                        errors.append(f"分数格式错误: {singer_name} {judge_name} = {score_val}")
                        continue
                    if score < 0 or score > 100:
                        errors.append(f"分数超出范围 0-100: {singer_name} {judge_name} = {score}")
                        continue
                    ScoreRecord.objects.update_or_create(
                        round=contest_round, singer=singer, judge=judge,
                        defaults={"score": score},
                    )
            if not errors:
                _recalc_round(contest_round)
                return redirect("staff:round_score_entry", pk=round_id)
        except Exception as e:
            errors.append(f"文件解析失败: {e}")
    return render(request, "staff_panel/excel_import.html", {
        "round": contest_round,
        "errors": errors,
    })


# --- Word generation ---


@staff_member_required
def word_generate(request, template_id, activity_id):
    template = get_object_or_404(ArticleTemplate, pk=template_id)
    activity = get_object_or_404(Activity, pk=activity_id)
    from docx import Document
    doc = Document()
    doc.add_heading(activity.title, 0)
    body = template.body
    singers = SingerRegistration.objects.filter(activity=activity, pre_status=SingerRegistration.PreStatus.APPROVED)
    singer_lines = "\n".join(f"{s.name} — {s.song_name}" for s in singers)
    programs = Program.objects.filter(activity=activity)
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
    doc_obj = GeneratedDocument.objects.create(
        template=template,
        activity=activity,
        title=template.name,
        created_by=request.user,
    )
    doc_obj.file.save(f"{template.template_type}_{activity_id}.docx", buf)
    AuditLog.objects.create(
        operator=request.user,
        action_type=AuditLog.ActionType.EXPORT,
        target=f"生成Word: {template.name}",
    )
    response = HttpResponse(buf.read(), content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    response["Content-Disposition"] = f"attachment; filename={template.template_type}_{activity_id}.docx"
    return response


# --- Execution & archive packages ---


@staff_member_required
def execution_package(request, activity_id):
    activity = get_object_or_404(Activity, pk=activity_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for label, gen in _activity_excel_generators(activity):
            wb = gen()
            stream = io.BytesIO()
            wb.save(stream)
            zf.writestr(f"{label}.xlsx", stream.getvalue())
    buf.seek(0)
    response = HttpResponse(buf.read(), content_type="application/zip")
    response["Content-Disposition"] = f"attachment; filename=execution_{activity_id}.zip"
    return response


@staff_member_required
def archive_package_create(request, activity_id):
    activity = get_object_or_404(Activity, pk=activity_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for label, gen in _activity_excel_generators(activity):
            wb = gen()
            stream = io.BytesIO()
            wb.save(stream)
            zf.writestr(f"{label}.xlsx", stream.getvalue())
        # Include generated docs
        for doc in GeneratedDocument.objects.filter(activity=activity):
            if doc.file:
                zf.write(doc.file.path, f"推文_{doc.pk}.docx")
    buf.seek(0)
    ArchivePackage.objects.create(activity=activity, note="手动生成归档包", created_by=request.user)
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
        ws = wb.active
        ws.title = "报名名单"
        ws.append(["姓名", "学号", "学院", "班级", "手机", "微信", "曲目", "原创", "赛前状态"])
        for r in SingerRegistration.objects.filter(activity=activity):
            ws.append([r.name, r.student_id, r.college, r.class_name, r.phone, r.wechat, r.song_name, "是" if r.is_original else "否", r.get_pre_status_display()])
        return wb

    def _material_checklist():
        wb = Workbook()
        ws = wb.active
        ws.title = "材料清单"
        ws.append(["姓名", "项目", "状态"])
        for c in MaterialCheck.objects.filter(singer_registration__activity=activity):
            ws.append([c.singer_registration.name, c.item_name, c.get_status_display()])
        return wb

    def _incidents():
        wb = Workbook()
        ws = wb.active
        ws.title = "异常记录"
        ws.append(["时间", "类型", "选手", "处理人", "处理结果", "备注"])
        for inc in IncidentRecord.objects.filter(activity=activity):
            ws.append([inc.occurred_at.strftime("%m/%d %H:%M"), inc.get_event_type_display(),
                       inc.singer.name if inc.singer else "", inc.handled_by.username if inc.handled_by else "",
                       inc.resolution, inc.remark])
        return wb

    def _staff_notes():
        wb = Workbook()
        ws = wb.active
        ws.title = "工作人员备注"
        ws.append(["关联", "内容", "创建人", "时间"])
        for n in StaffNote.objects.filter(singer_registration__activity=activity).select_related("created_by"):
            ws.append([f"选手: {n.singer_registration.name}", n.content, n.created_by.username, n.created_at.strftime("%m/%d %H:%M")])
        return wb

    def _contacts():
        wb = Workbook()
        ws = wb.active
        ws.title = "联系方式表"
        ws.append(["姓名", "学号", "手机", "微信", "学院", "班级", "曲目"])
        for r in SingerRegistration.objects.filter(activity=activity):
            ws.append([r.name, r.student_id, r.phone, r.wechat, r.college, r.class_name, r.song_name])
        return wb

    return [
        ("报名名单", _registration_list),
        ("材料清单", _material_checklist),
        ("联系方式表", _contacts),
        ("异常记录", _incidents),
        ("工作人员备注", _staff_notes),
    ]


# --- Incident records ---


@staff_member_required
def incident_list(request):
    incidents = IncidentRecord.objects.select_related("activity", "singer", "handled_by")
    return render(request, "staff_panel/incident_list.html", {"incidents": incidents})


@staff_member_required
def incident_create(request):
    if request.method == "POST":
        IncidentRecord.objects.create(
            activity_id=request.POST["activity_id"],
            occurred_at=request.POST["occurred_at"],
            event_type=request.POST.get("event_type", IncidentRecord.EventType.OTHER),
            singer_id=request.POST.get("singer_id") or None,
            program_id=request.POST.get("program_id") or None,
            handled_by_id=request.user.pk,
            resolution=request.POST.get("resolution", ""),
            remark=request.POST.get("remark", ""),
        )
        return redirect("staff:incident_list")
    activities = Activity.objects.all()
    singers = SingerRegistration.objects.filter(pre_status=SingerRegistration.PreStatus.APPROVED)
    return render(request, "staff_panel/incident_form.html", {
        "activities": activities,
        "singers": singers,
        "event_types": IncidentRecord.EventType,
    })


@staff_member_required
def incident_export(request):
    wb = Workbook()
    ws = wb.active
    ws.title = "异常记录"
    ws.append(["活动", "时间", "类型", "选手", "处理人", "处理结果", "备注"])
    for inc in IncidentRecord.objects.select_related("activity", "singer", "handled_by"):
        ws.append([
            inc.activity.title, inc.occurred_at.strftime("%Y-%m-%d %H:%M"),
            inc.get_event_type_display(),
            inc.singer.name if inc.singer else "",
            inc.handled_by.username if inc.handled_by else "",
            inc.resolution, inc.remark,
        ])
    response = HttpResponse(content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    response["Content-Disposition"] = "attachment; filename=incident_list.xlsx"
    wb.save(response)
    return response


# --- Test mode management ---


@staff_member_required
def activity_test_toggle(request, pk):
    activity = get_object_or_404(Activity, pk=pk)
    activity.is_test_mode = not activity.is_test_mode
    activity.save()
    return redirect("staff:export_center")


@staff_member_required
def activity_clear_test_data(request, pk):
    activity = get_object_or_404(Activity, pk=pk)
    SingerRegistration.objects.filter(activity=activity).delete()
    ScoreRecord.objects.filter(round__activity=activity).delete()
    ScoreSummary.objects.filter(round__activity=activity).delete()
    VoteRecord.objects.filter(vote_session__activity=activity).delete()
    VoteOption.objects.filter(vote_session__activity=activity).delete()
    VoteSession.objects.filter(activity=activity).delete()
    IncidentRecord.objects.filter(activity=activity, is_test=True).delete()
    return redirect("staff:export_center")


# --- Activity management ---


@staff_member_required
def activity_lock(request, pk):
    activity = get_object_or_404(Activity, pk=pk)
    activity.is_locked = True
    activity.locked_at = timezone.now()
    activity.locked_by = request.user
    activity.save()
    AuditLog.objects.create(operator=request.user, action_type=AuditLog.ActionType.RELOCK_RESULT, target=f"锁定: {activity.title}")
    return redirect("staff:export_center")


@staff_member_required
def activity_unlock(request, pk):
    if request.user.is_admin:
        activity = get_object_or_404(Activity, pk=pk)
        activity.is_locked = False
        activity.locked_at = None
        activity.locked_by = None
        activity.save()
        AuditLog.objects.create(operator=request.user, action_type=AuditLog.ActionType.UNLOCK_RESULT, target=f"解锁: {activity.title}")
    return redirect("staff:export_center")


@staff_member_required
def activity_clone(request, pk):
    original = get_object_or_404(Activity, pk=pk)
    new_activity = Activity.objects.create(
        title=f"{original.title}（副本）",
        subtitle=original.subtitle,
        activity_type=original.activity_type,
        phase=Activity.Phase.DRAFT,
        description=original.description,
        is_test_mode=True,
    )
    AuditLog.objects.create(operator=request.user, action_type=AuditLog.ActionType.OTHER, target=f"克隆活动: {original.title} → {new_activity.title}")
    return redirect("staff:export_center")


# --- Audit log ---


@staff_member_required
def audit_log_list(request):
    logs = AuditLog.objects.select_related("operator")[:200]
    return render(request, "staff_panel/audit_log_list.html", {"logs": logs})
