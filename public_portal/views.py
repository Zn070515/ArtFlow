from django.shortcuts import get_object_or_404, render

from .models import PublicPost


def home(request):
    posts = PublicPost.objects.filter(status=PublicPost.Status.PUBLISHED)
    announcements = posts.filter(post_type=PublicPost.PostType.ANNOUNCEMENT)[:5]
    showcases = posts.filter(post_type=PublicPost.PostType.SHOWCASE)[:6]
    results = posts.filter(post_type=PublicPost.PostType.RESULT_PUBLICATION)[:5]
    registration_entries = posts.filter(post_type=PublicPost.PostType.REGISTRATION_ENTRY)[:3]
    voting_entries = posts.filter(post_type=PublicPost.PostType.VOTING_ENTRY)[:3]

    return render(request, "public_portal/home.html", {
        "announcements": announcements,
        "showcases": showcases,
        "results": results,
        "registration_entries": registration_entries,
        "voting_entries": voting_entries,
    })


def post_detail(request, pk):
    post = get_object_or_404(PublicPost, pk=pk, status=PublicPost.Status.PUBLISHED)
    return render(request, "public_portal/post_detail.html", {"post": post})


def showcase_list(request):
    posts = PublicPost.objects.filter(
        post_type=PublicPost.PostType.SHOWCASE,
        status=PublicPost.Status.PUBLISHED,
    )
    return render(request, "public_portal/showcase_list.html", {"posts": posts})


def announcement_list(request):
    posts = PublicPost.objects.filter(
        post_type=PublicPost.PostType.ANNOUNCEMENT,
        status=PublicPost.Status.PUBLISHED,
    )
    return render(request, "public_portal/announcement_list.html", {"posts": posts})


def result_list(request):
    posts = PublicPost.objects.filter(
        post_type=PublicPost.PostType.RESULT_PUBLICATION,
        status=PublicPost.Status.PUBLISHED,
    )
    return render(request, "public_portal/result_list.html", {"posts": posts})
