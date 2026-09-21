from django.db.models import Prefetch
from django.shortcuts import get_object_or_404, render

from .models import PublicMedia, PublicPost


def home(request):
    posts = PublicPost.published_public()
    announcements = posts.filter(post_type=PublicPost.PostType.ANNOUNCEMENT)[:5]
    showcases = posts.filter(post_type=PublicPost.PostType.SHOWCASE)[:6]
    results = posts.filter(post_type=PublicPost.PostType.RESULT_PUBLICATION)[:5]
    registration_entries = posts.filter(post_type=PublicPost.PostType.REGISTRATION_ENTRY)[:3]
    voting_entries = posts.filter(post_type=PublicPost.PostType.VOTING_ENTRY)[:3]
    published_media = PublicMedia.objects.filter(is_published=True).order_by("sort_order", "pk")
    photo_posts = (
        posts.filter(
            post_type=PublicPost.PostType.SHOWCASE,
            media_items__is_published=True,
        )
        .prefetch_related(
            Prefetch("media_items", queryset=published_media, to_attr="published_media")
        )
        .distinct()[:6]
    )
    activity_photos = PublicMedia.objects.filter(
        is_published=True,
        post__in=posts,
    ).select_related("post")[:12]

    return render(
        request,
        "public_portal/home.html",
        {
            "announcements": announcements,
            "showcases": showcases,
            "results": results,
            "registration_entries": registration_entries,
            "voting_entries": voting_entries,
            "activity_photos": activity_photos,
            "photo_posts": photo_posts,
        },
    )


def post_detail(request, pk):
    post = get_object_or_404(PublicPost.published_public(), pk=pk)
    media_items = post.media_items.filter(is_published=True)
    return render(
        request,
        "public_portal/post_detail.html",
        {
            "post": post,
            "media_items": media_items,
        },
    )


def showcase_list(request):
    posts = PublicPost.published_public().filter(
        post_type=PublicPost.PostType.SHOWCASE,
    )
    return render(request, "public_portal/showcase_list.html", {"posts": posts})


def announcement_list(request):
    posts = PublicPost.published_public().filter(
        post_type=PublicPost.PostType.ANNOUNCEMENT,
    )
    return render(request, "public_portal/announcement_list.html", {"posts": posts})


def result_list(request):
    posts = PublicPost.published_public().filter(
        post_type=PublicPost.PostType.RESULT_PUBLICATION,
    )
    return render(request, "public_portal/result_list.html", {"posts": posts})
