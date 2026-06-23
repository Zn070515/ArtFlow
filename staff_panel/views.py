from django.contrib.admin.views.decorators import staff_member_required
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone

from public_portal.models import PublicPost


def _get_post_form_data(request):
    """Extract and validate post form data from request, returns (data, errors)."""
    data = {}
    errors = []

    title = request.POST.get("title", "").strip()
    if not title:
        errors.append("标题不能为空")
    data["title"] = title

    data["subtitle"] = request.POST.get("subtitle", "").strip()
    data["content"] = request.POST.get("content", "").strip()
    data["post_type"] = request.POST.get("post_type", PublicPost.PostType.NORMAL_ARTICLE)
    data["status"] = request.POST.get("status", PublicPost.Status.DRAFT)

    sort_str = request.POST.get("sort_order", "0").strip()
    try:
        data["sort_order"] = int(sort_str) if sort_str else 0
    except ValueError:
        data["sort_order"] = 0

    return data, errors


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
        data, errors = _get_post_form_data(request)
        if errors:
            return render(request, "staff_panel/post_form.html", {
                "error": errors[0],
                "post_types": PublicPost.PostType,
                "statuses": PublicPost.Status,
            })
        post = PublicPost(
            title=data["title"],
            subtitle=data["subtitle"],
            content=data["content"],
            post_type=data["post_type"],
            status=data["status"],
            sort_order=data["sort_order"],
            created_by=request.user,
            updated_by=request.user,
        )
        if request.FILES.get("cover_image"):
            post.cover_image = request.FILES["cover_image"]
        if data["status"] == PublicPost.Status.PUBLISHED:
            post.published_at = timezone.now()
        post.save()
        return redirect("staff:post_list")
    return render(request, "staff_panel/post_form.html", {
        "post_types": PublicPost.PostType,
        "statuses": PublicPost.Status,
    })


@staff_member_required
def post_edit(request, pk):
    post = get_object_or_404(PublicPost, pk=pk)
    if request.method == "POST":
        data, errors = _get_post_form_data(request)
        if errors:
            return render(request, "staff_panel/post_form.html", {
                "error": errors[0],
                "post": post,
                "post_types": PublicPost.PostType,
                "statuses": PublicPost.Status,
            })
        post.title = data["title"]
        post.subtitle = data["subtitle"]
        post.content = data["content"]
        post.post_type = data["post_type"]
        old_status = post.status
        post.status = data["status"]
        post.sort_order = data["sort_order"]
        post.updated_by = request.user
        if request.FILES.get("cover_image"):
            post.cover_image = request.FILES["cover_image"]
        if data["status"] == PublicPost.Status.PUBLISHED and not post.published_at:
            post.published_at = timezone.now()
        elif data["status"] != PublicPost.Status.PUBLISHED and old_status == PublicPost.Status.PUBLISHED:
            post.published_at = None
        post.save()
        return redirect("staff:post_list")
    return render(request, "staff_panel/post_form.html", {
        "post": post,
        "post_types": PublicPost.PostType,
        "statuses": PublicPost.Status,
    })
