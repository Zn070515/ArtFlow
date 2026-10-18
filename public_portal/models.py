from typing import TYPE_CHECKING, Any

from common.authority import (
    RESULT_RELEASE_STATE,
    AuthorityQuerySetMixin,
    authority_authorized,
    parse_bulk_create_options,
)
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Exists, F, OuterRef, Q, Subquery


class PublicPostQuerySet(models.QuerySet):
    """An ACTIVE release freezes the post surface; every mutation must revoke first."""

    def _ensure_not_released(self) -> None:
        if ResultRelease.objects.filter(
            post_id__in=self.values("pk"), status=ResultRelease.Status.ACTIVE
        ).exists():
            raise ValidationError("结果已公示，编辑或移动前必须先撤销当前结果发布。")

    def update(self, **kwargs) -> int:
        self._ensure_not_released()
        return super().update(**kwargs)

    def delete(self) -> Any:
        self._ensure_not_released()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs) -> list[Any]:
        if parse_bulk_create_options(args, kwargs).update_conflicts:
            raise ValidationError("公开文章不允许通过 conflict upsert 修改。")
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs) -> int:
        # Only the rows actually being written matter: a result post elsewhere in the
        # table must not freeze an unrelated announcement edit.
        pks = [obj.pk for obj in objs if getattr(obj, "pk", None)]
        if ResultRelease.objects.filter(
            post_id__in=pks, status=ResultRelease.Status.ACTIVE
        ).exists():
            raise ValidationError("结果已公示，编辑或移动前必须先撤销当前结果发布。")
        return super().bulk_update(objs, fields, *args, **kwargs)


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
        result_releases: models.Manager["ResultRelease"]

        def get_post_type_display(self) -> str: ...

        def get_status_display(self) -> str: ...

    class Meta:
        base_manager_name = "objects"
        ordering = ["-is_pinned", "sort_order", "-created_at"]
        # `cover_image` is the third exact-path lookup the media gateway makes.
        indexes = [models.Index(fields=["cover_image"], name="publicpost_cover_idx")]

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
            candidate_revision=F("stage_result__candidate_revision"),
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

    objects = PublicPostQuerySet.as_manager()

    def save(self, *args: Any, **kwargs: Any) -> None:
        if (
            not self._state.adding
            and self.pk
            and ResultRelease.objects.filter(
                post_id=self.pk, status=ResultRelease.Status.ACTIVE
            ).exists()
        ):
            raise ValidationError("结果已公示，编辑或移动前必须先撤销当前结果发布。")
        super().save(*args, **kwargs)

    def delete(self, *args: Any, **kwargs: Any) -> Any:
        if (
            self.pk
            and ResultRelease.objects.filter(
                post_id=self.pk, status=ResultRelease.Status.ACTIVE
            ).exists()
        ):
            raise ValidationError("结果已公示，删除前必须先撤销当前结果发布。")
        return super().delete(*args, **kwargs)

    @property
    def public_title(self) -> str:
        """The public heading for a result publication, generated from the activity.

        A formal result's public identity must not be an editable title: the title can
        contradict the snapshot. ``published_public()`` only exposes result posts that
        have a valid active release, so this system title is the one those readers see.
        """

        if self.post_type != self.PostType.RESULT_PUBLICATION:
            return self.title
        release = (
            self.result_releases.filter(status=ResultRelease.Status.ACTIVE).order_by("-pk").first()
        )
        frozen_title = (release.result_snapshot or {}).get("public_title") if release else ""
        if frozen_title:
            return str(frozen_title)
        activity = self.related_activity if self.related_activity_id else None
        activity_title = activity.title if activity is not None else ""
        return f"{activity_title} · 正式赛果" if activity_title else "正式赛果"

    def __str__(self):
        return self.title


class ResultReleaseQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    """Guard: a release (and especially its public snapshot) is a formal fact."""

    def _ensure_auth(self) -> None:
        if not authority_authorized(RESULT_RELEASE_STATE):
            raise ValidationError("结果发布记录只能通过正式发布服务写入。")

    def update(self, **kwargs) -> int:
        self._ensure_auth()
        return super().update(**kwargs)

    def delete(self) -> Any:
        self._ensure_auth()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs) -> list[Any]:
        self._ensure_auth()
        if parse_bulk_create_options(args, kwargs).update_conflicts:
            raise ValidationError("结果发布记录不能通过冲突 upsert 写入。")
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs) -> int:
        self._ensure_auth()
        return super().bulk_update(objs, fields, *args, **kwargs)


