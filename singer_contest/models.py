import threading
from typing import Any, cast

from common.authority import STAGE_RESULT_CONFIRM, authority_authorized
from common.lifecycle import runtime_is_test
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q
from ruleset.resolver import OutcomeCode, ResolverState

from .deletion import cascade_draft_snapshots_or_protect_prepared

# M1-R9 (§三 ManualDecision Authority): a ManualDecision is a human picking a MANUAL_SELECT
# outcome that a CONFIRMED stage may have already read, so its mutation must run through a
# formal service that holds the Activity lock (Activity → RulesetVersion/ManualDecision) and
# re-checks the consumed-by-confirmed guard inside that window. Direct ``.save()``/``.delete()``
# bypass the lock, so they are refused unless the service is actively wrapping the write. The
# guard is thread-local so concurrent service calls in separate threads don't leak into each other.
_manual_writes = threading.local()


def _manual_write_authorized() -> bool:
    return bool(getattr(_manual_writes, "authorized", False))


def _authorize_manual_write(authorized: bool) -> None:
    _manual_writes.authorized = authorized


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

    class Meta:
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
        PREVIOUS_RANK_ASC = "previous_rank_asc", "上一轮排名升序"
        PREVIOUS_RANK_DESC = "previous_rank_desc", "上一轮排名降序"

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

    class Meta:
        constraints = [
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

    class Meta:
        ordering = ["pk"]

    def __str__(self):
        return self.name


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


class RoundSnapshotQuerySet(models.QuerySet):
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


class ScoreRecord(models.Model):
    round = models.ForeignKey(ContestRound, on_delete=models.CASCADE, related_name="scores")
    singer = models.ForeignKey(SingerRegistration, on_delete=models.CASCADE, related_name="scores")
    judge = models.ForeignKey(Judge, on_delete=models.CASCADE, related_name="scores")
    score = models.DecimalField(max_digits=5, decimal_places=2)
    notes = models.CharField(max_length=200, blank=True)
    is_test_data = models.BooleanField(default=False)

    class Meta:
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
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.singer.name} — {self.judge.name}: {self.score}"


class ScoreSummary(models.Model):
    round = models.ForeignKey(ContestRound, on_delete=models.CASCADE, related_name="summaries")
    singer = models.ForeignKey(
        SingerRegistration, on_delete=models.CASCADE, related_name="summaries"
    )
    average_score = models.DecimalField(max_digits=6, decimal_places=3, default=0)
    rank = models.IntegerField(default=0)
    is_advanced = models.BooleanField(default=False)
    is_test_data = models.BooleanField(default=False)

    class Meta:
        unique_together = [("round", "singer")]
        ordering = ["-average_score"]

    def __str__(self):
        return f"{self.singer.name}: {self.average_score} (#{self.rank})"


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

    class Meta:
        ordering = ["stage_key", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["activity", "stage_key", "singer"],
                name="ux_audience_activity_stage_singer",
            ),
        ]

    def __str__(self):
        return f"{self.singer.name}@{self.stage_key}: {self.score}"


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
    source_node = models.CharField(max_length=100, blank=True)

    class Meta:
        ordering = ["pk"]

    def clean(self):
        singer = self.singer if self.singer_id else None
        vote_session = self.source_vote_session if self.source_vote_session_id else None
        if self.activity_id and singer and singer.activity_id != self.activity_id:
            raise ValidationError("Award singer must belong to the award activity.")
        if vote_session and self.activity_id and vote_session.activity_id != self.activity_id:
            raise ValidationError("Generated award must belong to the vote activity.")
        if self.source_stage_result_id and self.activity_id:
            if self.source_stage_result.activity_id != self.activity_id:
                raise ValidationError("赛段奖项必须属于同一活动。")

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.singer.name}: {self.name}"


