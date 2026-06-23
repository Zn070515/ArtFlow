from django.contrib.admin.views.decorators import staff_member_required
from django.shortcuts import get_object_or_404, redirect, render

from public_portal.models import PublicPost


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
        post = PublicPost(
            title=request.POST["title"],
            subtitle=request.POST.get("subtitle", ""),
            content=request.POST.get("content", ""),
            post_type=request.POST["post_type"],
            status=request.POST["status"],
            sort_order=int(request.POST.get("sort_order", 0)),
            created_by=request.user,
            updated_by=request.user,
        )
        if request.FILES.get("cover_image"):
            post.cover_image = request.FILES["cover_image"]
        if request.POST["status"] == PublicPost.Status.PUBLISHED:
            from django.utils import timezone
            post.published_at = timezone.now()
        post.save()
        return redirect("staff:post_list")
    return render(request, "staff_panel/post_form.html", {"post_types": PublicPost.PostType, "statuses": PublicPost.Status})


@staff_member_required
def post_edit(request, pk):
    post = get_object_or_404(PublicPost, pk=pk)
    if request.method == "POST":
        post.title = request.POST["title"]
        post.subtitle = request.POST.get("subtitle", "")
        post.content = request.POST.get("content", "")
        post.post_type = request.POST["post_type"]
        post.status = request.POST["status"]
        post.sort_order = int(request.POST.get("sort_order", 0))
        post.updated_by = request.user
        if request.FILES.get("cover_image"):
            post.cover_image = request.FILES["cover_image"]
        if request.POST["status"] == PublicPost.Status.PUBLISHED and not post.published_at:
            from django.utils import timezone
            post.published_at = timezone.now()
        post.save()
        return redirect("staff:post_list")
    return render(request, "staff_panel/post_form.html", {"post": post, "post_types": PublicPost.PostType, "statuses": PublicPost.Status})
