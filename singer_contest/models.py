import json
import threading
from typing import TYPE_CHECKING, Any, cast

from common.authority import (
    CONTEST_ROUND_STATE,
    JUDGE_PANEL_STATE,
    JUDGE_SESSION_STATE,
    ROUND_PERFORMANCE_STATE,
    SCORE_SUMMARY_RECALCULATE,
    STAGE_RESULT_CONFIRM,
    TEST_DATA_CLEANUP,
    AuthorityQuerySetMixin,
    authority_authorized,
    parse_bulk_create_options,
)
from common.lifecycle import runtime_is_test
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q
from ruleset.resolver import OutcomeCode, ResolverState

from .deletion import cascade_draft_snapshots_or_protect_prepared

if TYPE_CHECKING:
    from files.models import MaterialCheck, StaffNote, SubmissionFile

# M1-R9 (§三 ManualDecision Authority): a ManualDecision is a human picking a MANUAL_SELECT
# outcome that a CONFIRMED stage may have already read, so its mutation must run through a
# formal service that holds the Activity lock (Activity → RulesetVersion/ManualDecision) and
# re-checks the consumed-by-confirmed guard inside that window. Direct ``.save()``/``.delete()``
# bypass the lock, so they are refused unless the service is actively wrapping the write. The
# guard is thread-local so concurrent service calls in separate threads don't leak into each other.
_manual_writes = threading.local()
_duel_writes = threading.local()
_raw_fact_writes = threading.local()
_award_materializations = threading.local()
_score_receipt_bulk_updates = threading.local()


def _manual_write_authorized() -> bool:
    return bool(getattr(_manual_writes, "authorized", False))


def _authorize_manual_write(authorized: bool) -> None:
    _manual_writes.authorized = authorized


def _duel_write_authorized() -> bool:
    return bool(getattr(_duel_writes, "authorized", False))


def _authorize_duel_write(authorized: bool) -> None:
    _duel_writes.authorized = authorized


def _raw_fact_write_authorized() -> bool:
    return bool(getattr(_raw_fact_writes, "authorized", False))


def _authorize_raw_fact_write(authorized: bool) -> None:
    _raw_fact_writes.authorized = authorized


def _award_materialization_authorized() -> bool:
    return bool(getattr(_award_materializations, "authorized", False))


def _authorize_award_materialization(authorized: bool) -> None:
    _award_materializations.authorized = authorized


def _score_receipt_bulk_update_authorized() -> bool:
    return bool(getattr(_score_receipt_bulk_updates, "authorized", False))


def _authorize_score_receipt_bulk_update(authorized: bool) -> None:
    _score_receipt_bulk_updates.authorized = authorized


def _ensure_round_raw_fact_mutable(round_id: int | None) -> None:
    """Keep raw score facts immutable once the round/result authority is closed."""
    if not round_id or _raw_fact_write_authorized():
        return
    round_status = (
        ContestRound._base_manager.filter(pk=round_id).values("status", "is_locked").first()
    )
    if not round_status:
        return
    if round_status["status"] == ContestRound.Status.LOCKED or round_status["is_locked"]:
        raise ValidationError("该轮次已锁定，原始评分事实不可直接修改。")
    from .services import ensure_round_not_consumed_by_confirmed_stage

    ensure_round_not_consumed_by_confirmed_stage(ContestRound._base_manager.get(pk=round_id))


def _ensure_round_queryset_mutable(queryset) -> None:
    if _raw_fact_write_authorized():
        return
    if queryset.filter(
        Q(round__status=ContestRound.Status.LOCKED) | Q(round__is_locked=True)
    ).exists():
        raise ValidationError("该轮次已锁定，原始评分事实不可直接修改。")
    for round_id in queryset.values_list("round_id", flat=True).distinct():
        _ensure_round_raw_fact_mutable(round_id)


def _ensure_round_setup_fact_mutable(round_id: int | None) -> None:
    """Prevent roster/group setup facts changing after a round snapshot is prepared."""
    if not round_id or _raw_fact_write_authorized():
        return
    status = ContestRound._base_manager.filter(pk=round_id).values_list("status", flat=True).first()
    if status is not None and status != ContestRound.Status.DRAFT:
        raise ValidationError("轮次已准备，表演/分组事实不可直接修改。")
    from .services import ensure_round_not_consumed_by_confirmed_stage

    ensure_round_not_consumed_by_confirmed_stage(ContestRound._base_manager.get(pk=round_id))


def _ensure_rubric_mutable(rubric_id: int | None) -> None:
    if not rubric_id or _raw_fact_write_authorized():
        return
    if ScoringRubric._base_manager.filter(
        pk=rubric_id,
        rounds__status__in=[
            ContestRound.Status.PREPARED,
            ContestRound.Status.SCORING,
            ContestRound.Status.LOCKED,
        ],
    ).exists():
        raise ValidationError("已被准备轮次使用的评分标准不可直接修改。")


def _stored_fk_id(instance, field: str) -> int | None:
    if instance._state.adding or not instance.pk:
        return None
    return (
        type(instance)
        ._base_manager.filter(pk=instance.pk)
        .values_list(f"{field}_id", flat=True)
        .first()
    )


def _ensure_identity_ownership_unchanged(instance, fields: frozenset[str]) -> None:
    """Keep an existing contest identity bound to its original owner."""
    if instance._state.adding or not instance.pk:
        return
    stored = type(instance)._base_manager.filter(pk=instance.pk).values(*fields).first()
    if stored and any(stored[field] != getattr(instance, field) for field in fields):
        raise ValidationError("比赛身份归属创建后不可修改。")


def _reject_conflict_upsert(args, kwargs, model_name: str) -> None:
    if parse_bulk_create_options(args, kwargs).update_conflicts:
        raise ValidationError(
            f"{model_name} does not support bulk_create(update_conflicts=True); "
            "use the audited authority service or ordinary bulk_create()."
        )


class IdentityOwnershipQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    ownership_fields: frozenset[str] = frozenset()

    def _update_ownership_fields(self) -> set[str]:
        return {field.removesuffix("_id") for field in self.ownership_fields} | set(
            self.ownership_fields
        )

    def _ensure_ownership_update_immutable(self, fields) -> None:
        if self._update_ownership_fields().intersection(fields):
            raise ValidationError("比赛身份归属创建后不可修改。")

    def update(self, **kwargs):
        self._ensure_ownership_update_immutable(kwargs)
        return super().update(**kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        objs = list(objs)
        self._ensure_ownership_update_immutable(fields)
        for obj in objs:
            _ensure_identity_ownership_unchanged(obj, self.ownership_fields)
        return super().bulk_update(objs, fields, *args, **kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        return super().bulk_create(objs, *args, **kwargs)


class SingerRegistrationQuerySet(IdentityOwnershipQuerySet):
    ownership_fields = frozenset({"activity_id", "user_id"})


class JudgeQuerySet(IdentityOwnershipQuerySet):
    ownership_fields = frozenset({"activity_id"})


class SingerRegistrationManager(models.Manager.from_queryset(SingerRegistrationQuerySet)):  # type: ignore[misc]
    pass


class JudgeManager(models.Manager.from_queryset(JudgeQuerySet)):  # type: ignore[misc]
    pass


def _relation_pk(value):
    return getattr(value, "pk", value)


def _ensure_stage_result_mutable(stage_result_id: int | None) -> None:
    if (
        stage_result_id
        and StageResult._base_manager.filter(
            pk=stage_result_id, status=StageResult.Status.CONFIRMED
        ).exists()
    ):
        raise ValidationError("已核定赛段的派生结果不可直接修改。")


def _ensure_stage_result_origins(*stage_result_ids: int | None) -> None:
    for stage_result_id in dict.fromkeys(
        stage_result_id for stage_result_id in stage_result_ids if stage_result_id
    ):
        _ensure_stage_result_mutable(stage_result_id)


def _stage_result_activity_id(stage_result_id: int | None) -> int | None:
    if not stage_result_id:
        return None
    return (
        StageResult._base_manager.filter(pk=stage_result_id)
        .values_list("activity_id", flat=True)
        .first()
    )


def _singer_activity_id(singer_id: int | None) -> int | None:
    if not singer_id:
        return None
    return (
        SingerRegistration._base_manager.filter(pk=singer_id)
        .values_list("activity_id", flat=True)
        .first()
    )


def _ensure_same_activity_stage_child_update(
    queryset,
    kwargs,
    *,
    has_activity_field: bool = False,
) -> None:
    relation_fields = {"stage_result", "stage_result_id", "singer", "singer_id"}
    if has_activity_field:
        relation_fields |= {"activity", "activity_id"}
    if not relation_fields.intersection(kwargs):
        return
    new_stage_id = _relation_pk(kwargs.get("stage_result", kwargs.get("stage_result_id")))
    new_singer_id = _relation_pk(kwargs.get("singer", kwargs.get("singer_id")))
    new_activity_id = _relation_pk(kwargs.get("activity", kwargs.get("activity_id")))
    value_fields = ["stage_result_id", "singer_id"]
    if has_activity_field:
        value_fields.append("activity_id")
    for row in queryset.values(*value_fields):
        current_stage_activity_id = _stage_result_activity_id(row["stage_result_id"])
        target_stage_activity_id = (
            _stage_result_activity_id(new_stage_id) if new_stage_id else current_stage_activity_id
        )
        target_singer_activity_id = (
            _singer_activity_id(new_singer_id)
            if new_singer_id
            else _singer_activity_id(row["singer_id"])
        )
        target_activity_id = new_activity_id if new_activity_id else row.get("activity_id")
        if (
            target_stage_activity_id
            and current_stage_activity_id
            and target_stage_activity_id != current_stage_activity_id
        ):
            raise ValidationError("赛段派生结果不可迁移到其它活动。")
        if (
            target_stage_activity_id
            and target_singer_activity_id
            and target_singer_activity_id != target_stage_activity_id
        ):
            raise ValidationError("赛段派生结果选手必须属于同一活动。")
        if (
            has_activity_field
            and target_stage_activity_id
            and target_activity_id
            and target_activity_id != target_stage_activity_id
        ):
            raise ValidationError("奖项候选必须属于结果所在活动。")


def _ensure_same_activity_stage_child_instance(
    instance, *, has_activity_field: bool = False
) -> None:
    if instance._state.adding or not instance.pk:
        return
    stored_stage_result_id = _stored_fk_id(instance, "stage_result")
    current_stage_activity_id = _stage_result_activity_id(stored_stage_result_id)
    target_stage_activity_id = _stage_result_activity_id(instance.stage_result_id)
    target_singer_activity_id = _singer_activity_id(instance.singer_id)
    target_activity_id = instance.activity_id if has_activity_field else target_stage_activity_id
    if (
        target_stage_activity_id
        and current_stage_activity_id
        and target_stage_activity_id != current_stage_activity_id
    ):
        raise ValidationError("赛段派生结果不可迁移到其它活动。")
    if (
        target_stage_activity_id
        and target_singer_activity_id
        and target_singer_activity_id != target_stage_activity_id
    ):
        raise ValidationError("赛段派生结果选手必须属于同一活动。")
    if (
        has_activity_field
        and target_stage_activity_id
        and target_activity_id
        and target_activity_id != target_stage_activity_id
    ):
        raise ValidationError("奖项候选必须属于结果所在活动。")


def _score_record_round_id(score_record_id: int | None) -> int | None:
    if not score_record_id:
        return None
    return (
        ScoreRecord._base_manager.filter(pk=score_record_id)
        .values_list("round_id", flat=True)
        .first()
    )


class SingerRegistration(models.Model):
    class PreStatus(models.TextChoices):
        DRAFT = "draft", "草稿"
        SUBMITTED = "submitted", "已提交"
        NEED_SUPPLEMENT = "need_supplement", "资料待补充"
        APPROVED = "approved", "审核通过"
        REJECTED = "rejected", "审核未通过"
        WITHDRAWN = "withdrawn", "已撤回"

    class LiveStatus(models.TextChoices):
        NOT_CHECKED_IN = "not_checked_in", "未签到"
        CHECKED_IN = "checked_in", "已签到"
        WAITING = "waiting", "已候场"
        PERFORMED = "performed", "已表演"
        WAITING_SCORE = "waiting_score", "待录分"
        SCORED = "scored", "已录分"
        SCORE_REVIEWED = "score_reviewed", "成绩已复核"
        ADVANCED = "advanced", "已晋级"
        NOT_ADVANCED = "not_advanced", "未晋级"
        ABANDONED = "abandoned", "弃赛"
        DELAYED = "delayed", "延后出场"

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="singer_registrations"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="singer_registrations"
    )

    name = models.CharField(max_length=100)
    student_id = models.CharField(max_length=20)
    college = models.CharField(max_length=100)
    class_name = models.CharField(max_length=100)
    phone = models.CharField(max_length=20)
    wechat = models.CharField(max_length=50, blank=True)
    song_name = models.CharField(max_length=200)
    is_original = models.BooleanField(default=False)
    description = models.TextField(blank=True)
    remark = models.TextField(blank=True)

    pre_status = models.CharField(max_length=20, choices=PreStatus, default=PreStatus.DRAFT)
    live_status = models.CharField(
        max_length=20, choices=LiveStatus, default=LiveStatus.NOT_CHECKED_IN
    )
    is_test_data = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    objects = SingerRegistrationManager()

    if TYPE_CHECKING:
        activity_id: int
        staff_notes: models.Manager[StaffNote]
        files: models.Manager[SubmissionFile]
        material_checks: models.Manager[MaterialCheck]

        def get_pre_status_display(self) -> str: ...
        def get_live_status_display(self) -> str: ...

    class Meta:
        base_manager_name = "objects"
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["activity", "user"],
                name="singer_one_registration_per_account_per_activity",
            ),
            models.UniqueConstraint(
                fields=["activity", "student_id"],
                name="singer_one_registration_per_student_per_activity",
            ),
        ]

    def __str__(self):
        return f"{self.name} — {self.song_name}"

    def save(self, *args, **kwargs):
        _ensure_identity_ownership_unchanged(self, frozenset({"activity_id", "user_id"}))
        return super().save(*args, **kwargs)


