from common.audit import log_action
from common.business_rules import ensure_activity_unlocked, ensure_participant_can_edit
from common.models import AuditLog
from common.test_data import lock_activity_for_runtime_data
from core.models import Activity
from core.policies import ActivityAction, ensure_activity_action_allowed
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
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
        ensure_activity_action_allowed(activity, ActivityAction.SUBMIT_REGISTRATION)
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
        with transaction.atomic():
            activity = lock_activity_for_runtime_data(activity)
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
            for field_name, purpose in upload_map.items():
                f = request.FILES.get(field_name)
                if f:
                    store_submission_file(
                        owner=prog,
                        uploaded_file=f,
                        purpose=purpose,
                        uploaded_by=request.user,
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


PROGRAM_EDITABLE_FIELDS = (
    "program_type",
    "contact_name",
    "contact_phone",
    "class_name",
    "performers",
    "estimated_duration",
    "description",
    "mic_requirements",
    "prop_requirements",
    "special_notes",
)


def _participant_can_edit(program):
    if program.activity.is_locked:
        return False
    return program.activity.phase in (
        Activity.Phase.REGISTRATION_OPEN,
        Activity.Phase.REVIEWING,
    )


@login_required
def my_programs_view(request):
    programs = Program.objects.filter(user=request.user).select_related("activity")
    return render(
        request,
        "farewell_show/my_programs.html",
        {"programs": programs},
    )


@login_required
def my_program_view(request):
    return redirect("farewell_show:my_programs")


@login_required
def my_program_detail(request, pk):
    prog = get_object_or_404(Program.objects.select_related("activity"), pk=pk, user=request.user)
    errors = []
    if request.method == "POST":
        try:
            ensure_participant_can_edit(prog)
        except PermissionDenied as error:
            errors.append(str(error))
        else:
            if request.FILES.get("file"):
                try:
                    submission_file = store_submission_file(
                        owner=prog,
                        uploaded_file=request.FILES["file"],
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
                errors.extend(_update_program(request, prog))
            if not errors:
                return redirect("farewell_show:my_program_detail", pk=prog.pk)
    sync_program_material_checks(prog)
    return render(
        request,
        "farewell_show/my_program.html",
        {
            "prog": prog,
            "can_edit": _participant_can_edit(prog),
            "files": prog.files.all(),
            "checks": prog.material_checks.all(),
            "file_purposes": SubmissionFile.Purpose.choices,
            "program_types": Program.ProgramType.choices,
            "errors": errors,
        },
    )


def _update_program(request, prog):
    editable = [f for f in PROGRAM_EDITABLE_FIELDS if f in request.POST]
    old = {field: getattr(prog, field) for field in editable}
    for field in editable:
        if field in request.POST:
            setattr(prog, field, request.POST[field].strip())
    if not old:
        return []
    prog.save(update_fields=list(old))
    new = {field: getattr(prog, field) for field in old}
    log_action(
        request,
        AuditLog.ActionType.UPDATE_REGISTRATION,
        f"Program:{prog.pk}",
        old_value=str(old),
        new_value=str(new),
    )
    return []
