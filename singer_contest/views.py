from common.audit import log_action, redacted_field_change
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
from files.services import (
    large_video_upload_allowed,
    participant_uploadable_check_ids,
    reconcile_singer_material_checks,
    store_submission_file,
    submit_participant_material_for_check,
    validate_upload,
)

from .models import SingerRegistration


def _apply_form_context(request, activities, *, errors=None, video_upload_allowed=False):
    return {
        "activities": activities,
        "errors": errors or [],
        "video_upload_allowed": video_upload_allowed,
        "form_data": request.POST if request.method == "POST" else {},
        "selected_activity_id": request.POST.get("activity_id", "")
        if request.method == "POST"
        else "",
    }


@login_required
def apply_view(request):
    """The legacy fixed registration form.

    Superseded by the questionnaire page (``questionnaire.views.form_view``), which renders
    the frozen ruleset's own questions instead of a hardcoded field list. Kept routed, and
    deliberately not deleted: it is on the *Contract* step of the Expand → Migrate → Switch
    → Contract sequence and retires only once a rehearsal has confirmed the new path. See
    ``docs/singer-questionnaire-workflow.md``.
    """
    activities = Activity.objects.filter(
        activity_type=Activity.Type.SINGER_CONTEST,
        phase=Activity.Phase.REGISTRATION_OPEN,
    )
    if not request.user.is_staff_or_admin:
        activities = activities.filter(data_lifecycle=Activity.DataLifecycle.FORMAL)
    # Only offer a performer-sourced video upload when the page shows a non-formal
    # activity. The public apply path filters to FORMAL activities, so participants
    # never see the field; staff previewing test data still can.
    video_upload_allowed = any(large_video_upload_allowed(activity) for activity in activities)
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
                    validate_upload(uploaded_file, purpose, activity=activity)
                except ValidationError as error:
                    errors.extend(error.messages)
        if errors:
            return render(
                request,
                "singer_contest/apply.html",
                _apply_form_context(
                    request,
                    activities,
                    errors=errors,
                    video_upload_allowed=video_upload_allowed,
                ),
            )
        if SingerRegistration.objects.filter(activity=activity, user=request.user).exists():
            return render(
                request,
                "singer_contest/apply.html",
                _apply_form_context(
                    request,
                    activities,
                    errors=["您已报名该活动，请勿重复提交。"],
                    video_upload_allowed=video_upload_allowed,
                ),
            )
        if SingerRegistration.objects.filter(
            activity=activity, student_id=request.POST["student_id"]
        ).exists():
            return render(
                request,
                "singer_contest/apply.html",
                _apply_form_context(
                    request,
                    activities,
                    errors=["该学号已报名本活动。"],
                    video_upload_allowed=video_upload_allowed,
                ),
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
                reconcile_singer_material_checks(reg)
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
                _apply_form_context(
                    request,
                    activities,
                    errors=["报名失败：该账号或学号已报名本活动。"],
                    video_upload_allowed=video_upload_allowed,
                ),
            )
        return redirect("singer_contest:my_submission")
    return render(
        request,
        "singer_contest/apply.html",
        _apply_form_context(request, activities, video_upload_allowed=video_upload_allowed),
    )


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
    return registration.activity.phase == Activity.Phase.REGISTRATION_OPEN


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
        if "check_id" in request.POST or request.FILES.get("file"):
            errors.extend(_submit_participant_material(request, reg))
        else:
            errors.extend(_update_participant_metadata(request, reg))
        if not errors:
            return redirect("singer_contest:my_registration_detail", pk=reg.pk)
    return render(
        request,
        "singer_contest/my_submission.html",
        {
            "reg": reg,
            "can_edit": _participant_can_edit(reg),
            "files": reg.files.all(),
            "checks": reg.material_checks.all(),
            "uploadable_check_ids": participant_uploadable_check_ids(reg),
            "errors": errors,
        },
    )


def _submit_participant_material(request, reg):
    """Route a participant upload to the check-addressed material authority."""
    try:
        submission_file = submit_participant_material_for_check(
            owner=reg,
            check_id=request.POST.get("check_id"),
            uploaded_file=request.FILES.get("file"),
            actor=request.user,
        )
    except PermissionDenied as error:
        return [str(error)]
    except ValidationError as error:
        return list(error.messages)
    log_action(
        request,
        AuditLog.ActionType.UPLOAD_FILE,
        f"SubmissionFile:{submission_file.pk}",
        new_value=submission_file.original_name,
    )
    return []


def _update_participant_metadata(request, reg):
    """Apply the participant's own registration edit while the phase still allows it."""
    try:
        with transaction.atomic():
            activity = lock_activity_for_action(reg.activity)
            locked_reg = (
                SingerRegistration.objects.select_for_update()
                .select_related("activity")
                .get(pk=reg.pk, user=request.user)
            )
            if locked_reg.activity_id != activity.pk:
                raise PermissionDenied("报名信息不属于当前活动。")
            ensure_participant_can_edit(locked_reg)
            return _update_singer_registration(request, locked_reg)
    except PermissionDenied as error:
        return [str(error)]
    except ValidationError as error:
        return list(error.messages)


def _update_singer_registration(request, reg):
    old = {field: getattr(reg, field) for field in SINGER_EDITABLE_FIELDS if field in request.POST}
    for field in SINGER_EDITABLE_FIELDS:
        if field in request.POST:
            setattr(reg, field, request.POST[field].strip())
    if not old:
        return []
    reg.save(update_fields=list(old))
    new = {field: getattr(reg, field) for field in old}
    old_summary, new_summary = redacted_field_change(old, new)
    log_action(
        request,
        AuditLog.ActionType.UPDATE_REGISTRATION,
        f"SingerRegistration:{reg.pk}",
        old_value=old_summary,
        new_value=new_summary,
    )
    return []