_CONTEST_ROUND_STATE_FIELDS = frozenset(
    {"status", "is_locked", "score_version", "advancement_status"}
)
_CONTEST_ROUND_CONFIGURATION_FIELDS = frozenset(
    {
        "activity_id",
        "round_type",
        "scoring_mode",
        "name",
        "sequence",
        "order_policy",
        "tie_order_policy",
        "scheduled_at",
        "venue",
        "rubric_id",
        "advance_count",
        "roster_source",
        "roster_source_stage",
    }
)


class ContestRoundQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    def update(self, **kwargs):
        if not authority_authorized(CONTEST_ROUND_STATE):
            if _CONTEST_ROUND_STATE_FIELDS.intersection(kwargs):
                raise ValidationError("轮次状态只能通过轮次服务变更。")
            if (_CONTEST_ROUND_CONFIGURATION_FIELDS | {"activity", "rubric"}).intersection(
                kwargs
            ) and self.exclude(status=ContestRound.Status.DRAFT).exists():
                raise ValidationError("轮次准备后，执行配置不可直接修改。")
        return super().update(**kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        objs = list(objs)
        if not authority_authorized(CONTEST_ROUND_STATE):
            for obj in objs:
                obj._ensure_authorized_mutation()
        return super().bulk_update(objs, fields, *args, **kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        objs = list(objs)
        options = parse_bulk_create_options(args, kwargs)
        if options.update_conflicts:
            update_fields = set(options.update_fields)
            if _CONTEST_ROUND_STATE_FIELDS.intersection(update_fields) and not authority_authorized(
                CONTEST_ROUND_STATE
            ):
                raise ValidationError("轮次状态只能通过轮次服务变更。")
            if _CONTEST_ROUND_CONFIGURATION_FIELDS.intersection(
                update_fields
            ) and not authority_authorized(CONTEST_ROUND_STATE):
                for contest_round in objs:
                    lookup = {
                        field: getattr(contest_round, field) for field in options.unique_fields
                    }
                    if (
                        self.model._base_manager.filter(**lookup)
                        .exclude(status=ContestRound.Status.DRAFT)
                        .exists()
                    ):
                        raise ValidationError("轮次准备后，执行配置不可直接修改。")
        for contest_round in objs:
            contest_round._ensure_initial_state_authorized()
        return super().bulk_create(objs, *args, **kwargs)

    def delete(self):
        for contest_round in self:
            contest_round._ensure_deletion_authorized()  # type: ignore[attr-defined]
        return super().delete()


ContestRoundQuerySetManager = models.Manager.from_queryset(ContestRoundQuerySet)


class ContestRoundManager(ContestRoundQuerySetManager):  # type: ignore[misc]
    def create(self, **kwargs):
        activity_id = kwargs.get("activity_id") or getattr(kwargs.get("activity"), "pk", None)
        if kwargs.get("sequence") is None and activity_id:
            from core.models import Activity
            from django.db import transaction

            with transaction.atomic():
                Activity.objects.select_for_update().get(pk=activity_id)
                kwargs["sequence"] = (
                    self.filter(activity_id=activity_id)
                    .order_by("-sequence")
                    .values_list("sequence", flat=True)
                    .first()
                    or 0
                ) + 1
                return super().create(**kwargs)
        return super().create(**kwargs)


class ContestRound(models.Model):
    class RoundType(models.TextChoices):
        PRELIMINARY = "preliminary", "初赛"
        SEMI_FINAL = "semi_final", "复赛"

    class RosterSource(models.TextChoices):
        APPROVED = "approved", "批准名单"
        STAGE = "stage", "赛段晋级"
        LEGACY = "legacy", "上一轮晋级"

    class ScoringMode(models.TextChoices):
        AVERAGE = "average", "平均分"
        DROP_HIGH_LOW = "drop_high_low", "去最高最低后平均"

    class OrderPolicy(models.TextChoices):
        REGISTRATION_ORDER = "registration_order", "报名顺序"
        DRAW = "draw", "抽签顺序"
        MANUAL = "manual", "人工顺序"
        PREVIOUS_RANK_ASC = "previous_rank_asc", "上一轮排名升序"
        PREVIOUS_RANK_DESC = "previous_rank_desc", "上一轮排名降序"

    class TieOrderPolicy(models.TextChoices):
        REVIEW = "review", "同分待人工决定"
        REGISTRATION_ORDER = "registration_order", "同分按报名序"
        DRAW = "draw", "同分抽签"

    class Status(models.TextChoices):
        DRAFT = "draft", "草稿"
        PREPARED = "prepared", "已准备"
        SCORING = "scoring", "评分中"
        LOCKED = "locked", "已锁定"

    class AdvancementStatus(models.TextChoices):
        AUTO = "auto", "自动晋级"
        NEEDS_REVIEW = "needs_review", "待人工核定"
        FINALIZED = "finalized", "已核定晋级"

    activity = models.ForeignKey("core.Activity", on_delete=models.CASCADE, related_name="rounds")
    round_type = models.CharField(max_length=16, choices=RoundType)
    scoring_mode = models.CharField(max_length=16, choices=ScoringMode, default=ScoringMode.AVERAGE)
    name = models.CharField(max_length=100, blank=True)
    sequence = models.PositiveIntegerField(default=1, help_text="同一活动内的轮次顺序")
    order_policy = models.CharField(
        max_length=24,
        choices=OrderPolicy,
        default=OrderPolicy.REGISTRATION_ORDER,
        help_text="准备轮次时冻结的出场顺序规则。",
    )
    tie_order_policy = models.CharField(
        max_length=24,
        choices=TieOrderPolicy,
        default=TieOrderPolicy.REVIEW,
        help_text="上一轮成绩同分时的显式处理规则。",
    )
    scheduled_at = models.DateTimeField(null=True, blank=True)
    venue = models.CharField(max_length=200, blank=True)
    rubric = models.ForeignKey(
        "ScoringRubric", on_delete=models.SET_NULL, null=True, blank=True, related_name="rounds"
    )
    advance_count = models.IntegerField(default=0)
    status = models.CharField(max_length=10, choices=Status, default=Status.DRAFT)
    is_locked = models.BooleanField(default=False)
    score_version = models.PositiveIntegerField(
        default=0, help_text="Bumped on every applied score change (stale-edit detection)."
    )
    advancement_status = models.CharField(
        max_length=16, choices=AdvancementStatus, default=AdvancementStatus.AUTO
    )
    roster_source = models.CharField(
        max_length=16,
        choices=RosterSource,
        default="",
        blank=True,
        help_text="晋级名单来源；置空时按轮次类型自动判定。",
    )
    roster_source_stage = models.CharField(max_length=100, blank=True, default="")

    objects = ContestRoundManager()

    if TYPE_CHECKING:
        activity_id: int
        rubric_id: int | None
        entries: models.Manager["RoundEntry"]
        round_judges: models.Manager["RoundJudge"]

    class Meta:
        base_manager_name = "objects"
        constraints = [
            models.UniqueConstraint(
                fields=["activity", "sequence"], name="round_unique_sequence_per_activity"
            ),
            models.CheckConstraint(
                condition=(
                    Q(status="locked", is_locked=True) | (~Q(status="locked") & Q(is_locked=False))
                ),
                name="round_status_lock_consistent",
            ),
            models.CheckConstraint(
                condition=Q(advance_count__gte=0),
                name="round_advance_count_non_negative",
            ),
        ]

    _state_fields = _CONTEST_ROUND_STATE_FIELDS
    _configuration_fields = _CONTEST_ROUND_CONFIGURATION_FIELDS

    def _stored_authority_values(self):
        if self._state.adding or not self.pk:
            return None
        return (
            type(self)
            ._base_manager.filter(pk=self.pk)
            .values(*self._state_fields, *self._configuration_fields)
            .first()
        )

    def _ensure_authorized_mutation(self):
        stored = self._stored_authority_values()
        if not stored:
            return
        if not authority_authorized(CONTEST_ROUND_STATE):
            if any(stored[field] != getattr(self, field) for field in self._state_fields):
                raise ValidationError("轮次状态只能通过轮次服务变更。")
            changed_configuration = any(
                stored[field] != getattr(self, field) for field in self._configuration_fields
            )
            if changed_configuration and (
                stored["status"] != self.Status.DRAFT or self.status != self.Status.DRAFT
            ):
                raise ValidationError("轮次准备后，执行配置不可直接修改。")

    def _ensure_initial_state_authorized(self):
        if authority_authorized(CONTEST_ROUND_STATE):
            return
        if (
            self.status != self.Status.DRAFT
            or self.is_locked
            or self.score_version != 0
            or self.advancement_status != self.AdvancementStatus.AUTO
        ):
            raise ValidationError("轮次必须以未锁定的 DRAFT 初始状态创建。")

    def _ensure_deletion_authorized(self):
        if not authority_authorized(TEST_DATA_CLEANUP):
            raise ValidationError("轮次删除需要显式测试数据清理权限。")
        if self.status != self.Status.DRAFT or self.is_locked:
            if self.entries.exists() or self.round_judges.exists():
                from django.db.models.deletion import ProtectedError

                protected: set[models.Model] = set()
                protected.update(self.entries.all())
                protected.update(self.round_judges.all())
                raise ProtectedError("Prepared round snapshots are protected.", protected)
            raise ValidationError("只有未锁定的 DRAFT 轮次可以删除。")
        if not self.activity.is_test_mode:
            raise ValidationError("只有测试活动中的轮次可以删除。")
        from .services import ensure_round_not_consumed_by_confirmed_stage

        ensure_round_not_consumed_by_confirmed_stage(self)

    def save(self, *args, **kwargs):
        if self._state.adding:
            self._ensure_initial_state_authorized()
        self._ensure_authorized_mutation()
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        self._ensure_deletion_authorized()
        return super().delete(*args, **kwargs)

    def effective_roster_source(self) -> str:
        """The roster provider for this round, resolving the M1-INTEGRATION-1 source.

        ``STAGE`` (advancers of a resolved stage, decided by StageDecision) is the
        integration mode; the legacy ``ScoreSummary.is_advanced`` path stays available
        as ``LEGACY`` for simple screening. An explicit ``roster_source`` always wins;
        only when it is unset (the default) is the value derived from ``round_type`` so
        the old two-round behaviour is unchanged.
        """
        if self.roster_source:
            if self.roster_source == self.RosterSource.STAGE and not self.roster_source_stage:
                raise ValidationError("赛段晋级轮次必须声明 source_stage。")
            return self.roster_source
        if self.round_type == self.RoundType.SEMI_FINAL:
            return self.RosterSource.LEGACY
        return self.RosterSource.APPROVED

    def __str__(self):
        return f"{self.activity.title} — {self.get_round_type_display()}"


class Judge(models.Model):
    activity = models.ForeignKey("core.Activity", on_delete=models.CASCADE, related_name="judges")
    name = models.CharField(max_length=100)
    is_active = models.BooleanField(default=True)
    objects = JudgeManager()

    class Meta:
        base_manager_name = "objects"
        ordering = ["pk"]

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        _ensure_identity_ownership_unchanged(self, frozenset({"activity_id"}))
        return super().save(*args, **kwargs)


class RoundSnapshotMixin:
    objects: Any
    pk: int

    def _ensure_round_is_draft(self, round_id):
        if not round_id:
            return
        status = ContestRound.objects.values_list("status", flat=True).get(pk=round_id)
        if status != ContestRound.Status.DRAFT:
            raise ValidationError("Round snapshots cannot be changed after preparation.")

    def _stored_round_id(self):
        return type(self).objects.filter(pk=self.pk).values_list("round_id", flat=True).first()

    def delete(self, *args, **kwargs):
        self._ensure_round_is_draft(self._stored_round_id())
        return super().delete(*args, **kwargs)  # type: ignore[misc]


class RoundSnapshotQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    related_field = ""
    related_model: type[models.Model] | None = None

    def _ensure_draft_rounds(self):
        if self.exclude(round__status=ContestRound.Status.DRAFT).exists():
            raise ValidationError("Round snapshots cannot be changed after preparation.")

    def _updated_object(self, values, field, model):
        value = values.get(field, values.get(f"{field}_id"))
        if value is None:
            return None
        if isinstance(value, model):
            return value
        if isinstance(value, int):
            return model.objects.get(pk=value)
        raise ValidationError(
            "Snapshot relations must be updated with a model instance or primary key."
        )

    def _validate_update_relations(self, values):
        if not self.exists():
            return
        self._ensure_draft_rounds()
        contest_round = self._updated_object(values, "round", ContestRound)
        related_object = self._updated_object(values, self.related_field, self.related_model)
        if contest_round and contest_round.status != ContestRound.Status.DRAFT:
            raise ValidationError("Round snapshots cannot be changed after preparation.")
        if contest_round and related_object:
            if contest_round.activity_id != related_object.activity_id:
                raise ValidationError("Snapshot relation must belong to the round activity.")
        elif contest_round:
            if self.exclude(
                **{f"{self.related_field}__activity_id": contest_round.activity_id}
            ).exists():
                raise ValidationError("Snapshot relation must belong to the round activity.")
        elif related_object:
            if self.exclude(round__activity_id=related_object.activity_id).exists():
                raise ValidationError("Snapshot relation must belong to the round activity.")

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        for obj in objs:
            obj.clean()
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        objs = list(objs)
        for obj in objs:
            obj.clean()
        return super().bulk_update(objs, fields, *args, **kwargs)

    def update(self, **kwargs):
        self._validate_update_relations(kwargs)
        return super().update(**kwargs)

    def delete(self):
        self._ensure_draft_rounds()
        return super().delete()


class RoundEntryQuerySet(RoundSnapshotQuerySet):
    related_field = "singer"
    related_model = SingerRegistration


class RoundJudgeQuerySet(RoundSnapshotQuerySet):
    related_field = "judge"
    related_model = Judge


RoundEntryManager = models.Manager.from_queryset(RoundEntryQuerySet)
RoundJudgeManager = models.Manager.from_queryset(RoundJudgeQuerySet)


class RoundEntry(RoundSnapshotMixin, models.Model):
    round = models.ForeignKey(
        ContestRound,
        on_delete=cascade_draft_snapshots_or_protect_prepared,
        related_name="entries",
    )
    singer = models.ForeignKey(
        SingerRegistration,
        on_delete=cascade_draft_snapshots_or_protect_prepared,
        related_name="round_entries",
    )
    running_order = models.PositiveIntegerField(
        null=True, blank=True, help_text="准备轮次时冻结的现场出场序号。"
    )
    objects = RoundEntryManager()

    if TYPE_CHECKING:
        singer_id: int

    class Meta:
        base_manager_name = "objects"
        unique_together = [("round", "singer")]
        ordering = ["running_order", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["round", "running_order"],
                condition=Q(running_order__isnull=False),
                name="round_entry_unique_running_order",
            )
        ]

    def clean(self):
        self._ensure_round_is_draft(self._stored_round_id())
        self._ensure_round_is_draft(self.round_id)
        singer = self.singer if self.singer_id else None
        contest_round = self.round if self.round_id else None
        if singer and contest_round and singer.activity_id != contest_round.activity_id:
            raise ValidationError("Round entry singer must belong to the round activity.")

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)


