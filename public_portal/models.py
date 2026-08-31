from django.conf import settings
from django.db import models


class PublicPost(models.Model):
    class PostType(models.TextChoices):
        ANNOUNCEMENT = "announcement", "通知公告"
        SHOWCASE = "showcase", "往届风采"
        ACTIVITY_REVIEW = "activity_review", "活动回顾"
        REGISTRATION_ENTRY = "registration_entry", "报名入口"
        VOTING_ENTRY = "voting_entry", "投票入口"
        RESULT_PUBLICATION = "result_publication", "结果公示"
        NORMAL_ARTICLE = "normal_article", "普通文章"

    class Status(models.TextChoices):
        DRAFT = "draft", "草稿"
        PUBLISHED = "published", "已发布"
        HIDDEN = "hidden", "已隐藏"

    title = models.CharField(max_length=200)
    subtitle = models.CharField(max_length=400, blank=True)
    content = models.TextField(blank=True)
    cover_image = models.ImageField(upload_to="public/covers/", blank=True)
    post_type = models.CharField(max_length=22, choices=PostType, default=PostType.NORMAL_ARTICLE)
    status = models.CharField(max_length=12, choices=Status, default=Status.DRAFT)
    related_activity = models.ForeignKey(
        "core.Activity",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="public_posts",
    )
    is_pinned = models.BooleanField(default=False)
    sort_order = models.IntegerField(default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_posts",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="updated_posts",
    )
    published_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    # Optimistic concurrency: bumped on every save so a stale edit form (two
    # staff editing the same post) fails with an explicit "已过期" instead of
    # silently overwriting a co-editor's content.
    version = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["-is_pinned", "sort_order", "-created_at"]

    @classmethod
    def published_public(cls):
        """Published posts that are safe to show on the public site.

        Defense-in-depth: a publication tied to a TEST activity must never be
        public. Posts with no related activity (or a FORMAL one) remain public,
        while TEST-related rows are excluded even if they were published by
        legacy/dirty history.
        """
        from core.models import Activity

        return cls.objects.filter(status=cls.Status.PUBLISHED).exclude(
            related_activity__data_lifecycle=Activity.DataLifecycle.TEST
        )

    def __str__(self):
        return self.title


class PublicMedia(models.Model):
    post = models.ForeignKey(PublicPost, on_delete=models.CASCADE, related_name="media_items")
    related_activity = models.ForeignKey(
        "core.Activity",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="public_media",
    )
    image = models.ImageField(upload_to="public/gallery/%Y/%m/")
    caption = models.CharField(max_length=200, blank=True)
    original_name = models.CharField(max_length=255, blank=True)
    source_path = models.TextField(blank=True)
    is_published = models.BooleanField(default=True)
    sort_order = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["sort_order", "pk"]

    def __str__(self):
        return self.caption or self.original_name or f"Media {self.pk}"
