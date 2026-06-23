from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404, redirect, render

from core.models import Activity
from .models import SingerRegistration


@login_required
def apply_view(request):
    activities = Activity.objects.filter(
        activity_type=Activity.Type.SINGER_CONTEST,
        phase=Activity.Phase.REGISTRATION_OPEN,
    )
    if request.method == "POST":
        reg = SingerRegistration(
            activity_id=request.POST["activity_id"],
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
        )
        reg.save()
        return redirect("singer_contest:my_submission")
    return render(request, "singer_contest/apply.html", {"activities": activities})


@login_required
def my_submission_view(request):
    reg = SingerRegistration.objects.filter(user=request.user).last()
    return render(request, "singer_contest/my_submission.html", {"reg": reg})