class RoundJudge(RoundSnapshotMixin, models.Model):
    round = models.ForeignKey(
        ContestRound,
        on_delete=cascade_draft_snapshots_or_protect_prepared,
        related_name="round_judges",
    )
    judge = models.ForeignKey(
        Judge,
        on_delete=cascade_draft_snapshots_or_protect_prepared,
        related_name="round_assignments",
    )
    objects = RoundJudgeManager()

    class Meta:
        base_manager_name = "objects"
        unique_together = [("round", "judge")]

    def clean(self):
        self._ensure_round_is_draft(self._stored_round_id())
        self._ensure_round_is_draft(self.round_id)
        judge = self.judge if self.judge_id else None
        contest_round = self.round if self.round_id else None
        if judge and contest_round and judge.activity_id != contest_round.activity_id:
            raise ValidationError("Round judge must belong to the round activity.")

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)


class JudgeAuthorityQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    authority_scope = ""

    def _ensure_authority(self) -> None:
        if not authority_authorized(self.authority_scope):
            raise ValidationError(f"{self.model.__name__} 只能通过其 authority service 修改。")

    def update(self, **kwargs):
        self._ensure_authority()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_authority()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        self._ensure_authority()
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        for obj in objs:
            obj.clean()
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_authority()
        objs = list(objs)
        for obj in objs:
            obj.clean()
        return super().bulk_update(objs, fields, *args, **kwargs)


class JudgePanelSnapshotQuerySet(JudgeAuthorityQuerySet):
    authority_scope = JUDGE_PANEL_STATE


class JudgeSessionQuerySet(JudgeAuthorityQuerySet):
    authority_scope = JUDGE_SESSION_STATE


class JudgePerformanceQuerySet(JudgeAuthorityQuerySet):
    authority_scope = ROUND_PERFORMANCE_STATE


class RoundPanelSnapshot(models.Model):
    class State(models.TextChoices):
        ACTIVE = "active", "Active"
        HOLD = "hold", "Hold"
        SUPERSEDED = "superseded", "Superseded"

    class ChangePolicy(models.TextChoices):
        HOLD_ONLY = "hold_only", "Hold only"
        VERSIONED_REPLACEMENT = "versioned_replacement", "Versioned replacement"

    round = models.ForeignKey(
        ContestRound, on_delete=models.PROTECT, related_name="judge_panel_snapshots"
    )
    activity = models.ForeignKey(
        "core.Activity", on_delete=models.PROTECT, related_name="judge_panel_snapshots"
    )
    version = models.PositiveIntegerField()
    change_policy = models.CharField(max_length=24, choices=ChangePolicy.choices)
    state = models.CharField(max_length=16, choices=State.choices)
    expected_judge_count = models.PositiveIntegerField()
    minimum_judge_count = models.PositiveIntegerField()
    scoring_method = models.CharField(max_length=32)
    roster_digest = models.CharField(max_length=64)
    captured_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="captured_judge_panel_snapshots",
    )
    captured_at = models.DateTimeField(auto_now_add=True)
    is_test_data = models.BooleanField(default=False)

    objects = JudgePanelSnapshotQuerySet.as_manager()

    if TYPE_CHECKING:
        round_id: int
        activity_id: int

    class Meta:
        base_manager_name = "objects"
        constraints = [
            models.UniqueConstraint(
                fields=["round", "version"], name="judge_panel_snapshot_round_version"
            ),
            models.CheckConstraint(
                condition=Q(expected_judge_count__gte=1),
                name="judge_panel_snapshot_expected_positive",
            ),
            models.CheckConstraint(
                condition=Q(minimum_judge_count__gte=1)
                & Q(minimum_judge_count__lte=models.F("expected_judge_count")),
                name="judge_panel_snapshot_minimum_valid",
            ),
        ]
        indexes = [
            models.Index(fields=["round", "state"], name="judge_panel_snapshot_state_idx"),
            models.Index(fields=["activity", "state"], name="judge_panel_activity_state_idx"),
        ]

    def clean(self):
        if self.round_id and self.activity_id:
            round_activity_id = (
                ContestRound._base_manager.filter(pk=self.round_id)
                .values_list("activity_id", flat=True)
                .first()
            )
            if round_activity_id != self.activity_id:
                raise ValidationError("评委组快照必须属于轮次所在活动。")
        if self.version < 1:
            raise ValidationError("评委组快照版本必须为正数。")
        if self.minimum_judge_count > self.expected_judge_count:
            raise ValidationError("评委组最少人数不能超过预期人数。")

    def save(self, *args, **kwargs):
        if not authority_authorized(JUDGE_PANEL_STATE):
            raise ValidationError("评委组快照只能通过评委组 authority service 写入。")
        self.clean()
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not authority_authorized(JUDGE_PANEL_STATE):
            raise ValidationError("评委组快照删除需要评委组 authority service。")
        return super().delete(*args, **kwargs)


class RoundPanelSnapshotMember(models.Model):
    panel_snapshot = models.ForeignKey(
        RoundPanelSnapshot, on_delete=models.PROTECT, related_name="members"
    )
    judge = models.ForeignKey(
        Judge, on_delete=models.PROTECT, related_name="panel_snapshot_members"
    )
    source_round_judge = models.ForeignKey(
        RoundJudge, on_delete=models.PROTECT, related_name="panel_snapshot_members"
    )
    seat_key = models.CharField(max_length=32)
    is_active = models.BooleanField(default=True)

    objects = JudgePanelSnapshotQuerySet.as_manager()

    if TYPE_CHECKING:
        panel_snapshot_id: int
        judge_id: int
        source_round_judge_id: int

    class Meta:
        base_manager_name = "objects"
        constraints = [
            models.UniqueConstraint(
                fields=["panel_snapshot", "seat_key"], name="judge_panel_member_seat_key"
            ),
            models.UniqueConstraint(
                fields=["panel_snapshot", "judge"], name="judge_panel_member_judge"
            ),
        ]

    def clean(self):
        if not self.panel_snapshot_id or not self.judge_id or not self.source_round_judge_id:
            return
        snapshot = RoundPanelSnapshot._base_manager.get(pk=self.panel_snapshot_id)
        source = RoundJudge._base_manager.select_related("round", "judge").get(
            pk=self.source_round_judge_id
        )
        if source.round_id != snapshot.round_id:
            raise ValidationError("评委组快照成员的来源轮次不一致。")
        if source.judge_id != self.judge_id:
            raise ValidationError("评委组快照成员的来源评委不一致。")
        if source.judge.activity_id != snapshot.activity_id:
            raise ValidationError("评委组快照成员必须属于同一活动。")
        if not self.seat_key.strip():
            raise ValidationError("评委席位标识不能为空。")

    def save(self, *args, **kwargs):
        if not authority_authorized(JUDGE_PANEL_STATE):
            raise ValidationError("评委组快照成员只能通过评委组 authority service 写入。")
        self.clean()
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not authority_authorized(JUDGE_PANEL_STATE):
            raise ValidationError("评委组快照成员删除需要评委组 authority service。")
        return super().delete(*args, **kwargs)


