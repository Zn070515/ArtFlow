from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404, redirect, render

from core.models import Activity
from .models import Program


@login_required
def apply_view(request):
    activities = Activity.objects.filter(
        activity_type=Activity.Type.FAREWELL_SHOW,
        phase=Activity.Phase.REGISTRATION_OPEN,
    )
    if request.method == "POST":
        prog = Program(
            activity_id=request.POST["activity_id"],
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
        return redirect("farewell_show:my_program")
    return render(request, "farewell_show/apply.html", {"activities": activities})


@login_required
def my_program_view(request):
    prog = Program.objects.filter(user=request.user).last()
    return render(request, "farewell_show/my_program.html", {"prog": prog})
