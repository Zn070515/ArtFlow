from typing import Any

from common.lifecycle import runtime_is_test
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q
from ruleset.resolver import OutcomeCode, ResolverState

from .deletion import cascade_draft_snapshots_or_protect_prepared


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

    class ScoringMode(models.TextChoices):
        AVERAGE = "average", "平均分"
        DROP_HIGH_LOW = "drop_high_low", "去最高最低后平均"

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
    scheduled_at = models.DateTimeField(null=True, blank=True)
    venue = models.CharField(max_length=200, blank=True)
    rubric = models.ForeignKey(
        "ScoringRubric", on_delete=models.SET_NULL, null=True, blank=True, related_name="rounds"
    )
    advance_count = models.IntegerField(default=0)
    status = models.CharField(max_length=10, choices=Status, default=Status.DRAFT)
    is_locked = models.BooleanField(default=False)
    advancement_status = models.CharField(
        max_length=16, choices=AdvancementStatus, default=AdvancementStatus.AUTO
    )

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
    objects = RoundEntryManager()

    class Meta:
        base_manager_name = "objects"
        unique_together = [("round", "singer")]

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

    class Meta:
        ordering = ["pk"]

    def clean(self):
        singer = self.singer if self.singer_id else None
        vote_session = self.source_vote_session if self.source_vote_session_id else None
        if self.activity_id and singer and singer.activity_id != self.activity_id:
            raise ValidationError("Award singer must belong to the award activity.")
        if vote_session and self.activity_id and vote_session.activity_id != self.activity_id:
            raise ValidationError("Generated award must belong to the vote activity.")

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
    """Guard: a READY (locked/announced) stage result is immutable."""

    def _ensure_mutable(self):
        if self.filter(status=StageResult.Status.READY).exists():
            raise ValidationError("A READY stage result is immutable.")

    def update(self, **kwargs):
        self._ensure_mutable()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        return super().bulk_update(objs, fields, *args, **kwargs)


StageResultManager = models.Manager.from_queryset(StageResultQuerySet)


class StageResult(models.Model):
    """A persisted outcome of replaying a frozen ruleset over raw facts (M1-F)."""

    class Status(models.TextChoices):
        HOLD = ResolverState.HOLD.value, "待齐数据"
        REVIEW = ResolverState.REVIEW.value, "待人工核定"
        READY = ResolverState.READY.value, "可发布"

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
    stage_key = models.CharField(
        max_length=100, help_text="Bindable stage identifier, e.g. '院十佳'."
    )
    status = models.CharField(max_length=16, choices=Status, default=Status.HOLD)
    reasons = models.JSONField(default=list, blank=True)
    content_hash = models.CharField(max_length=64, blank=True)
    schema_version = models.PositiveIntegerField(default=1)
    plan_version = models.PositiveIntegerField(default=0)
    result_version = models.PositiveIntegerField(default=1)
    computed_at = models.DateTimeField(auto_now_add=True)
    is_test_data = models.BooleanField(default=False)

    objects = StageResultManager()

    class Meta:
        ordering = ["-computed_at", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["activity", "stage_key", "content_hash"],
                name="stage_result_unique_per_activity_stage_hash",
            )
        ]

    def clean(self):
        if self.activity_id and bool(self.is_test_data) != runtime_is_test(self.activity):
            raise ValidationError("A stage result's test marker must match its activity lifecycle.")

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.activity.title} — {self.stage_key} ({self.get_status_display()})"


class StageDecisionQuerySet(models.QuerySet):
    """Guard: decisions of a READY (locked) stage result are immutable."""

    def _ensure_mutable(self):
        if self.filter(stage_result__status=StageResult.Status.READY).exists():
            raise ValidationError("Decisions of a READY stage result are immutable.")

    def update(self, **kwargs):
        self._ensure_mutable()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        return super().bulk_update(objs, fields, *args, **kwargs)


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

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.singer.name} — {self.outcome_code}"


class CompositeResultQuerySet(models.QuerySet):
    """Guard: composites of a READY (locked) stage result are immutable."""

    def _ensure_mutable(self):
        if self.filter(stage_result__status=StageResult.Status.READY).exists():
            raise ValidationError("Composites of a READY stage result are immutable.")

    def update(self, **kwargs):
        self._ensure_mutable()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        return super().bulk_update(objs, fields, *args, **kwargs)


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

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.singer.name} — {self.node_key}: {self.value}"
