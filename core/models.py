import secrets
from typing import TYPE_CHECKING, Any

from common.authority import (
    ACTIVITY_STATE,
    TEST_DATA_CLEANUP,
    AuthorityQuerySetMixin,
    authority_authorized,
    parse_bulk_create_options,
)
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models, router, transaction

if TYPE_CHECKING:
    from singer_contest.models import ContestRound, SingerRegistration, StageResult
    from voting.models import VoteSession


_PUBLIC_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_activity_public_code() -> str:
    """Return a short, human-scannable identifier for a formal activity URL."""
    return "".join(secrets.choice(_PUBLIC_CODE_ALPHABET) for _ in range(8))


def backfill_missing_activity_public_codes(activity_model: Any, *, using: str | None = None) -> int:
    """Give every activity without a usable public code one, and report how many.

    A public code is not decoration: every public entry URL (`/e/<code>/...`), the ticket
    QR and the judge entry are built from it, so a NULL or empty one is a broken activity
    rather than a missing nicety. 0006 added the field nullable and backfilled it, 0008
    tightened it to NOT NULL, and 0011 was then edited to carry a backfill of its own —
    after some databases had already recorded 0011 as applied. Django applies a migration by
    name, so those databases never ran the added step; this function is the one place the
    backfill is stated, and 0012 runs it on its own name so every database converges.
    """
    # Through the base manager: a public code is `immutable_fields` for the application,
    # which is exactly the rule a backfill exists to repair, and migrations run historical
    # models for the same reason. Nothing outside this function un-sets a code.
    manager = activity_model._base_manager
    used = set(
        manager.using(using)
        .exclude(public_code__isnull=True)
        .exclude(public_code="")
        .values_list("public_code", flat=True)
    )
    missing = manager.using(using).filter(
        models.Q(public_code__isnull=True) | models.Q(public_code="")
    )
    filled = 0
    for activity in missing.iterator():
        code = generate_activity_public_code()
        while code in used:
            code = generate_activity_public_code()
        used.add(code)
        manager.using(using).filter(pk=activity.pk).update(public_code=code)
        filled += 1
    return filled


class ActivityQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    lifecycle_fields = {"is_test_mode", "data_lifecycle"}
    state_fields = {
        "phase",
        "is_locked",
        "locked_at",
        "locked_by",
        "locked_by_id",
        "judge_entry_open",
        "judge_entry_version",
    }
    immutable_fields = {"activity_type", "public_code"}

    def _ensure_state_authorized(self, fields):
        if self.state_fields.intersection(fields) and not authority_authorized(ACTIVITY_STATE):
            raise ValidationError("Activity state must be changed through the lifecycle service.")

    def update(self, **kwargs):
        if self.immutable_fields.intersection(kwargs):
            raise ValidationError("Activity type and public code cannot be changed.")
        self._ensure_state_authorized(kwargs)
        if self.lifecycle_fields.intersection(kwargs):
            raise ValidationError("Activity lifecycle must be changed through Activity.save().")
        return super().update(**kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        objs = list(objs)
        options = parse_bulk_create_options(args, kwargs)
        if options.update_conflicts and self.immutable_fields.intersection(options.update_fields):
            raise ValidationError("Activity type and public code cannot be changed.")
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
            if not activity.public_code:
                activity.public_code = generate_activity_public_code()
            activity.data_lifecycle = (
                activity.DataLifecycle.TEST
                if activity.is_test_mode
                else activity.DataLifecycle.FORMAL
            )
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        if self.immutable_fields.intersection(fields):
            raise ValidationError("Activity type and public code cannot be changed.")
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
    public_code = models.CharField(
        max_length=8,
        unique=True,
        editable=False,
        default=generate_activity_public_code,
    )
    judge_entry_open = models.BooleanField(
        default=False,
        db_default=False,
        help_text="评委入口是否暂时开放；关闭后已入席的评委不受影响，新扫描被拒。",
    )
    judge_entry_version = models.PositiveIntegerField(
        default=1,
        help_text=(
            "评委共享二维码的凭证版本。递增即让已发出的那张码立即失效——"
            "二维码泄漏时用它重发，而不必关闭整个入口。"
        ),
    )
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

    if TYPE_CHECKING:
        vote_sessions: models.Manager[VoteSession]
        rounds: models.Manager[ContestRound]
        singer_registrations: models.Manager[SingerRegistration]
        stage_results: models.Manager[StageResult]
        locked_by_id: int | None

        def get_activity_type_display(self) -> str: ...

        def get_phase_display(self) -> str: ...

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
            if not self.public_code:
                self.public_code = generate_activity_public_code()
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
                    .values(
                        "activity_type",
                        "public_code",
                        "phase",
                        "is_locked",
                        "locked_at",
                        "locked_by_id",
                        "judge_entry_open",
                        "judge_entry_version",
                    )
                    .first()
                )
                if (
                    persisted_state
                    and persisted_state["public_code"] is None
                    and not self.public_code
                ):
                    self.public_code = generate_activity_public_code()
                if persisted_state and persisted_state["activity_type"] != self.activity_type:
                    raise ValidationError("活动类型创建后不可修改。")
                if (
                    persisted_state
                    and persisted_state["public_code"] is not None
                    and persisted_state["public_code"] != self.public_code
                ):
                    raise ValidationError("活动公开入口编码创建后不可修改。")
                if (
                    persisted_state
                    and not authority_authorized(ACTIVITY_STATE)
                    and (
                        persisted_state["phase"] != self.phase
                        or persisted_state["is_locked"] != self.is_locked
                        or persisted_state["locked_at"] != self.locked_at
                        or persisted_state["locked_by_id"] != self.locked_by_id
                        or persisted_state["judge_entry_open"] != self.judge_entry_open
                        or persisted_state["judge_entry_version"] != self.judge_entry_version
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
