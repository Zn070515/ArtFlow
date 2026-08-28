from common.audit import log_action
from common.business_rules import ensure_activity_unlocked
from common.models import AuditLog
from common.test_data import lock_activity_for_runtime_data
from core.models import Activity
from django.contrib.auth.decorators import login_required
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404, redirect, render
from files.models import SubmissionFile
from files.services import store_submission_file, sync_singer_material_checks, validate_upload

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
        uploads = [
            (request.FILES.get("accompaniment"), SubmissionFile.Purpose.ACCOMPANIMENT),
            (request.FILES.get("performance_video"), SubmissionFile.Purpose.PERFORMANCE_VIDEO),
        ]
        errors = []
        for uploaded_file, purpose in uploads:
            if uploaded_file:
                try:
                    validate_upload(uploaded_file, purpose)
                except ValidationError as error:
                    errors.extend(error.messages)
        if errors:
            return render(
                request,
                "singer_contest/apply.html",
                {"activities": activities, "errors": errors},
            )
        if SingerRegistration.objects.filter(activity=activity, user=request.user).exists():
            return render(
                request,
                "singer_contest/apply.html",
                {
                    "activities": activities,
                    "errors": ["您已报名该活动，请勿重复提交。"],
                },
            )
        if SingerRegistration.objects.filter(
            activity=activity, student_id=request.POST["student_id"]
        ).exists():
            return render(
                request,
                "singer_contest/apply.html",
                {
                    "activities": activities,
                    "errors": ["该学号已报名本活动。"],
                },
            )
        try:
            with transaction.atomic():
                activity = lock_activity_for_runtime_data(activity)
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
                    store_submission_file(
                        owner=reg,
                        uploaded_file=accompaniment,
                        purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                        uploaded_by=request.user,
                    )
                performance_video = request.FILES.get("performance_video")
                if performance_video:
                    store_submission_file(
                        owner=reg,
                        uploaded_file=performance_video,
                        purpose=SubmissionFile.Purpose.PERFORMANCE_VIDEO,
                        uploaded_by=request.user,
                    )
                sync_singer_material_checks(reg)
                log_action(
                    request,
                    AuditLog.ActionType.UPDATE_REGISTRATION,
                    f"SingerRegistration:{reg.pk}",
                    new_value="submitted",
                )
        except IntegrityError:
            return render(
                request,
                "singer_contest/apply.html",
                {
                    "activities": activities,
                    "errors": ["报名失败：该账号或学号已报名本活动。"],
                },
            )
        return redirect("singer_contest:my_submission")
    return render(request, "singer_contest/apply.html", {"activities": activities})


@login_required
def my_submission_view(request):
    reg = SingerRegistration.objects.filter(user=request.user).last()
    errors = []
    if reg and request.method == "POST":
        ensure_activity_unlocked(reg.activity)
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
        if not errors:
            return redirect("singer_contest:my_submission")
    if reg:
        sync_singer_material_checks(reg)
    return render(
        request,
        "singer_contest/my_submission.html",
        {
            "reg": reg,
            "files": reg.files.all() if reg else [],
            "checks": reg.material_checks.all() if reg else [],
            "file_purposes": SubmissionFile.Purpose.choices,
            "errors": errors,
        },
    )
