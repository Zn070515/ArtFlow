from typing import TYPE_CHECKING

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Exists, F, OuterRef, Q, Subquery


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

    if TYPE_CHECKING:
        related_activity_id: int | None
        media_items: models.Manager["PublicMedia"]

    class Meta:
        ordering = ["-is_pinned", "sort_order", "-created_at"]

    @classmethod
    def published_public(cls):
        """Published posts that are safe to show on the public site.

        Defense-in-depth: a publication tied to a TEST activity must never be
        public. Posts with no related activity (or a FORMAL one) remain public,
        while TEST-related rows are excluded even if they were published by
        legacy/dirty history. Result publications additionally require the
        exact current active release of a confirmed stage result.
        """
        from core.models import Activity
        from ruleset.models import RulesetVersion
        from singer_contest.models import StageResult

        latest_stage_result_version = (
            StageResult.objects.filter(
                activity_id=OuterRef("stage_result__activity_id"),
                stage_key=OuterRef("stage_result__stage_key"),
            )
            .order_by("-result_version", "-pk")
            .values("result_version")[:1]
        )
        active_result_release = ResultRelease.objects.filter(
            post_id=OuterRef("pk"),
            status=ResultRelease.Status.ACTIVE,
            post_version=F("post__version"),
            result_version=F("stage_result__result_version"),
            ruleset_version_id=F("stage_result__ruleset_version_id"),
            authority_hash=F("stage_result__ruleset_hash"),
            input_fingerprint=F("stage_result__input_fingerprint"),
            stage_result__status=StageResult.Status.CONFIRMED,
            stage_result__activity_id=F("post__related_activity_id"),
            stage_result__ruleset_version__status=RulesetVersion.Status.FROZEN,
            stage_result__ruleset_version__is_current=True,
            stage_result__ruleset_version__ruleset__activity_id=F("post__related_activity_id"),
            stage_result__result_version=Subquery(latest_stage_result_version),
        )

        return (
            cls.objects.filter(status=cls.Status.PUBLISHED)
            .exclude(related_activity__data_lifecycle=Activity.DataLifecycle.TEST)
            .filter(~Q(post_type=cls.PostType.RESULT_PUBLICATION) | Exists(active_result_release))
        )

    def __str__(self):
        return self.title


class ResultRelease(models.Model):
    """Historical authority records that can expose a closed stage result."""

    class Status(models.TextChoices):
        ACTIVE = "active", "生效"
        REVOKED = "revoked", "已撤销"
        SUPERSEDED = "superseded", "已被新版本取代"

    post = models.ForeignKey(
        PublicPost,
        on_delete=models.PROTECT,
        related_name="result_releases",
    )
    stage_result = models.ForeignKey(
        "singer_contest.StageResult",
        on_delete=models.PROTECT,
        related_name="result_releases",
    )
    post_version = models.PositiveIntegerField()
    result_version = models.PositiveIntegerField()
    ruleset_version = models.ForeignKey(
        "ruleset.RulesetVersion",
        on_delete=models.PROTECT,
        related_name="result_releases",
    )
    authority_hash = models.CharField(max_length=64)
    input_fingerprint = models.CharField(max_length=64)
    status = models.CharField(max_length=12, choices=Status, default=Status.ACTIVE)
    released_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="result_releases",
    )
    released_at = models.DateTimeField(auto_now_add=True)
    transition_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="result_release_transitions",
    )
    transition_at = models.DateTimeField(null=True, blank=True)
    note = models.TextField()

    class Meta:
        ordering = ["-released_at", "-pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["post"],
                condition=Q(status="active"),
                name="result_release_one_active_post",
            ),
            models.UniqueConstraint(
                fields=["stage_result"],
                condition=Q(status="active"),
                name="result_release_one_active_stage",
            ),
        ]

    def clean(self):
        if self.post_id and self.stage_result_id:
            post_activity_id = self.post.related_activity_id
            stage_activity_id = self.stage_result.activity_id
            if post_activity_id != stage_activity_id:
                raise ValidationError(
                    {"post": "A result release post must match the stage result activity."}
                )
            if self.status == self.Status.ACTIVE:
                if self.post.post_type != PublicPost.PostType.RESULT_PUBLICATION:
                    raise ValidationError(
                        {"post": "An active result release requires a result publication post."}
                    )
                if self.post.status != PublicPost.Status.PUBLISHED:
                    raise ValidationError(
                        {"post": "An active result release requires a published post."}
                    )

    def save(self, *args, **kwargs):
        self.full_clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.post} — {self.stage_result} ({self.get_status_display()})"


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