class JudgeSeat(models.Model):
    class State(models.TextChoices):
        ASSIGNED = "assigned", "Assigned"
        REVOKED = "revoked", "Revoked"
        HOLD = "hold", "Hold"

    panel_member = models.ForeignKey(
        RoundPanelSnapshotMember, on_delete=models.PROTECT, related_name="seats"
    )
    state = models.CharField(max_length=16, choices=State.choices)
    assigned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="assigned_judge_seats",
    )
    assigned_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    revocation_reason = models.CharField(max_length=240, blank=True)
    is_test_data = models.BooleanField(default=False)

    objects = JudgePanelSnapshotQuerySet.as_manager()

    if TYPE_CHECKING:
        panel_member_id: int

    class Meta:
        base_manager_name = "objects"
        indexes = [models.Index(fields=["state"], name="judge_seat_state_idx")]

    def clean(self):
        if self.revoked_at is not None and self.state != self.State.REVOKED:
            raise ValidationError("已撤销评委席位必须处于 REVOKED 状态。")
        if self.state == self.State.REVOKED and not self.revoked_at:
            raise ValidationError("REVOKED 评委席位必须记录撤销时间。")

    def save(self, *args, **kwargs):
        if not authority_authorized(JUDGE_PANEL_STATE):
            raise ValidationError("评委席位只能通过评委组 authority service 写入。")
        self.clean()
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not authority_authorized(JUDGE_PANEL_STATE):
            raise ValidationError("评委席位删除需要评委组 authority service。")
        return super().delete(*args, **kwargs)


class JudgeSeatGrant(models.Model):
    access_grant = models.OneToOneField(
        "entry_access.AccessGrant", on_delete=models.PROTECT, related_name="judge_seat_grant"
    )
    seat = models.ForeignKey(JudgeSeat, on_delete=models.PROTECT, related_name="grants")
    panel_snapshot = models.ForeignKey(
        RoundPanelSnapshot, on_delete=models.PROTECT, related_name="seat_grants"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    objects = JudgeSessionQuerySet.as_manager()

    if TYPE_CHECKING:
        access_grant_id: int
        seat_id: int
        panel_snapshot_id: int

    class Meta:
        base_manager_name = "objects"
        indexes = [models.Index(fields=["seat"], name="judge_seat_grant_seat_idx")]

    def clean(self):
        if not self.access_grant_id or not self.seat_id or not self.panel_snapshot_id:
            return
        grant = self.access_grant
        seat = self.seat
        if grant.kind != "judge":
            raise ValidationError("评委席位授权必须使用 JUDGE 访问授权。")
        if seat.panel_member.panel_snapshot_id != self.panel_snapshot_id:
            raise ValidationError("评委席位授权的快照必须与席位一致。")
        if grant.activity_id != seat.panel_member.panel_snapshot.activity_id:
            raise ValidationError("评委席位授权必须属于同一活动。")
        if grant.round_id != seat.panel_member.panel_snapshot.round_id:
            raise ValidationError("评委席位授权必须属于同一轮次。")

    def save(self, *args, **kwargs):
        if not authority_authorized(JUDGE_SESSION_STATE):
            raise ValidationError("评委席位授权只能通过评委会话 authority service 写入。")
        self.clean()
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not authority_authorized(JUDGE_SESSION_STATE):
            raise ValidationError("评委席位授权删除需要评委会话 authority service。")
        return super().delete(*args, **kwargs)


class JudgeSession(models.Model):
    class State(models.TextChoices):
        ACTIVE = "active", "Active"
        REVOKED = "revoked", "Revoked"

    ephemeral_session = models.OneToOneField(
        "entry_access.EphemeralSession",
        on_delete=models.PROTECT,
        related_name="judge_session",
    )
    seat = models.ForeignKey(JudgeSeat, on_delete=models.PROTECT, related_name="sessions")
    panel_snapshot = models.ForeignKey(
        RoundPanelSnapshot, on_delete=models.PROTECT, related_name="judge_sessions"
    )
    state = models.CharField(max_length=16, choices=State.choices)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)
    revocation_reason = models.CharField(max_length=240, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(null=True, blank=True)
    is_test_data = models.BooleanField(default=False)

    objects = JudgeSessionQuerySet.as_manager()

    if TYPE_CHECKING:
        ephemeral_session_id: int
        seat_id: int
        panel_snapshot_id: int

    class Meta:
        base_manager_name = "objects"
        indexes = [
            models.Index(fields=["expires_at"], name="judge_session_expiry_idx"),
            models.Index(fields=["state"], name="judge_session_state_idx"),
        ]

    def clean(self):
        if self.revoked_at is not None and self.state != self.State.REVOKED:
            raise ValidationError("已撤销评委会话必须处于 REVOKED 状态。")
        if self.state == self.State.REVOKED and not self.revoked_at:
            raise ValidationError("REVOKED 评委会话必须记录撤销时间。")
        if not self.ephemeral_session_id or not self.seat_id or not self.panel_snapshot_id:
            return
        transport = self.ephemeral_session
        seat = self.seat
        if transport.kind != "judge":
            raise ValidationError("评委会话必须绑定 JUDGE 临时会话。")
        if seat.panel_member.panel_snapshot_id != self.panel_snapshot_id:
            raise ValidationError("评委会话的快照必须与席位一致。")
        if transport.activity_id != seat.panel_member.panel_snapshot.activity_id:
            raise ValidationError("评委会话必须属于同一活动。")
        if transport.round_id != seat.panel_member.panel_snapshot.round_id:
            raise ValidationError("评委会话必须属于同一轮次。")
        if self.expires_at > transport.expires_at:
            raise ValidationError("评委会话不能晚于临时会话过期。")

    def save(self, *args, **kwargs):
        if not authority_authorized(JUDGE_SESSION_STATE):
            raise ValidationError("评委会话只能通过评委会话 authority service 写入。")
        self.clean()
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not authority_authorized(JUDGE_SESSION_STATE):
            raise ValidationError("评委会话删除需要评委会话 authority service。")
        return super().delete(*args, **kwargs)


class PerformanceRunState(models.Model):
    class State(models.TextChoices):
        IDLE = "idle", "Idle"
        PERFORMING = "performing", "Performing"
        ACCEPTING_SCORE = "accepting_score", "Accepting score"
        HOLD = "hold", "Hold"
        CLOSED = "closed", "Closed"

    round = models.OneToOneField(
        ContestRound, on_delete=models.PROTECT, related_name="performance_run_state"
    )
    current_performance = models.ForeignKey(
        "Performance",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="active_run_states",
    )
    state = models.CharField(max_length=24, choices=State.choices)
    context_version = models.PositiveIntegerField(default=0)
    hold_reason = models.CharField(max_length=240, blank=True)
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="changed_performance_run_states",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    is_test_data = models.BooleanField(default=False)

    objects = JudgePerformanceQuerySet.as_manager()

    if TYPE_CHECKING:
        round_id: int
        current_performance_id: int | None

    class Meta:
        base_manager_name = "objects"
        indexes = [
            models.Index(fields=["state", "context_version"], name="judge_perf_run_state_idx")
        ]

    def clean(self):
        if self.current_performance_id and self.round_id:
            performance_round_id = (
                Performance._base_manager.filter(pk=self.current_performance_id)
                .values_list("round_id", flat=True)
                .first()
            )
            if performance_round_id != self.round_id:
                raise ValidationError("当前表演必须属于同一轮次。")

    def save(self, *args, **kwargs):
        if not authority_authorized(ROUND_PERFORMANCE_STATE):
            raise ValidationError("表演上下文只能通过现场 authority service 写入。")
        self.clean()
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not authority_authorized(ROUND_PERFORMANCE_STATE):
            raise ValidationError("表演上下文删除需要现场 authority service。")
        return super().delete(*args, **kwargs)


class ScoreRecordQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    def _ensure_mutable(self):
        _ensure_round_queryset_mutable(self)

    def update(self, **kwargs):
        self._ensure_mutable()
        if "round" in kwargs or "round_id" in kwargs:
            _ensure_round_raw_fact_mutable(
                _relation_pk(kwargs.get("round", kwargs.get("round_id")))
            )
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        for obj in objs:
            _ensure_round_raw_fact_mutable(obj.round_id)
            obj.clean()
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        objs = list(objs)
        for obj in objs:
            _ensure_round_raw_fact_mutable(
                type(obj)._base_manager.filter(pk=obj.pk).values_list("round_id", flat=True).first()
            )
            _ensure_round_raw_fact_mutable(obj.round_id)
            obj.clean()
        return super().bulk_update(objs, fields, *args, **kwargs)


ScoreRecordManager = models.Manager.from_queryset(ScoreRecordQuerySet)


class ScoreRecord(models.Model):
    round = models.ForeignKey(ContestRound, on_delete=models.CASCADE, related_name="scores")
    singer = models.ForeignKey(SingerRegistration, on_delete=models.CASCADE, related_name="scores")
    judge = models.ForeignKey(Judge, on_delete=models.CASCADE, related_name="scores")
    score = models.DecimalField(max_digits=5, decimal_places=2)
    notes = models.CharField(max_length=200, blank=True)
    is_test_data = models.BooleanField(default=False)

    objects = ScoreRecordManager()

    if TYPE_CHECKING:
        singer_id: int
        judge_id: int

    class Meta:
        base_manager_name = "objects"
        unique_together = [("round", "singer", "judge")]

    def clean(self):
        singer = self.singer if self.singer_id else None
        contest_round = self.round if self.round_id else None
        judge = self.judge if self.judge_id else None
        if singer and contest_round and singer.activity_id != contest_round.activity_id:
            raise ValidationError("Score singer must belong to the round activity.")
        if judge and contest_round and judge.activity_id != contest_round.activity_id:
            raise ValidationError("Score judge must belong to the round activity.")

    def save(self, *args, **kwargs):
        self.clean()
        if not self._state.adding and self.pk:
            _ensure_round_raw_fact_mutable(
                type(self)
                ._base_manager.filter(pk=self.pk)
                .values_list("round_id", flat=True)
                .first()
            )
        _ensure_round_raw_fact_mutable(self.round_id)
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        _ensure_round_raw_fact_mutable(_stored_fk_id(self, "round"))
        _ensure_round_raw_fact_mutable(self.round_id)
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.singer.name} — {self.judge.name}: {self.score}"


class ScoreWriteReceiptQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    def _ensure_receipts_valid(self, receipts) -> None:
        for receipt in receipts:
            receipt.clean()

    def update(self, **kwargs):
        if _score_receipt_bulk_update_authorized():
            return super().update(**kwargs)
        if {"status", "result_payload", "result_version"}.intersection(kwargs):
            model = cast(Any, self.model)
            for row in self.values("status", "result_payload", "result_version"):
                status = kwargs.get("status", row["status"])
                result_payload = kwargs.get("result_payload", row["result_payload"])
                result_version = kwargs.get("result_version", row["result_version"])
                model.validate_result_payload(status, result_payload, result_version)
        return super().update(**kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        self._ensure_receipts_valid(objs)
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        objs = list(objs)
        if {"status", "result_payload", "result_version"}.intersection(fields):
            self._ensure_receipts_valid(objs)
        _authorize_score_receipt_bulk_update(True)
        try:
            return super().bulk_update(objs, fields, *args, **kwargs)
        finally:
            _authorize_score_receipt_bulk_update(False)


ScoreWriteReceiptManager = models.Manager.from_queryset(ScoreWriteReceiptQuerySet)


class ScoreWriteReceipt(models.Model):
    """Bounded idempotency record for one rapid-score command.

    This is a transaction receipt, not a second score authority: the score facts remain
    in :class:`ScoreRecord` and their change detail remains in :class:`AuditLog`.
    """

    RESULT_PAYLOAD_MAX_BYTES = 256
    RESULT_PAYLOAD_KEYS = frozenset({"status", "reason_code", "version", "matrix_complete"})

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        SUCCEEDED = "succeeded", "Succeeded"

    command_id = models.CharField(max_length=64, unique=True)
    operator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="score_write_receipts",
    )
    operation = models.CharField(max_length=64)
    payload_hash = models.CharField(max_length=64)
    result_version = models.PositiveIntegerField()
    result_payload = models.JSONField(default=dict)
    status = models.CharField(max_length=16, choices=Status, default=Status.PENDING)
    created_at = models.DateTimeField(auto_now_add=True)
    objects = ScoreWriteReceiptManager()

    if TYPE_CHECKING:
        operator_id: int

    @classmethod
    def validate_result_payload(cls, status, result_payload, result_version=None) -> None:
        if status == cls.Status.PENDING:
            if result_payload != {}:
                raise ValidationError({"result_payload": "待处理成绩写入回执不得包含结果。"})
            if result_version not in {None, 0}:
                raise ValidationError({"result_version": "待处理成绩写入回执结果版本必须为 0。"})
            return
        if status != cls.Status.SUCCEEDED:
            raise ValidationError({"status": "成绩写入回执状态无效。"})
        if not isinstance(result_payload, dict):
            raise ValidationError({"result_payload": "成绩写入回执结果必须是对象。"})
        if set(result_payload) != cls.RESULT_PAYLOAD_KEYS:
            raise ValidationError({"result_payload": "成绩写入回执结果字段无效。"})
        if result_payload["status"] != cls.Status.SUCCEEDED:
            raise ValidationError({"result_payload": "成绩写入回执结果状态无效。"})
        if result_payload["reason_code"] != "SCORES_APPLIED":
            raise ValidationError({"result_payload": "成绩写入回执结果原因无效。"})
        if isinstance(result_payload["version"], bool) or not isinstance(
            result_payload["version"], int
        ):
            raise ValidationError({"result_payload": "成绩写入回执结果版本必须是整数。"})
        if not isinstance(result_payload["matrix_complete"], bool):
            raise ValidationError({"result_payload": "成绩写入回执完成标记必须是布尔值。"})
        if result_version is not None and result_payload["version"] != result_version:
            raise ValidationError({"result_payload": "成绩写入回执结果版本不一致。"})
        try:
            size = len(
                json.dumps(
                    result_payload,
                    ensure_ascii=True,
                    separators=(",", ":"),
                    sort_keys=True,
                ).encode("utf-8")
            )
        except (TypeError, ValueError):
            raise ValidationError({"result_payload": "成绩写入回执结果不可序列化。"}) from None
        if size > cls.RESULT_PAYLOAD_MAX_BYTES:
            raise ValidationError({"result_payload": "成绩写入回执结果过大。"})

    def clean(self):
        super().clean()
        self.validate_result_payload(self.status, self.result_payload, self.result_version)

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)

    class Meta:
        base_manager_name = "objects"


class ScoreSummaryQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    def _ensure_authorized(self):
        if not authority_authorized(SCORE_SUMMARY_RECALCULATE):
            raise ValidationError("成绩汇总只能由成绩重算服务维护。")

    def update(self, **kwargs):
        self._ensure_authorized()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_authorized()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        self._ensure_authorized()
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_authorized()
        return super().bulk_update(objs, fields, *args, **kwargs)


ScoreSummaryManager = models.Manager.from_queryset(ScoreSummaryQuerySet)


class ScoreSummary(models.Model):
    round = models.ForeignKey(ContestRound, on_delete=models.CASCADE, related_name="summaries")
    singer = models.ForeignKey(
        SingerRegistration, on_delete=models.CASCADE, related_name="summaries"
    )
    average_score = models.DecimalField(max_digits=6, decimal_places=3, default=0)
    rank = models.IntegerField(default=0)
    is_advanced = models.BooleanField(default=False)
    is_test_data = models.BooleanField(default=False)

    objects = ScoreSummaryManager()

    class Meta:
        base_manager_name = "objects"
        unique_together = [("round", "singer")]
        ordering = ["-average_score"]

    def __str__(self):
        return f"{self.singer.name}: {self.average_score} (#{self.rank})"

    def save(self, *args, **kwargs):
        if not authority_authorized(SCORE_SUMMARY_RECALCULATE):
            raise ValidationError("成绩汇总只能由成绩重算服务维护。")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not authority_authorized(SCORE_SUMMARY_RECALCULATE):
            raise ValidationError("成绩汇总只能由成绩重算服务维护。")
        return super().delete(*args, **kwargs)


class AudienceScoreQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    def _ensure_mutable(self):
        if _raw_fact_write_authorized():
            return
        from .services import ensure_audience_not_consumed_by_confirmed_stage

        for activity_id, stage_key in self.values_list("activity_id", "stage_key").distinct():
            ensure_audience_not_consumed_by_confirmed_stage(activity_id, stage_key)

    def update(self, **kwargs):
        self._ensure_mutable()
        if "activity" in kwargs or "activity_id" in kwargs or "stage_key" in kwargs:
            from .services import ensure_audience_not_consumed_by_confirmed_stage

            activity_id = _relation_pk(kwargs.get("activity", kwargs.get("activity_id")))
            for old_activity_id, old_stage_key in self.values_list(
                "activity_id", "stage_key"
            ).distinct():
                ensure_audience_not_consumed_by_confirmed_stage(
                    activity_id if activity_id is not None else old_activity_id,
                    kwargs.get("stage_key", old_stage_key),
                )
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        for obj in objs:
            obj.clean()
            if not _raw_fact_write_authorized():
                from .services import ensure_audience_not_consumed_by_confirmed_stage

                ensure_audience_not_consumed_by_confirmed_stage(obj.activity_id, obj.stage_key)
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        objs = list(objs)
        for obj in objs:
            obj.clean()
            stored = (
                type(obj)._base_manager.filter(pk=obj.pk).values("activity_id", "stage_key").first()
            )
            if stored:
                from .services import ensure_audience_not_consumed_by_confirmed_stage

                ensure_audience_not_consumed_by_confirmed_stage(
                    stored["activity_id"], stored["stage_key"]
                )
            if "activity" in fields or "activity_id" in fields or "stage_key" in fields:
                from .services import ensure_audience_not_consumed_by_confirmed_stage

                ensure_audience_not_consumed_by_confirmed_stage(obj.activity_id, obj.stage_key)
        return super().bulk_update(objs, fields, *args, **kwargs)


AudienceScoreManager = models.Manager.from_queryset(AudienceScoreQuerySet)


class AudienceScore(models.Model):
    """A staff-entered per-singer audience score for a checkpoint stage (M1-INTEGRATION-2).

    Unlike a raw vote count, this is a real 0-100 score (scale ``hundred``) that may be
    combined by weight with judge scores in the resolver's aggregate. It is keyed by an
    audience-set name (``stage_key``), which the ruleset binding's ``audience_keys`` maps
    to the definition's vote_source key.
    """

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="audience_scores"
    )
    stage_key = models.CharField(
        max_length=100, help_text="Audience-set name grouped in the binding's audience_keys."
    )
    singer = models.ForeignKey(
        SingerRegistration, on_delete=models.CASCADE, related_name="audience_scores"
    )
    score = models.DecimalField(max_digits=8, decimal_places=2)
    is_test_data = models.BooleanField(default=False)
    entered_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="audience_scores",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = AudienceScoreManager()

    if TYPE_CHECKING:
        singer_id: int

    class Meta:
        base_manager_name = "objects"
        ordering = ["stage_key", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["activity", "stage_key", "singer"],
                name="ux_audience_activity_stage_singer",
            ),
        ]

    def __str__(self):
        return f"{self.singer.name}@{self.stage_key}: {self.score}"

    def clean(self):
        singer = self.singer if self.singer_id else None
        if singer and self.activity_id and singer.activity_id != self.activity_id:
            raise ValidationError("观众分选手必须属于同一活动。")
        if singer and bool(self.is_test_data) != bool(singer.is_test_data):
            raise ValidationError("观众分的测试标记必须与选手一致。")

    def save(self, *args, **kwargs):
        self.clean()
        if not _raw_fact_write_authorized():
            from .services import ensure_audience_not_consumed_by_confirmed_stage

            stored = (
                type(self)
                ._base_manager.filter(pk=self.pk)
                .values("activity_id", "stage_key")
                .first()
            )
            if stored:
                ensure_audience_not_consumed_by_confirmed_stage(
                    stored["activity_id"], stored["stage_key"]
                )
            ensure_audience_not_consumed_by_confirmed_stage(self.activity_id, self.stage_key)
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not _raw_fact_write_authorized():
            from .services import ensure_audience_not_consumed_by_confirmed_stage

            stored = (
                type(self)
                ._base_manager.filter(pk=self.pk)
                .values("activity_id", "stage_key")
                .first()
            )
            if stored:
                ensure_audience_not_consumed_by_confirmed_stage(
                    stored["activity_id"], stored["stage_key"]
                )
            ensure_audience_not_consumed_by_confirmed_stage(self.activity_id, self.stage_key)
        return super().delete(*args, **kwargs)


class AwardQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    def _ensure_mutable(self):
        if (
            not _award_materialization_authorized()
            and self.filter(
                models.Q(source_stage_result__isnull=False)
                | models.Q(source_award_decision__isnull=False)
            ).exists()
        ):
            raise ValidationError("已有来源的正式奖项不可直接修改。")
        if self.filter(source_stage_result__status=StageResult.Status.CONFIRMED).exists():
            raise ValidationError("已核定赛段的正式奖项不可直接修改。")

    def update(self, **kwargs):
        self._ensure_mutable()
        if (
            not _award_materialization_authorized()
            and ("source_stage_result" in kwargs or "source_stage_result_id" in kwargs)
            and kwargs.get("source_stage_result", kwargs.get("source_stage_result_id"))
        ):
            raise ValidationError("赛段正式奖项只能由核定服务生成。")
        if "source_stage_result" in kwargs or "source_stage_result_id" in kwargs:
            _ensure_stage_result_mutable(
                _relation_pk(
                    kwargs.get("source_stage_result", kwargs.get("source_stage_result_id"))
                )
            )
        if "source_award_decision" in kwargs or "source_award_decision_id" in kwargs:
            decision_id = _relation_pk(
                kwargs.get("source_award_decision", kwargs.get("source_award_decision_id"))
            )
            decision_stage_result_id = (
                StageAwardDecision._base_manager.filter(pk=decision_id)
                .values_list("stage_result_id", flat=True)
                .first()
            )
            _ensure_stage_result_mutable(decision_stage_result_id)
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        for obj in objs:
            obj.clean()
        if (
            any(obj.source_stage_result_id or obj.source_award_decision_id for obj in objs)
            and not _award_materialization_authorized()
        ):
            raise ValidationError("赛段正式奖项只能由核定服务生成。")
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        objs = list(objs)
        if not _award_materialization_authorized():
            for obj in objs:
                stored = (
                    type(obj)
                    ._base_manager.filter(pk=obj.pk)
                    .values("source_stage_result_id", "source_award_decision_id")
                    .first()
                )
                if stored:
                    _ensure_stage_result_origins(
                        stored["source_stage_result_id"], obj.source_stage_result_id
                    )
                if (
                    "source_stage_result" in fields or "source_stage_result_id" in fields
                ) and obj.source_stage_result_id:
                    raise ValidationError("赛段正式奖项只能由核定服务生成。")
                if "source_award_decision" in fields or "source_award_decision_id" in fields:
                    decision_stage_result_id = (
                        StageAwardDecision._base_manager.filter(pk=obj.source_award_decision_id)
                        .values_list("stage_result_id", flat=True)
                        .first()
                    )
                    _ensure_stage_result_mutable(decision_stage_result_id)
        return super().bulk_update(objs, fields, *args, **kwargs)


AwardManager = models.Manager.from_queryset(AwardQuerySet)