class PerformanceGroup(models.Model):
    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="performance_groups"
    )
    round = models.ForeignKey(ContestRound, on_delete=models.CASCADE, related_name="groups")
    name = models.CharField(max_length=100)
    sequence = models.PositiveIntegerField(default=1)
    is_test_data = models.BooleanField(default=False)

    class Meta:
        ordering = ["sequence", "pk"]

    def clean(self):
        contest_round = self.round if self.round_id else None
        if self.activity_id and contest_round and contest_round.activity_id != self.activity_id:
            raise ValidationError("表演组必须属于轮次所在活动。")

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)

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

    class Meta:
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
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.singer.name} — {self.song_title or self.round.name or self.round}"


class ScoringRubric(models.Model):
    activity = models.ForeignKey("core.Activity", on_delete=models.CASCADE, related_name="rubrics")
    name = models.CharField(max_length=100)
    description = models.TextField(blank=True)
    sequence = models.PositiveIntegerField(default=1)
    is_test_data = models.BooleanField(default=False)

    class Meta:
        ordering = ["sequence", "pk"]

    def __str__(self):
        return self.name


class RubricCriterion(models.Model):
    rubric = models.ForeignKey(ScoringRubric, on_delete=models.CASCADE, related_name="criteria")
    name = models.CharField(max_length=100)
    max_score = models.DecimalField(max_digits=5, decimal_places=2)
    sequence = models.PositiveIntegerField(default=1)
    description = models.TextField(blank=True)
    is_test_data = models.BooleanField(default=False)

    class Meta:
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
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.name} ({self.max_score})"


class CriterionScore(models.Model):
    score_record = models.ForeignKey(
        ScoreRecord, on_delete=models.CASCADE, related_name="criterion_scores"
    )
    criterion = models.ForeignKey(RubricCriterion, on_delete=models.CASCADE, related_name="scores")
    value = models.DecimalField(max_digits=5, decimal_places=2)
    is_test_data = models.BooleanField(default=False)

    class Meta:
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
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.criterion.name}: {self.value}"


class StageResultQuerySet(models.QuerySet):
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

    class Meta:
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
        stored = self._stored(["status"])
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


class StageDecisionQuerySet(models.QuerySet):
    """Guard: decisions of a CONFIRMED (locked) stage result are immutable."""

    def _ensure_mutable(self):
        if self.filter(stage_result__status=StageResult.Status.CONFIRMED).exists():
            raise ValidationError("Decisions of a confirmed stage result are immutable.")

    def update(self, **kwargs):
        self._ensure_mutable()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        return super().bulk_update(objs, fields, *args, **kwargs)

    def bulk_create(self, objs, *args, **kwargs):
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

    class Meta:
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
        if self._parent_confirmed() == StageResult.Status.CONFIRMED:
            raise ValidationError("Decisions of a confirmed stage result are immutable.")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if self._parent_confirmed() == StageResult.Status.CONFIRMED:
            raise ValidationError("Decisions of a confirmed stage result are immutable.")
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.singer.name} — {self.outcome_code}"


class CompositeResultQuerySet(models.QuerySet):
    """Guard: composites of a CONFIRMED (locked) stage result are immutable."""

    def _ensure_mutable(self):
        if self.filter(stage_result__status=StageResult.Status.CONFIRMED).exists():
            raise ValidationError("Composites of a confirmed stage result are immutable.")

    def update(self, **kwargs):
        self._ensure_mutable()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        return super().bulk_update(objs, fields, *args, **kwargs)

    def bulk_create(self, objs, *args, **kwargs):
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
        if self._parent_confirmed() == StageResult.Status.CONFIRMED:
            raise ValidationError("Composites of a confirmed stage result are immutable.")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if self._parent_confirmed() == StageResult.Status.CONFIRMED:
            raise ValidationError("Composites of a confirmed stage result are immutable.")
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.singer.name} — {self.node_key}: {self.value}"


class ManualDecisionQuerySet(models.QuerySet):
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
