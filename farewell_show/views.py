from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404, redirect, render

from core.models import Activity
from files.models import SubmissionFile
from files.services import sync_program_material_checks
from .models import Program


@login_required
def apply_view(request):
    activities = Activity.objects.filter(
        activity_type=Activity.Type.FAREWELL_SHOW,
        phase=Activity.Phase.REGISTRATION_OPEN,
    )
    if request.method == "POST":
        activity = get_object_or_404(activities, pk=request.POST.get("activity_id"))
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
        )
        prog.save()
        upload_map = {
            "accompaniment": SubmissionFile.Purpose.ACCOMPANIMENT,
            "background_video": SubmissionFile.Purpose.BACKGROUND_VIDEO,
            "lyrics_script": SubmissionFile.Purpose.LYRICS_SCRIPT,
        }
        for field_name, purpose in upload_map.items():
            f = request.FILES.get(field_name)
            if f:
                SubmissionFile.objects.create(
                    program=prog,
                    file=f,
                    original_name=f.name,
                    file_size=f.size,
                    file_purpose=purpose,
                    uploaded_by=request.user,
                )
        sync_program_material_checks(prog)
        return redirect("farewell_show:my_program")
    return render(request, "farewell_show/apply.html", {"activities": activities})


@login_required
def my_program_view(request):
    prog = Program.objects.filter(user=request.user).last()
    if prog and request.method == "POST":
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
            sync_program_material_checks(prog)
        return redirect("farewell_show:my_program")
    if prog:
        sync_program_material_checks(prog)
    return render(request, "farewell_show/my_program.html", {
        "prog": prog,
        "files": prog.files.all() if prog else [],
        "checks": prog.material_checks.all() if prog else [],
        "file_purposes": SubmissionFile.Purpose.choices,
    })
