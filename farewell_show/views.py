from common.audit import log_action
from common.business_rules import ensure_activity_unlocked
from common.models import AuditLog
from core.models import Activity
from django.contrib.auth.decorators import login_required
from django.core.exceptions import ValidationError
from django.shortcuts import get_object_or_404, redirect, render
from files.models import SubmissionFile
from files.services import store_submission_file, sync_program_material_checks, validate_upload

from .models import Program


@login_required
def apply_view(request):
    activities = Activity.objects.filter(
        activity_type=Activity.Type.FAREWELL_SHOW,
        phase=Activity.Phase.REGISTRATION_OPEN,
    )
    if request.method == "POST":
        activity = get_object_or_404(activities, pk=request.POST.get("activity_id"))
        ensure_activity_unlocked(activity)
        prog = Program(
            activity=activity,
            user=request.user,
            name=request.POST["name"],
            program_type=request.POST["program_type"],
            contact_name=request.POST["contact_name"],
            contact_phone=request.POST["contact_phone"],
            class_name=request.POST["class_name"],
            performers=request.POST.get("performers", ""),
            estimated_duration=request.POST.get("estimated_duration", ""),
            description=request.POST.get("description", ""),
            mic_requirements=request.POST.get("mic_requirements", ""),
            prop_requirements=request.POST.get("prop_requirements", ""),
            special_notes=request.POST.get("special_notes", ""),
            status=Program.Status.SUBMITTED,
            is_test_data=activity.is_test_mode,
        )
        prog.save()
        upload_map = {
            "accompaniment": SubmissionFile.Purpose.ACCOMPANIMENT,
            "background_video": SubmissionFile.Purpose.BACKGROUND_VIDEO,
            "lyrics_script": SubmissionFile.Purpose.LYRICS_SCRIPT,
        }
        errors = []
        for field_name, purpose in upload_map.items():
            uploaded_file = request.FILES.get(field_name)
            if uploaded_file:
                try:
                    validate_upload(uploaded_file, purpose)
                except ValidationError as error:
                    errors.extend(error.messages)
        if errors:
            return render(
                request,
                "farewell_show/apply.html",
                {"activities": activities, "errors": errors},
            )
        for field_name, purpose in upload_map.items():
            f = request.FILES.get(field_name)
            if f:
                store_submission_file(
                    owner=prog,
                    uploaded_file=f,
                    purpose=purpose,
                    uploaded_by=request.user,
                    is_test_data=prog.is_test_data,
                )
        sync_program_material_checks(prog)
        log_action(
            request,
            AuditLog.ActionType.UPDATE_REGISTRATION,
            f"Program:{prog.pk}",
            new_value="submitted",
        )
        return redirect("farewell_show:my_program")
    return render(request, "farewell_show/apply.html", {"activities": activities})


@login_required
def my_program_view(request):
    prog = Program.objects.filter(user=request.user).last()
    errors = []
    if prog and request.method == "POST":
        ensure_activity_unlocked(prog.activity)
        f = request.FILES.get("file")
        if f:
            try:
                submission_file = store_submission_file(
                    owner=prog,
                    uploaded_file=f,
                    purpose=request.POST.get("file_purpose", SubmissionFile.Purpose.OTHER),
                    uploaded_by=request.user,
                    is_test_data=prog.is_test_data or prog.activity.is_test_mode,
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
        if not errors:
            return redirect("farewell_show:my_program")
    if prog:
        sync_program_material_checks(prog)
    return render(
        request,
        "farewell_show/my_program.html",
        {
            "prog": prog,
            "files": prog.files.all() if prog else [],
            "checks": prog.material_checks.all() if prog else [],
            "file_purposes": SubmissionFile.Purpose.choices,
            "errors": errors,
        },
    )
