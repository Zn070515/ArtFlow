from core.models import Activity
from django.db.models import Prefetch
from django.http import Http404, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_GET
from voting.models import VoteSession
from voting.policies import vote_ui_state

from .models import PublicMedia, PublicPost


def _public_contest(request, public_code: str) -> Activity:
    """Resolve a stable public contest code without exposing rehearsal data."""
    activities = Activity.objects.filter(
        public_code=public_code,
        activity_type=Activity.Type.SINGER_CONTEST,
    )
    is_staff = bool(
        getattr(request.user, "is_authenticated", False)
        and getattr(request.user, "is_staff_or_admin", False)
    )
    if not is_staff:
        activities = activities.filter(data_lifecycle=Activity.DataLifecycle.FORMAL)
    try:
        return activities.get()
    except Activity.DoesNotExist as error:
        raise Http404("Activity not found.") from error


def _activity_result_posts(activity: Activity):
    return PublicPost.published_public().filter(
        related_activity=activity,
        post_type=PublicPost.PostType.RESULT_PUBLICATION,
    )


def activity_entry(request, public_code: str):
    activity = _public_contest(request, public_code)
    result_post = _activity_result_posts(activity).first()
    return render(
        request,
        "public_portal/activity_entry.html",
        {"activity": activity, "result_post": result_post},
    )


def activity_apply(request, public_code: str):
    activity = _public_contest(request, public_code)
    return redirect("register:activity", activity_pk=activity.pk)


def activity_live(request, public_code: str):
    activity = _public_contest(request, public_code)
    now = timezone.now()
    vote_session = (
        VoteSession.objects.filter(
            activity=activity,
            is_open=True,
            is_locked=False,
        )
        .order_by("start_time", "pk")
        .first()
    )
    vote_state, vote_state_label, vote_is_active = (
        vote_ui_state(vote_session, now)
        if vote_session
        else ("waiting", "当前暂无开放投票", False)
    )
    result_post = _activity_result_posts(activity).first()
    return render(
        request,
        "public_portal/activity_live.html",
        {
            "activity": activity,
            "vote_session": vote_session,
            "vote_is_active": vote_is_active,
            "vote_state": vote_state,
            "vote_state_label": vote_state_label,
            "result_post": result_post,
            "now": now,
        },
    )


@require_GET
def activity_live_state(request, public_code: str):
    activity = _public_contest(request, public_code)
    now = timezone.now()
    vote_session = (
        VoteSession.objects.filter(activity=activity, is_open=True, is_locked=False)
        .order_by("start_time", "pk")
        .first()
    )
    if vote_session is None:
        state, label, can_submit = "waiting", "当前暂无开放投票", False
    else:
        state, label, can_submit = vote_ui_state(vote_session, now)
    result_post = _activity_result_posts(activity).first()
    revision = ":".join(
        [
            str(vote_session.pk if vote_session else 0),
            state,
            str(vote_session.start_time.timestamp() if vote_session else 0),
            str(vote_session.end_time.timestamp() if vote_session else 0),
            str(result_post.pk if result_post else 0),
        ]
    )
    response = JsonResponse(
        {
            "revision": revision,
            "state": state,
            "label": label,
            "vote_name": vote_session.name if vote_session else "",
            "vote_url": (
                reverse("voting:vote_entry", args=[vote_session.pk])
                if vote_session and can_submit
                else None
            ),
            "result_url": (
                reverse("public_portal:post_detail", args=[result_post.pk])
                if result_post
                else None
            ),
        }
    )
    response["Cache-Control"] = "no-store"
    response["Pragma"] = "no-cache"
    return response


def activity_judge(request, public_code: str):
    activities = Activity.objects.filter(
        public_code=public_code,
        activity_type=Activity.Type.SINGER_CONTEST,
    )
    is_staff = bool(
        getattr(request.user, "is_authenticated", False)
        and getattr(request.user, "is_staff_or_admin", False)
    )
    if not is_staff:
        activities = activities.filter(
            data_lifecycle=Activity.DataLifecycle.FORMAL
        ) | activities.filter(
            data_lifecycle=Activity.DataLifecycle.TEST,
            judge_entry_open=True,
        )
    try:
        activity = activities.get()
    except Activity.DoesNotExist as error:
        raise Http404("Activity not found.") from error
    return render(
        request,
        "singer_contest/judge_terminal.html",
        {
            "activity": activity,
            "claim_url": f"/judge/claim/{activity.public_code}/",
        },
    )


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


def privacy(request):
    return render(request, "public_portal/privacy.html")
