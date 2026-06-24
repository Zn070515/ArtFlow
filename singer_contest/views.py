from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404, redirect, render

from common.audit import log_action
from common.business_rules import ensure_activity_unlocked
from common.models import AuditLog
from core.models import Activity
from files.models import SubmissionFile
from files.services import sync_singer_material_checks
from .models import SingerRegistration


@login_required
def apply_view(request):
    activities = Activity.objects.filter(
        activity_type=Activity.Type.SINGER_CONTEST,
        phase=Activity.Phase.REGISTRATION_OPEN,
    )
    if request.method == "POST":
        activity = get_object_or_404(activities, pk=request.POST.get("activity_id"))
        ensure_activity_unlocked(activity)
        reg = SingerRegistration(
            activity=activity,
            user=request.user,
            name=request.POST["name"],
            student_id=request.POST["student_id"],
            college=request.POST["college"],
            class_name=request.POST["class_name"],
            phone=request.POST["phone"],
            wechat=request.POST.get("wechat", ""),
            song_name=request.POST["song_name"],
            is_original=request.POST.get("is_original") == "on",
            description=request.POST.get("description", ""),
            remark=request.POST.get("remark", ""),
            pre_status=SingerRegistration.PreStatus.SUBMITTED,
            is_test_data=activity.is_test_mode,
        )
        reg.save()
        accompaniment = request.FILES.get("accompaniment")
        if accompaniment:
            SubmissionFile.objects.create(
                singer_registration=reg,
                file=accompaniment,
                original_name=accompaniment.name,
                file_size=accompaniment.size,
                file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                uploaded_by=request.user,
                is_test_data=reg.is_test_data,
            )
        performance_video = request.FILES.get("performance_video")
        if performance_video:
            SubmissionFile.objects.create(
                singer_registration=reg,
                file=performance_video,
                original_name=performance_video.name,
                file_size=performance_video.size,
                file_purpose=SubmissionFile.Purpose.PERFORMANCE_VIDEO,
                uploaded_by=request.user,
                is_test_data=reg.is_test_data,
            )
        sync_singer_material_checks(reg)
        log_action(request, AuditLog.ActionType.UPDATE_REGISTRATION, f"SingerRegistration:{reg.pk}", new_value="submitted")
        return redirect("singer_contest:my_submission")
    return render(request, "singer_contest/apply.html", {"activities": activities})


@login_required
def my_submission_view(request):
    reg = SingerRegistration.objects.filter(user=request.user).last()
    if reg and request.method == "POST":
        ensure_activity_unlocked(reg.activity)
        f = request.FILES.get("file")
        if f:
            submission_file = SubmissionFile.objects.create(
                singer_registration=reg,
                file=f,
                original_name=f.name,
                file_size=f.size,
                file_purpose=request.POST.get("file_purpose", SubmissionFile.Purpose.OTHER),
                uploaded_by=request.user,
                is_test_data=reg.is_test_data or reg.activity.is_test_mode,
            )
            sync_singer_material_checks(reg)
            log_action(request, AuditLog.ActionType.UPLOAD_FILE, f"SubmissionFile:{submission_file.pk}", new_value=submission_file.original_name)
        return redirect("singer_contest:my_submission")
    if reg:
        sync_singer_material_checks(reg)
    return render(request, "singer_contest/my_submission.html", {
        "reg": reg,
        "files": reg.files.all() if reg else [],
        "checks": reg.material_checks.all() if reg else [],
        "file_purposes": SubmissionFile.Purpose.choices,
    })