class Award(models.Model):
    activity = models.ForeignKey("core.Activity", on_delete=models.CASCADE, related_name="awards")
    singer = models.ForeignKey(SingerRegistration, on_delete=models.CASCADE, related_name="awards")
    name = models.CharField(max_length=100)
    is_test_data = models.BooleanField(default=False)
    source_vote_session = models.OneToOneField(
        "voting.VoteSession",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="generated_popularity_award",
    )
    source_stage_result = models.ForeignKey(
        "singer_contest.StageResult",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="awards",
    )
    source_award_decision = models.OneToOneField(
        "singer_contest.StageAwardDecision",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="official_award",
    )
    source_node = models.CharField(max_length=100, blank=True)

    objects = AwardManager()

    class Meta:
        base_manager_name = "objects"
        ordering = ["pk"]

    def clean(self):
        singer = self.singer if self.singer_id else None
        vote_session = self.source_vote_session if self.source_vote_session_id else None
        if self.activity_id and singer and singer.activity_id != self.activity_id:
            raise ValidationError("Award singer must belong to the award activity.")
        if vote_session and self.activity_id and vote_session.activity_id != self.activity_id:
            raise ValidationError("Generated award must belong to the vote activity.")
        if self.source_stage_result_id and self.activity_id:
            source_result = self.source_stage_result
            if source_result is None or source_result.activity_id != self.activity_id:
                raise ValidationError("赛段奖项必须属于同一活动。")

    def save(self, *args, **kwargs):
        self.clean()
        stored = None
        if not self._state.adding and self.pk:
            stored = (
                type(self)
                ._base_manager.filter(pk=self.pk)
                .values("source_stage_result_id", "source_award_decision_id")
                .first()
            )
        if not _award_materialization_authorized() and stored:
            if stored["source_stage_result_id"] or stored["source_award_decision_id"]:
                raise ValidationError("已有来源的正式奖项不可直接修改。")
            if (
                stored["source_stage_result_id"] != self.source_stage_result_id
                or stored["source_award_decision_id"] != self.source_award_decision_id
            ):
                raise ValidationError("奖项 provenance 只能由核定服务维护。")
            _ensure_stage_result_origins(stored["source_stage_result_id"])
        if (
            self.source_stage_result_id or self.source_award_decision_id
        ) and not _award_materialization_authorized():
            raise ValidationError("赛段正式奖项只能由核定服务生成。")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not _award_materialization_authorized():
            stored = (
                type(self)
                ._base_manager.filter(pk=self.pk)
                .values("source_stage_result_id", "source_award_decision_id")
                .first()
            )
            if (
                self.source_stage_result_id
                or self.source_award_decision_id
                or stored
                and (stored["source_stage_result_id"] or stored["source_award_decision_id"])
            ):
                raise ValidationError("已有来源的正式奖项不可直接删除。")
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.singer.name}: {self.name}"


class RoundSetupFactQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    round_lookup = "round"

    def _ensure_mutable(self):
        for round_id in self.values_list(f"{self.round_lookup}_id", flat=True).distinct():
            _ensure_round_setup_fact_mutable(round_id)

    def update(self, **kwargs):
        relation_fields = {self.round_lookup, f"{self.round_lookup}_id"}
        if relation_fields.intersection(kwargs):
            raise ValidationError("轮次事实的轮次关系必须通过正式对象/服务修改。")
        self._ensure_mutable()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        for obj in objs:
            obj.clean()
            _ensure_round_setup_fact_mutable(getattr(obj, f"{self.round_lookup}_id"))
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        objs = list(objs)
        for obj in objs:
            obj.clean()
            _ensure_round_setup_fact_mutable(
                type(obj)
                ._base_manager.filter(pk=obj.pk)
                .values_list(f"{self.round_lookup}_id", flat=True)
                .first()
            )
            _ensure_round_setup_fact_mutable(getattr(obj, f"{self.round_lookup}_id"))
        return super().bulk_update(objs, fields, *args, **kwargs)


RoundSetupFactManager = models.Manager.from_queryset(RoundSetupFactQuerySet)


class ScoringRubricQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    def _ensure_mutable(self):
        if _raw_fact_write_authorized():
            return
        if self.filter(
            rounds__status__in=[
                ContestRound.Status.PREPARED,
                ContestRound.Status.SCORING,
                ContestRound.Status.LOCKED,
            ]
        ).exists():
            raise ValidationError("已被准备轮次使用的评分标准不可直接修改。")

    def update(self, **kwargs):
        self._ensure_mutable()
        if "rubric" in kwargs or "rubric_id" in kwargs:
            _ensure_rubric_mutable(_relation_pk(kwargs.get("rubric", kwargs.get("rubric_id"))))
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        for obj in objs:
            obj.clean()
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        objs = list(objs)
        self._ensure_mutable()
        for obj in objs:
            obj.clean()
        return super().bulk_update(objs, fields, *args, **kwargs)


ScoringRubricManager = models.Manager.from_queryset(ScoringRubricQuerySet)


class RubricCriterionQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    def _ensure_mutable(self):
        if _raw_fact_write_authorized():
            return
        if self.filter(
            rubric__rounds__status__in=[
                ContestRound.Status.PREPARED,
                ContestRound.Status.SCORING,
                ContestRound.Status.LOCKED,
            ]
        ).exists():
            raise ValidationError("已被准备轮次使用的评分标准不可直接修改。")

    def update(self, **kwargs):
        self._ensure_mutable()
        if "rubric" in kwargs or "rubric_id" in kwargs:
            _ensure_rubric_mutable(_relation_pk(kwargs.get("rubric", kwargs.get("rubric_id"))))
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        for obj in objs:
            obj.clean()
            _ensure_rubric_mutable(obj.rubric_id)
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        objs = list(objs)
        for obj in objs:
            obj.clean()
            _ensure_rubric_mutable(_stored_fk_id(obj, "rubric"))
            _ensure_rubric_mutable(obj.rubric_id)
        return super().bulk_update(objs, fields, *args, **kwargs)


RubricCriterionManager = models.Manager.from_queryset(RubricCriterionQuerySet)


class PerformanceGroup(models.Model):
    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="performance_groups"
    )
    round = models.ForeignKey(ContestRound, on_delete=models.CASCADE, related_name="groups")
    name = models.CharField(max_length=100)
    sequence = models.PositiveIntegerField(default=1)
    is_test_data = models.BooleanField(default=False)

    objects = RoundSetupFactManager()

    if TYPE_CHECKING:
        performances: models.Manager["Performance"]

    class Meta:
        base_manager_name = "objects"
        ordering = ["sequence", "pk"]

    def clean(self):
        contest_round = self.round if self.round_id else None
        if self.activity_id and contest_round and contest_round.activity_id != self.activity_id:
            raise ValidationError("表演组必须属于轮次所在活动。")

    def save(self, *args, **kwargs):
        self.clean()
        _ensure_round_setup_fact_mutable(_stored_fk_id(self, "round"))
        _ensure_round_setup_fact_mutable(self.round_id)
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        _ensure_round_setup_fact_mutable(_stored_fk_id(self, "round"))
        _ensure_round_setup_fact_mutable(self.round_id)
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.round.get_round_type_display()} — {self.name}"


class Performance(models.Model):
    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="performances"
    )
    round = models.ForeignKey(ContestRound, on_delete=models.CASCADE, related_name="performances")
    singer = models.ForeignKey(
        SingerRegistration, on_delete=models.CASCADE, related_name="performances"
    )
    group = models.ForeignKey(
        PerformanceGroup,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="performances",
    )
    sequence = models.PositiveIntegerField(default=1)
    song_title = models.CharField(max_length=200, blank=True)
    guest = models.CharField(max_length=100, blank=True, help_text="助演/合作嘉宾")
    duration = models.DurationField(null=True, blank=True, help_text="演出时长")
    notes = models.TextField(blank=True)
    is_test_data = models.BooleanField(default=False)

    objects = RoundSetupFactManager()

    if TYPE_CHECKING:
        singer_id: int

    class Meta:
        base_manager_name = "objects"
        ordering = ["sequence", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["round", "singer"],
                name="performance_one_per_round_per_singer",
            )
        ]

    def clean(self):
        contest_round = self.round if self.round_id else None
        singer = self.singer if self.singer_id else None
        group = self.group if self.group_id else None
        if self.activity_id and contest_round and contest_round.activity_id != self.activity_id:
            raise ValidationError("演出必须属于轮次所在活动。")
        if self.activity_id and singer and singer.activity_id != self.activity_id:
            raise ValidationError("演出选手必须属于同活动。")
        if group and contest_round and group.round_id != contest_round.pk:
            raise ValidationError("演出所属组必须属于同一轮次。")
        if group and contest_round and group.activity_id != contest_round.activity_id:
            raise ValidationError("演出所属组必须属于轮次所在活动。")

    def save(self, *args, **kwargs):
        self.clean()
        _ensure_round_setup_fact_mutable(_stored_fk_id(self, "round"))
        _ensure_round_setup_fact_mutable(self.round_id)
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        _ensure_round_setup_fact_mutable(_stored_fk_id(self, "round"))
        _ensure_round_setup_fact_mutable(self.round_id)
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.singer.name} — {self.song_title or self.round.name or self.round}"


class ScoringRubric(models.Model):
    activity = models.ForeignKey("core.Activity", on_delete=models.CASCADE, related_name="rubrics")
    name = models.CharField(max_length=100)
    description = models.TextField(blank=True)
    sequence = models.PositiveIntegerField(default=1)
    is_test_data = models.BooleanField(default=False)

    objects = ScoringRubricManager()

    if TYPE_CHECKING:
        criteria: models.Manager["RubricCriterion"]

    class Meta:
        base_manager_name = "objects"
        ordering = ["sequence", "pk"]

    def save(self, *args, **kwargs):
        if not _raw_fact_write_authorized() and self.pk:
            if self.rounds.exclude(status=ContestRound.Status.DRAFT).exists():
                raise ValidationError("已被准备轮次使用的评分标准不可直接修改。")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if (
            not _raw_fact_write_authorized()
            and self.rounds.exclude(status=ContestRound.Status.DRAFT).exists()
        ):
            raise ValidationError("已被准备轮次使用的评分标准不可直接删除。")
        return super().delete(*args, **kwargs)

    def __str__(self):
        return self.name


class RubricCriterion(models.Model):
    rubric = models.ForeignKey(ScoringRubric, on_delete=models.CASCADE, related_name="criteria")
    name = models.CharField(max_length=100)
    max_score = models.DecimalField(max_digits=5, decimal_places=2)
    sequence = models.PositiveIntegerField(default=1)
    description = models.TextField(blank=True)
    is_test_data = models.BooleanField(default=False)

    objects = RubricCriterionManager()

    class Meta:
        base_manager_name = "objects"
        ordering = ["sequence", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["rubric", "name"],
                name="rubric_criterion_unique_name",
            )
        ]

    def clean(self):
        if self.max_score is not None and self.max_score <= 0:
            raise ValidationError("评分标准的最高分必须大于 0。")

    def save(self, *args, **kwargs):
        self.clean()
        if not _raw_fact_write_authorized() and self.rubric_id:
            _ensure_rubric_mutable(_stored_fk_id(self, "rubric"))
            if self.rubric.rounds.exclude(status=ContestRound.Status.DRAFT).exists():
                raise ValidationError("已被准备轮次使用的评分标准不可直接修改。")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not _raw_fact_write_authorized() and self.rubric_id:
            _ensure_rubric_mutable(_stored_fk_id(self, "rubric"))
            _ensure_rubric_mutable(self.rubric_id)
            if self.rubric.rounds.exclude(status=ContestRound.Status.DRAFT).exists():
                raise ValidationError("已被准备轮次使用的评分标准不可直接删除。")
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.name} ({self.max_score})"


class CriterionScoreQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    def _ensure_mutable(self):
        if _raw_fact_write_authorized():
            return
        for round_id in self.values_list("score_record__round_id", flat=True).distinct():
            _ensure_round_raw_fact_mutable(round_id)

    def update(self, **kwargs):
        self._ensure_mutable()
        if "score_record" in kwargs or "score_record_id" in kwargs:
            _ensure_round_raw_fact_mutable(
                _score_record_round_id(
                    _relation_pk(kwargs.get("score_record", kwargs.get("score_record_id")))
                )
            )
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        for obj in objs:
            obj.clean()
            _ensure_round_raw_fact_mutable(_score_record_round_id(obj.score_record_id))
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        objs = list(objs)
        for obj in objs:
            obj.clean()
            _ensure_round_raw_fact_mutable(
                _score_record_round_id(_stored_fk_id(obj, "score_record"))
            )
            _ensure_round_raw_fact_mutable(_score_record_round_id(obj.score_record_id))
        return super().bulk_update(objs, fields, *args, **kwargs)


CriterionScoreManager = models.Manager.from_queryset(CriterionScoreQuerySet)