ResultReleaseManager = models.Manager.from_queryset(ResultReleaseQuerySet)


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
    #: Candidate generation within one raw-facts generation. A later correction can reuse
    #: the same StageResult row, so this (plus the snapshot below) is what makes a
    #: historical release describe what was actually published at the time.
    candidate_revision = models.PositiveBigIntegerField(default=0)
    result_snapshot = models.JSONField(
        default=dict,
        blank=True,
        help_text="Frozen decisions/awards published with this release.",
    )
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

    objects = ResultReleaseManager()

    if TYPE_CHECKING:
        # Django creates the ``<fk>_id`` shadow attributes at runtime; declare them so
        # Pylance can see them (see AGENTS.md, Pylance & Pyright Type Checking).
        post_id: int
        stage_result_id: int
        ruleset_version_id: int

        def get_status_display(self) -> str: ...

    class Meta:
        base_manager_name = "objects"
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

    def save(self, *args: Any, **kwargs: Any) -> None:
        if not authority_authorized(RESULT_RELEASE_STATE):
            raise ValidationError("结果发布记录只能通过正式发布服务写入。")
        self.full_clean()
        super().save(*args, **kwargs)

    def delete(self, *args: Any, **kwargs: Any) -> Any:
        if not authority_authorized(RESULT_RELEASE_STATE):
            raise ValidationError("结果发布记录只能通过正式发布服务删除。")
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.post} — {self.stage_result} ({self.get_status_display()})"


class PublicMediaQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    """Media of a released post is frozen with the post itself."""

    def _ensure_not_released(self) -> None:
        if ResultRelease.objects.filter(
            post_id__in=self.values("post_id"), status=ResultRelease.Status.ACTIVE
        ).exists():
            raise ValidationError("所属文章的结果已公示，编辑媒体前必须先撤销结果发布。")

    def update(self, **kwargs) -> int:
        self._ensure_not_released()
        return super().update(**kwargs)

    def delete(self) -> Any:
        self._ensure_not_released()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs) -> list[Any]:
        if parse_bulk_create_options(args, kwargs).update_conflicts:
            raise ValidationError("公开媒体不允许通过 conflict upsert 修改。")
        post_ids = {obj.post_id for obj in objs if obj.post_id}
        if ResultRelease.objects.filter(
            post_id__in=post_ids, status=ResultRelease.Status.ACTIVE
        ).exists():
            raise ValidationError("所属文章的结果已公示，新增媒体前必须先撤销结果发布。")
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs) -> int:
        pks = [obj.pk for obj in objs if getattr(obj, "pk", None)]
        stored_post_ids = set(
            PublicMedia._base_manager.filter(pk__in=pks).values_list("post_id", flat=True)
        )
        post_ids = {obj.post_id for obj in objs if obj.post_id} | stored_post_ids
        if ResultRelease.objects.filter(
            post_id__in=post_ids, status=ResultRelease.Status.ACTIVE
        ).exists():
            raise ValidationError("所属文章的结果已公示，编辑媒体前必须先撤销结果发布。")
        return super().bulk_update(objs, fields, *args, **kwargs)


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

    if TYPE_CHECKING:
        post_id: int

    objects = PublicMediaQuerySet.as_manager()

    def save(self, *args: Any, **kwargs: Any) -> None:
        if (
            self.post_id
            and ResultRelease.objects.filter(
                post_id=self.post_id, status=ResultRelease.Status.ACTIVE
            ).exists()
        ):
            raise ValidationError("所属文章的结果已公示，编辑媒体前必须先撤销结果发布。")
        super().save(*args, **kwargs)

    def delete(self, *args: Any, **kwargs: Any) -> Any:
        if (
            self.post_id
            and ResultRelease.objects.filter(
                post_id=self.post_id, status=ResultRelease.Status.ACTIVE
            ).exists()
        ):
            raise ValidationError("所属文章的结果已公示，删除媒体前必须先撤销结果发布。")
        return super().delete(*args, **kwargs)

    class Meta:
        base_manager_name = "objects"
        ordering = ["sort_order", "pk"]
        # Same reason as `SubmissionFile`: the media gateway finds a public image by exact
        # path, on a column that had no index.
        indexes = [models.Index(fields=["image"], name="publicmedia_image_idx")]

    def __str__(self):
        return self.caption or self.original_name or f"Media {self.pk}"
