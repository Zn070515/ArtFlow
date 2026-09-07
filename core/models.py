from common.authority import (
    ACTIVITY_STATE,
    AuthorityQuerySetMixin,
    TEST_DATA_CLEANUP,
    authority_authorized,
    parse_bulk_create_options,
)
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models, router, transaction


class ActivityQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    lifecycle_fields = {"is_test_mode", "data_lifecycle"}
    state_fields = {"phase", "is_locked", "locked_at", "locked_by", "locked_by_id"}

    def _ensure_state_authorized(self, fields):
        if self.state_fields.intersection(fields) and not authority_authorized(ACTIVITY_STATE):
            raise ValidationError("Activity state must be changed through the lifecycle service.")

    def update(self, **kwargs):
        self._ensure_state_authorized(kwargs)
        if self.lifecycle_fields.intersection(kwargs):
            raise ValidationError("Activity lifecycle must be changed through Activity.save().")
        return super().update(**kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        objs = list(objs)
        options = parse_bulk_create_options(args, kwargs)
        if options.update_conflicts and self.lifecycle_fields.intersection(options.update_fields):
            raise ValidationError("Activity lifecycle must be changed through Activity.save().")
        if (
            options.update_conflicts
            and self.state_fields.intersection(options.update_fields)
            and not authority_authorized(ACTIVITY_STATE)
        ):
            raise ValidationError("Activity state must be changed through the lifecycle service.")
        for activity in objs:
            activity._ensure_initial_state_authorized()
            activity.data_lifecycle = (
                activity.DataLifecycle.TEST
                if activity.is_test_mode
                else activity.DataLifecycle.FORMAL
            )
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_state_authorized(fields)
        if self.lifecycle_fields.intersection(fields):
            raise ValidationError("Activity lifecycle must be changed through Activity.save().")
        return super().bulk_update(objs, fields, *args, **kwargs)

    def delete(self):
        for activity in self:
            activity._ensure_deletion_authorized()  # type: ignore[attr-defined]
        return super().delete()


ActivityManager = models.Manager.from_queryset(ActivityQuerySet)


class Activity(models.Model):
    class Type(models.TextChoices):
        SINGER_CONTEST = "singer_contest", "歌手比赛"
        FAREWELL_SHOW = "farewell_show", "毕晚"
        GENERAL = "general", "普通活动"

    class Phase(models.TextChoices):
        DRAFT = "draft", "草稿"
        TESTING = "testing", "测试/彩排"
        REGISTRATION_OPEN = "registration_open", "报名中"
        REGISTRATION_CLOSED = "registration_closed", "报名截止"
        REVIEWING = "reviewing", "审核中"
        REHEARSAL = "rehearsal", "彩排中"
        LIVE = "live", "现场进行中"
        RESULTS_PENDING = "results_pending", "结果整理中"
        RESULTS_PUBLISHED = "results_published", "结果公示中"
        ARCHIVED = "archived", "已归档"

    class DataLifecycle(models.TextChoices):
        TEST = "test", "测试数据"
        FORMAL = "formal", "正式数据"

    title = models.CharField(max_length=200)
    subtitle = models.CharField(max_length=400, blank=True)
    activity_type = models.CharField(max_length=20, choices=Type)
    phase = models.CharField(max_length=24, choices=Phase, default=Phase.DRAFT)
    description = models.TextField(blank=True)
    cover_image = models.ImageField(upload_to="activities/covers/", blank=True)
    is_test_mode = models.BooleanField(default=True)
    data_lifecycle = models.CharField(
        max_length=12,
        choices=DataLifecycle,
        default=DataLifecycle.TEST,
    )
    is_locked = models.BooleanField(default=False)
    locked_at = models.DateTimeField(null=True, blank=True)
    locked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="locked_activities",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    objects = ActivityManager()

    class Meta:
        verbose_name_plural = "activities"
        ordering = ["-created_at"]
        base_manager_name = "objects"

    def __str__(self):
        return self.title

    def _ensure_initial_state_authorized(self):
        if authority_authorized(ACTIVITY_STATE):
            return
        if (
            self.phase != self.Phase.DRAFT
            or self.is_locked
            or self.locked_at is not None
            or self.locked_by_id is not None
        ):
            raise ValidationError("Activity must be created in the unlocked DRAFT phase.")

    def _has_related_data(self):
        for relation in self._meta.related_objects:
            child_model = relation.related_model
            children = child_model._base_manager.filter(**{relation.field.name: self.pk})
            if children.exists():
                return True
        return False

    def _ensure_deletion_authorized(self):
        if not authority_authorized(TEST_DATA_CLEANUP):
            raise ValidationError(
                "Activity deletion requires the explicit test-data cleanup authority."
            )
        if (
            not self.is_test_mode
            or self.data_lifecycle != self.DataLifecycle.TEST
            or self.phase != self.Phase.DRAFT
            or self.is_locked
        ):
            raise ValidationError("Only unlocked TEST activities in DRAFT may be deleted.")
        if self._has_related_data():
            raise ValidationError("Activities with related data cannot be deleted.")

    def delete(self, *args, **kwargs):
        self._ensure_deletion_authorized()
        return super().delete(*args, **kwargs)

    def save(self, *args, **kwargs):
        allow_transition = kwargs.pop("_allow_lifecycle_transition", False)
        if self._state.adding:
            self._ensure_initial_state_authorized()
            self.data_lifecycle = (
                self.DataLifecycle.TEST if self.is_test_mode else self.DataLifecycle.FORMAL
            )
        else:
            using = (
                kwargs.get("using")
                or self._state.db
                or router.db_for_write(type(self), instance=self)
            )
            kwargs["using"] = using
            with transaction.atomic(using=using):
                persisted_lifecycle = (
                    type(self)
                    ._default_manager.using(using)
                    .select_for_update()
                    .filter(pk=self.pk)
                    .values_list("data_lifecycle", flat=True)
                    .first()
                )
                persisted_state = (
                    type(self)
                    ._base_manager.using(using)
                    .filter(pk=self.pk)
                    .values("phase", "is_locked", "locked_at", "locked_by_id")
                    .first()
                )
                if (
                    persisted_state
                    and not authority_authorized(ACTIVITY_STATE)
                    and (
                        persisted_state["phase"] != self.phase
                        or persisted_state["is_locked"] != self.is_locked
                        or persisted_state["locked_at"] != self.locked_at
                        or persisted_state["locked_by_id"] != self.locked_by_id
                    )
                ):
                    raise ValidationError(
                        "Activity state must be changed through the lifecycle service."
                    )
                if persisted_lifecycle == self.DataLifecycle.FORMAL:
                    if self.is_test_mode or self.data_lifecycle == self.DataLifecycle.TEST:
                        raise ValidationError("Formal activities cannot re-enter test mode.")
                    self.is_test_mode = False
                    self.data_lifecycle = self.DataLifecycle.FORMAL
                elif self.is_test_mode:
                    self.data_lifecycle = self.DataLifecycle.TEST
                else:
                    if not allow_transition:
                        raise ValidationError(
                            "Activity lifecycle must be changed through the lifecycle service."
                        )
                    self.is_test_mode = False
                    self.data_lifecycle = self.DataLifecycle.FORMAL

                update_fields = kwargs.get("update_fields")
                if update_fields is not None:
                    kwargs["update_fields"] = set(update_fields) | {
                        "data_lifecycle",
                        "is_test_mode",
                    }
                return super().save(*args, **kwargs)

        update_fields = kwargs.get("update_fields")
        if update_fields is not None:
            kwargs["update_fields"] = set(update_fields) | {
                "data_lifecycle",
                "is_test_mode",
            }
        return super().save(*args, **kwargs)


class ActivityPhase(models.Model):
    activity = models.ForeignKey(Activity, on_delete=models.CASCADE, related_name="phase_records")
    phase = models.CharField(max_length=24, choices=Activity.Phase.choices)
    name = models.CharField(max_length=100, blank=True)
    starts_at = models.DateTimeField(null=True, blank=True)
    ends_at = models.DateTimeField(null=True, blank=True)
    sort_order = models.IntegerField(default=0)
    note = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["sort_order", "starts_at", "pk"]
        unique_together = [("activity", "phase")]

    def __str__(self):
        return f"{self.activity.title} - {self.name or self.get_phase_display()}"


class QRCodeLink(models.Model):
    class Kind(models.TextChoices):
        REGISTRATION = "registration", "报名入口"
        VOTE = "vote", "投票入口"
        RESULTS = "results", "结果公示"
        MATERIAL_SUPPLEMENT = "material_supplement", "材料补交"
        PROFILE = "profile", "个人中心"
        CUSTOM = "custom", "自定义"

    activity = models.ForeignKey(Activity, on_delete=models.CASCADE, related_name="qr_links")
    kind = models.CharField(max_length=24, choices=Kind.choices)
    title = models.CharField(max_length=100)
    target_url = models.CharField(max_length=500)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_qr_links",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["activity", "kind", "pk"]
        unique_together = [("activity", "kind", "target_url")]

    def __str__(self):
        return f"{self.activity.title} - {self.title}"