class CriterionScore(models.Model):
    score_record = models.ForeignKey(
        ScoreRecord, on_delete=models.CASCADE, related_name="criterion_scores"
    )
    criterion = models.ForeignKey(RubricCriterion, on_delete=models.CASCADE, related_name="scores")
    value = models.DecimalField(max_digits=5, decimal_places=2)
    is_test_data = models.BooleanField(default=False)

    objects = CriterionScoreManager()

    class Meta:
        base_manager_name = "objects"
        constraints = [
            models.UniqueConstraint(
                fields=["score_record", "criterion"],
                name="criterion_score_unique_per_record_criterion",
            )
        ]

    def clean(self):
        if self.value is not None and self.value < 0:
            raise ValidationError("评分必须大于等于 0。")
        score_record = self.score_record if self.score_record_id else None
        criterion = self.criterion if self.criterion_id else None
        if score_record and criterion:
            round_rubric = score_record.round.rubric if score_record.round_id else None
            if round_rubric and criterion.rubric_id != round_rubric.pk:
                raise ValidationError("分项评分必须使用轮次绑定的评分标准。")

    def save(self, *args, **kwargs):
        self.clean()
        _ensure_round_raw_fact_mutable(_score_record_round_id(_stored_fk_id(self, "score_record")))
        round_id = _score_record_round_id(self.score_record_id)
        _ensure_round_raw_fact_mutable(round_id)
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        _ensure_round_raw_fact_mutable(_score_record_round_id(_stored_fk_id(self, "score_record")))
        round_id = _score_record_round_id(self.score_record_id)
        _ensure_round_raw_fact_mutable(round_id)
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.criterion.name}: {self.value}"


class StageResultQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    """Guard: a CONFIRMED stage result is immutable; only confirm_stage_result() confirms."""

    def _ensure_mutable(self):
        if self.filter(status=StageResult.Status.CONFIRMED).exists():
            raise ValidationError("A confirmed stage result is immutable.")

    def create(self, **kwargs):
        obj = cast(StageResult, self.model(**kwargs))
        obj.save(force_insert=True, using=self.db)
        return obj

    def update(self, **kwargs):
        self._ensure_mutable()
        if (
            not authority_authorized(STAGE_RESULT_CONFIRM)
            and kwargs.get("status") == StageResult.Status.CONFIRMED
        ):
            raise ValidationError("Only confirm_stage_result() may confirm a stage result.")
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        if "status" in fields:
            raise ValidationError("StageResult status transitions are service-only.")
        return super().bulk_update(objs, fields, *args, **kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        for obj in objs:
            obj.clean()
        if any(o.status == StageResult.Status.CONFIRMED for o in objs):
            raise ValidationError("Only confirm_stage_result() may confirm a stage result.")
        return super().bulk_create(objs, *args, **kwargs)


StageResultManager = models.Manager.from_queryset(StageResultQuerySet)


class StageResult(models.Model):
    """A persisted outcome of replaying a frozen ruleset over raw facts (M1-F)."""

    class Status(models.TextChoices):
        HOLD = ResolverState.HOLD.value, "待齐数据"
        REVIEW = ResolverState.REVIEW.value, "待人工核定"
        READY_TO_CONFIRM = "ready_to_confirm", "待核定"
        CONFIRMED = "confirmed", "已核定"

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="stage_results"
    )
    ruleset_version = models.ForeignKey(
        "ruleset.RulesetVersion", on_delete=models.PROTECT, related_name="stage_results"
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="stage_results",
    )
    confirmed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="confirmed_stage_results",
    )
    stage_key = models.CharField(
        max_length=100, help_text="Bindable stage identifier, e.g. '院十佳'."
    )
    status = models.CharField(max_length=16, choices=Status, default=Status.HOLD)
    reasons = models.JSONField(default=list, blank=True)
    ruleset_hash = models.CharField(
        max_length=64,
        blank=True,
        help_text="sha256 of the frozen ruleset definition (ExecutionPlan).",
    )
    input_fingerprint = models.CharField(
        max_length=64,
        blank=True,
        help_text="sha256 of the raw-facts snapshot the resolver consumed.",
    )
    schema_version = models.PositiveIntegerField(default=1)
    plan_version = models.PositiveIntegerField(default=0)
    result_version = models.PositiveIntegerField(default=1)
    computed_at = models.DateTimeField(auto_now_add=True)
    confirmed_at = models.DateTimeField(
        null=True, blank=True, help_text="When a staff member 核定并锁定 the result."
    )
    is_test_data = models.BooleanField(default=False)

    objects = StageResultManager()

    if TYPE_CHECKING:
        activity_id: int
        ruleset_version_id: int
        decisions: models.Manager["StageDecision"]

    class Meta:
        base_manager_name = "objects"
        ordering = ["-computed_at", "pk"]
        constraints = [
            # M1-R9 (§二 Authoritative Recompute): the per-stage result_version is a formal
            # publication number. Two concurrent recomputes of one activity must not mint
            # the same version — the Activity FOR UPDATE lock serializes them, and this DB
            # unique is the final guard that makes the race impossible rather than unlikely.
            models.UniqueConstraint(
                fields=["activity", "stage_key", "result_version"],
                name="stage_result_unique_version",
            ),
            # M1-R9-Final: a CONFIRMED stage result demands the confirming audit trail;
            # a non-confirmed one must not carry it (the confirm service sets both together).
            models.CheckConstraint(
                condition=(
                    (
                        Q(status="confirmed")
                        & Q(confirmed_at__isnull=False)
                        & Q(confirmed_by__isnull=False)
                    )
                    | (
                        ~Q(status="confirmed")
                        & Q(confirmed_at__isnull=True)
                        & Q(confirmed_by__isnull=True)
                    )
                ),
                name="stage_result_confirmed_trail_consistent",
            ),
        ]

    _immutable_fields = (
        "activity_id",
        "ruleset_version_id",
        "created_by_id",
        "stage_key",
        "status",
        "reasons",
        "ruleset_hash",
        "input_fingerprint",
        "schema_version",
        "plan_version",
        "result_version",
        "computed_at",
        "confirmed_by_id",
        "confirmed_at",
        "is_test_data",
    )

    def _stored(self, fields):
        if self._state.adding or not self.pk:
            return None
        return type(self)._base_manager.filter(pk=self.pk).values(*fields).first()

    def clean(self):
        if self.activity_id and bool(self.is_test_data) != runtime_is_test(self.activity):
            raise ValidationError("A stage result's test marker must match its activity lifecycle.")

    def save(self, *args, **kwargs):
        self.clean()
        confirm_authorized = authority_authorized(STAGE_RESULT_CONFIRM)
        stored = self._stored(self._immutable_fields)
        if self._state.adding:
            if not confirm_authorized and self.status == self.Status.CONFIRMED:
                raise ValidationError("只在核定服务中产生已核定赛段结果。")
        elif not confirm_authorized:
            if stored and stored["status"] == self.Status.CONFIRMED:
                modified = [f for f in self._immutable_fields if getattr(self, f) != stored[f]]
                if modified:
                    raise ValidationError(
                        f"A confirmed stage result is immutable (cannot change {modified})."
                    )
            if (
                stored
                and stored["status"] != self.Status.CONFIRMED
                and self.status == self.Status.CONFIRMED
            ):
                raise ValidationError("Only confirm_stage_result() may confirm a stage result.")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not authority_authorized(STAGE_RESULT_CONFIRM):
            stored = self._stored(["status"])
            if stored and stored["status"] == self.Status.CONFIRMED:
                raise ValidationError("A confirmed stage result is immutable.")
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.activity.title} — {self.stage_key} ({self.get_status_display()})"


class StageDecisionQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    """Guard: decisions of a CONFIRMED (locked) stage result are immutable."""

    def _ensure_mutable(self):
        if self.filter(stage_result__status=StageResult.Status.CONFIRMED).exists():
            raise ValidationError("Decisions of a confirmed stage result are immutable.")

    def update(self, **kwargs):
        self._ensure_mutable()
        if "stage_result" in kwargs or "stage_result_id" in kwargs:
            _ensure_stage_result_mutable(
                _relation_pk(kwargs.get("stage_result", kwargs.get("stage_result_id")))
            )
        _ensure_same_activity_stage_child_update(self, kwargs)
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        objs = list(objs)
        for obj in objs:
            obj.clean()
            _ensure_same_activity_stage_child_instance(obj)
            _ensure_stage_result_origins(_stored_fk_id(obj, "stage_result"), obj.stage_result_id)
            if (
                obj.stage_result_id
                and StageResult._base_manager.filter(
                    pk=obj.stage_result_id, status=StageResult.Status.CONFIRMED
                ).exists()
            ):
                raise ValidationError("Decisions of a confirmed stage result are immutable.")
        return super().bulk_update(objs, fields, *args, **kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        for obj in objs:
            obj.clean()
        parent_ids = {o.stage_result_id for o in objs if o.stage_result_id}
        if StageResult._base_manager.filter(
            pk__in=parent_ids, status=StageResult.Status.CONFIRMED
        ).exists():
            raise ValidationError("Decisions of a confirmed stage result are immutable.")
        return super().bulk_create(objs, *args, **kwargs)


StageDecisionManager = models.Manager.from_queryset(StageDecisionQuerySet)


class StageDecision(models.Model):
    """Per-contestant decision produced by the deterministic resolver (M1-F)."""

    stage_result = models.ForeignKey(
        StageResult, on_delete=models.CASCADE, related_name="decisions"
    )
    singer = models.ForeignKey(
        SingerRegistration, on_delete=models.CASCADE, related_name="stage_decisions"
    )
    outcome_code = models.CharField(
        max_length=20, choices=[(v.value, v.value) for v in OutcomeCode]
    )
    source_node = models.CharField(max_length=100, blank=True)
    rank = models.IntegerField(null=True, blank=True)
    score = models.DecimalField(max_digits=14, decimal_places=6, null=True, blank=True)
    reason = models.TextField(blank=True)
    is_test_data = models.BooleanField(default=False)

    objects = StageDecisionManager()

    if TYPE_CHECKING:
        singer_id: int

    class Meta:
        base_manager_name = "objects"
        ordering = ["stage_result", "rank", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["stage_result", "singer"],
                name="stage_decision_one_per_result_singer",
            )
        ]

    def clean(self):
        result = self.stage_result if self.stage_result_id else None
        if result:
            if bool(self.is_test_data) != bool(result.is_test_data):
                raise ValidationError("A stage decision's test marker must match its stage result.")
            singer = self.singer if self.singer_id else None
            if singer and singer.activity_id != result.activity_id:
                raise ValidationError("A stage decision singer must belong to the result activity.")

    def _parent_confirmed(self):
        parent_id = self.stage_result_id
        if parent_id is None:
            return None
        return (
            StageResult._base_manager.filter(pk=parent_id).values_list("status", flat=True).first()
        )

    def save(self, *args, **kwargs):
        self.clean()
        _ensure_same_activity_stage_child_instance(self)
        _ensure_stage_result_origins(_stored_fk_id(self, "stage_result"), self.stage_result_id)
        if self._parent_confirmed() == StageResult.Status.CONFIRMED:
            raise ValidationError("Decisions of a confirmed stage result are immutable.")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        _ensure_stage_result_origins(_stored_fk_id(self, "stage_result"), self.stage_result_id)
        if self._parent_confirmed() == StageResult.Status.CONFIRMED:
            raise ValidationError("Decisions of a confirmed stage result are immutable.")
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.singer.name} — {self.outcome_code}"


class StageAwardDecisionQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    def _ensure_mutable(self):
        if self.filter(stage_result__status=StageResult.Status.CONFIRMED).exists():
            raise ValidationError("已核定赛段的奖项候选不可修改。")

    def update(self, **kwargs):
        self._ensure_mutable()
        if "stage_result" in kwargs or "stage_result_id" in kwargs:
            _ensure_stage_result_mutable(
                _relation_pk(kwargs.get("stage_result", kwargs.get("stage_result_id")))
            )
        _ensure_same_activity_stage_child_update(self, kwargs, has_activity_field=True)
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        objs = list(objs)
        for obj in objs:
            obj.clean()
            _ensure_same_activity_stage_child_instance(obj, has_activity_field=True)
            _ensure_stage_result_origins(_stored_fk_id(obj, "stage_result"), obj.stage_result_id)
            if (
                obj.stage_result_id
                and StageResult._base_manager.filter(
                    pk=obj.stage_result_id, status=StageResult.Status.CONFIRMED
                ).exists()
            ):
                raise ValidationError("已核定赛段的奖项候选不可修改。")
        return super().bulk_update(objs, fields, *args, **kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        for obj in objs:
            obj.clean()
        parent_ids = {o.stage_result_id for o in objs if o.stage_result_id}
        if StageResult._base_manager.filter(
            pk__in=parent_ids, status=StageResult.Status.CONFIRMED
        ).exists():
            raise ValidationError("已核定赛段的奖项候选不可修改。")
        return super().bulk_create(objs, *args, **kwargs)


StageAwardDecisionManager = models.Manager.from_queryset(StageAwardDecisionQuerySet)


class StageAwardDecision(models.Model):
    """A computed award candidate; only confirmation materializes :class:`Award`."""

    stage_result = models.ForeignKey(
        StageResult, on_delete=models.CASCADE, related_name="award_decisions"
    )
    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="stage_award_decisions"
    )
    singer = models.ForeignKey(
        SingerRegistration, on_delete=models.CASCADE, related_name="stage_award_decisions"
    )
    name = models.CharField(max_length=100)
    source_node = models.CharField(max_length=100, blank=True)

    is_test_data = models.BooleanField(default=False)

    objects = StageAwardDecisionManager()

    class Meta:
        base_manager_name = "objects"
        ordering = ["stage_result", "name", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["stage_result", "singer", "name"],
                name="stage_award_decision_unique_candidate",
            )
        ]

    def clean(self):
        result = self.stage_result if self.stage_result_id else None
        singer = self.singer if self.singer_id else None
        if result:
            if result.activity_id != self.activity_id:
                raise ValidationError("奖项候选必须属于结果所在活动。")
            if bool(self.is_test_data) != bool(result.is_test_data):
                raise ValidationError("奖项候选的测试标记必须匹配赛段结果。")
        if singer and singer.activity_id != self.activity_id:
            raise ValidationError("奖项候选选手必须属于同一活动。")

    def save(self, *args, **kwargs):
        self.clean()
        _ensure_same_activity_stage_child_instance(self, has_activity_field=True)
        _ensure_stage_result_origins(_stored_fk_id(self, "stage_result"), self.stage_result_id)
        if (
            self.stage_result_id
            and StageResult._base_manager.filter(
                pk=self.stage_result_id, status=StageResult.Status.CONFIRMED
            ).exists()
        ):
            raise ValidationError("已核定赛段的奖项候选不可修改。")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        _ensure_stage_result_origins(_stored_fk_id(self, "stage_result"), self.stage_result_id)
        if (
            self.stage_result_id
            and StageResult._base_manager.filter(
                pk=self.stage_result_id, status=StageResult.Status.CONFIRMED
            ).exists()
        ):
            raise ValidationError("已核定赛段的奖项候选不可删除。")
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.name}: {self.singer.name}"


class CompositeResultQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    """Guard: composites of a CONFIRMED (locked) stage result are immutable."""

    def _ensure_mutable(self):
        if self.filter(stage_result__status=StageResult.Status.CONFIRMED).exists():
            raise ValidationError("Composites of a confirmed stage result are immutable.")

    def update(self, **kwargs):
        self._ensure_mutable()
        if "stage_result" in kwargs or "stage_result_id" in kwargs:
            _ensure_stage_result_mutable(
                _relation_pk(kwargs.get("stage_result", kwargs.get("stage_result_id")))
            )
        _ensure_same_activity_stage_child_update(self, kwargs)
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        objs = list(objs)
        for obj in objs:
            obj.clean()
            _ensure_same_activity_stage_child_instance(obj)
            _ensure_stage_result_origins(_stored_fk_id(obj, "stage_result"), obj.stage_result_id)
            if (
                obj.stage_result_id
                and StageResult._base_manager.filter(
                    pk=obj.stage_result_id, status=StageResult.Status.CONFIRMED
                ).exists()
            ):
                raise ValidationError("Composites of a confirmed stage result are immutable.")
        return super().bulk_update(objs, fields, *args, **kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        objs = list(objs)
        for obj in objs:
            obj.clean()
        parent_ids = {o.stage_result_id for o in objs if o.stage_result_id}
        if StageResult._base_manager.filter(
            pk__in=parent_ids, status=StageResult.Status.CONFIRMED
        ).exists():
            raise ValidationError("Composites of a confirmed stage result are immutable.")
        return super().bulk_create(objs, *args, **kwargs)


CompositeResultManager = models.Manager.from_queryset(CompositeResultQuerySet)


class CompositeResult(models.Model):
    """Per-contestant per-aggregate composite value with its component breakdown."""

    stage_result = models.ForeignKey(
        StageResult, on_delete=models.CASCADE, related_name="composites"
    )
    singer = models.ForeignKey(
        SingerRegistration, on_delete=models.CASCADE, related_name="stage_composites"
    )
    node_key = models.CharField(max_length=100)
    value = models.DecimalField(max_digits=14, decimal_places=6)
    components = models.JSONField(default=list, blank=True)
    is_test_data = models.BooleanField(default=False)

    objects = CompositeResultManager()

    class Meta:
        base_manager_name = "objects"
        ordering = ["stage_result", "node_key", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["stage_result", "singer", "node_key"],
                name="composite_one_per_result_singer_node",
            )
        ]

    def clean(self):
        result = self.stage_result if self.stage_result_id else None
        if result:
            if bool(self.is_test_data) != bool(result.is_test_data):
                raise ValidationError("A composite's test marker must match its stage result.")
            singer = self.singer if self.singer_id else None
            if singer and singer.activity_id != result.activity_id:
                raise ValidationError("A composite singer must belong to the result activity.")

    def _parent_confirmed(self):
        parent_id = self.stage_result_id
        if parent_id is None:
            return None
        return (
            StageResult._base_manager.filter(pk=parent_id).values_list("status", flat=True).first()
        )

    def save(self, *args, **kwargs):
        self.clean()
        _ensure_same_activity_stage_child_instance(self)
        _ensure_stage_result_origins(_stored_fk_id(self, "stage_result"), self.stage_result_id)
        if self._parent_confirmed() == StageResult.Status.CONFIRMED:
            raise ValidationError("Composites of a confirmed stage result are immutable.")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        _ensure_stage_result_origins(_stored_fk_id(self, "stage_result"), self.stage_result_id)
        if self._parent_confirmed() == StageResult.Status.CONFIRMED:
            raise ValidationError("Composites of a confirmed stage result are immutable.")
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.singer.name} — {self.node_key}: {self.value}"


class ManualDecisionQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    """Guard: a queryset-level bulk mutation is the same ORM bypass as a bare save().

    ``set_manual_decision`` and the residue-cleanup service hold the write authority; an
    untrusted ``.update()``/``.delete()``/``.bulk_create()``/``.bulk_update()`` is refused.
    ``create()`` routes through :meth:`ManualDecision.save` (itself guarded), so it needs
    no override.
    """

    def _ensure_auth(self):
        if not _manual_write_authorized():
            raise ValidationError(
                "ManualDecision 只能通过正式 service 写入（set_manual_decision）。"
            )

    def update(self, **kwargs):
        self._ensure_auth()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_auth()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        self._ensure_auth()
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_auth()
        return super().bulk_update(objs, fields, *args, **kwargs)


ManualDecisionManager = models.Manager.from_queryset(ManualDecisionQuerySet)


class ManualDecision(models.Model):
    """A staff member's human pick for a MANUAL_SELECT node (§31 closure).

    Stored against the frozen ruleset version so each ruleset carries its own
    manual choices; recompute re-reads these to source the ``manual`` ResolveInput
    keyed by the MANUAL_SELECT node key and (for group sources) group name.
    """

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="manual_decisions"
    )
    ruleset_version = models.ForeignKey(
        "ruleset.RulesetVersion", on_delete=models.CASCADE, related_name="manual_decisions"
    )
    manual_key = models.CharField(
        max_length=100, help_text="The MANUAL_SELECT node key, e.g. 'manual'."
    )
    group = models.CharField(
        max_length=100,
        blank=True,
        help_text="Group name; '' for a non-group (flat) manual source.",
    )
    chosen = models.JSONField(
        default=list, help_text="Ordered SingerRegistration pk strings picked into this group."
    )
    is_test_data = models.BooleanField(default=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="manual_decisions",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = ManualDecisionManager()

    class Meta:
        base_manager_name = "objects"
        unique_together = ("ruleset_version", "manual_key", "group")

    def clean(self):
        singer_by_key = {
            str(s.pk): s
            for s in SingerRegistration.objects.filter(activity_id=self.activity_id).only("pk")
        }
        missing = [c for c in (self.chosen or []) if str(c) not in singer_by_key]
        if missing:
            raise ValidationError(f"手动选入的选手不属于该活动：{missing}")

    def save(self, *args, **kwargs):
        self.clean()
        if not _manual_write_authorized():
            raise ValidationError(
                "ManualDecision 只能通过正式 service 写入（set_manual_decision）。"
            )
        from .services import ensure_manual_not_consumed_by_confirmed_stage

        ensure_manual_not_consumed_by_confirmed_stage(self.ruleset_version, self.manual_key)
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not _manual_write_authorized():
            raise ValidationError("ManualDecision 只能通过正式 service 删除。")
        from .services import ensure_manual_not_consumed_by_confirmed_stage

        ensure_manual_not_consumed_by_confirmed_stage(self.ruleset_version, self.manual_key)
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.manual_key} — {self.group or '(整体)'}"


class DuelDecisionQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    """Guard direct ORM mutations of persisted pairwise decisions."""

    def _ensure_auth(self):
        if not _duel_write_authorized():
            raise ValidationError("DuelDecision 只能通过正式 service 写入（set_duel_decision）。")

    def update(self, **kwargs):
        self._ensure_auth()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_auth()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        self._ensure_auth()
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_auth()
        return super().bulk_update(objs, fields, *args, **kwargs)


DuelDecisionManager = models.Manager.from_queryset(DuelDecisionQuerySet)


class DuelDecision(models.Model):
    """A persisted explicit winner for one frozen ruleset DUEL pair."""

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="duel_decisions"
    )
    ruleset_version = models.ForeignKey(
        "ruleset.RulesetVersion", on_delete=models.CASCADE, related_name="duel_decisions"
    )
    duel_key = models.CharField(max_length=100)
    pair_key = models.CharField(
        max_length=201, help_text="两个选手 PK 按当前赛制名单顺序拼接，例如 12|34。"
    )
    winner = models.CharField(max_length=100)
    is_test_data = models.BooleanField(default=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="duel_decisions",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = DuelDecisionManager()

    class Meta:
        base_manager_name = "objects"
        unique_together = ("ruleset_version", "duel_key", "pair_key")
        ordering = ["duel_key", "pair_key", "pk"]

    def clean(self):
        if self.ruleset_version_id and self.activity_id:
            if self.ruleset_version.ruleset.activity_id != self.activity_id:
                raise ValidationError("对决决定与赛制版本必须属于同一活动。")
        parts = self.pair_key.split("|") if self.pair_key else []
        if len(parts) != 2 or len(set(parts)) != 2 or not all(part.isdigit() for part in parts):
            raise ValidationError("对决 pair_key 必须是两个不同选手 PK，以 | 分隔。")
        if self.winner not in parts:
            raise ValidationError("对决胜者必须属于 pair_key。")
        singer_ids = set(
            str(pk)
            for pk in SingerRegistration.objects.filter(
                activity_id=self.activity_id, pk__in=parts
            ).values_list("pk", flat=True)
        )
        if singer_ids != set(parts):
            raise ValidationError("对决选手必须属于该活动。")

    def save(self, *args, **kwargs):
        self.clean()
        if not _duel_write_authorized():
            raise ValidationError("DuelDecision 只能通过正式 service 写入（set_duel_decision）。")
        from .services import ensure_duel_not_consumed_by_confirmed_stage

        ensure_duel_not_consumed_by_confirmed_stage(
            self.ruleset_version, self.duel_key, self.pair_key
        )
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not _duel_write_authorized():
            raise ValidationError("DuelDecision 只能通过正式 service 删除。")
        from .services import ensure_duel_not_consumed_by_confirmed_stage

        ensure_duel_not_consumed_by_confirmed_stage(
            self.ruleset_version, self.duel_key, self.pair_key
        )
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.duel_key} — {self.pair_key}: {self.winner}"
