from common.audit import log_action
from common.business_rules import ensure_activity_unlocked, ensure_participant_can_edit
from common.models import AuditLog
from core.models import Activity
from core.policies import ActivityAction, ensure_activity_action_allowed
from core.services import lock_activity_for_action
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied, ValidationError
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
        ensure_activity_action_allowed(activity, ActivityAction.SUBMIT_REGISTRATION)
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
                activity = lock_activity_for_action(activity, ActivityAction.SUBMIT_REGISTRATION)
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


SINGER_EDITABLE_FIELDS = (
    "college",
    "class_name",
    "phone",
    "wechat",
    "song_name",
    "description",
    "remark",
)


def _participant_can_edit(registration):
    if registration.activity.is_locked:
        return False
    return registration.activity.phase in (
        Activity.Phase.REGISTRATION_OPEN,
        Activity.Phase.REVIEWING,
    )


@login_required
def my_registrations_view(request):
    registrations = SingerRegistration.objects.filter(user=request.user).select_related("activity")
    return render(
        request,
        "singer_contest/my_registrations.html",
        {"registrations": registrations},
    )


@login_required
def my_submission_view(request):
    return redirect("singer_contest:my_registrations")


@login_required
def my_registration_detail(request, pk):
    reg = get_object_or_404(
        SingerRegistration.objects.select_related("activity"), pk=pk, user=request.user
    )
    errors = []
    if request.method == "POST":
        try:
            with transaction.atomic():
                locked_reg = (
                    SingerRegistration.objects.select_for_update()
                    .select_related("activity")
                    .get(pk=reg.pk, user=request.user)
                )
                lock_activity_for_action(locked_reg.activity)
                ensure_participant_can_edit(locked_reg)
                if request.FILES.get("file"):
                    submission_file = store_submission_file(
                        owner=locked_reg,
                        uploaded_file=request.FILES["file"],
                        purpose=request.POST.get("file_purpose", SubmissionFile.Purpose.OTHER),
                        uploaded_by=request.user,
                    )
                    sync_singer_material_checks(locked_reg)
                    log_action(
                        request,
                        AuditLog.ActionType.UPLOAD_FILE,
                        f"SubmissionFile:{submission_file.pk}",
                        new_value=submission_file.original_name,
                    )
                else:
                    errors.extend(_update_singer_registration(request, locked_reg))
        except PermissionDenied as error:
            errors.append(str(error))
        except ValidationError as error:
            errors.extend(error.messages)
        if not errors:
            return redirect("singer_contest:my_registration_detail", pk=reg.pk)
    sync_singer_material_checks(reg)
    return render(
        request,
        "singer_contest/my_submission.html",
        {
            "reg": reg,
            "can_edit": _participant_can_edit(reg),
            "files": reg.files.all(),
            "checks": reg.material_checks.all(),
            "file_purposes": SubmissionFile.Purpose.choices,
            "errors": errors,
        },
    )


def _update_singer_registration(request, reg):
    old = {field: getattr(reg, field) for field in SINGER_EDITABLE_FIELDS if field in request.POST}
    for field in SINGER_EDITABLE_FIELDS:
        if field in request.POST:
            setattr(reg, field, request.POST[field].strip())
    if not old:
        return []
    reg.save(update_fields=list(old))
    new = {field: getattr(reg, field) for field in old}
    log_action(
        request,
        AuditLog.ActionType.UPDATE_REGISTRATION,
        f"SingerRegistration:{reg.pk}",
        old_value=str(old),
        new_value=str(new),
    )
    return []
