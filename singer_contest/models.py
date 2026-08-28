from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models

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

    activity = models.ForeignKey("core.Activity", on_delete=models.CASCADE, related_name="rounds")
    round_type = models.CharField(max_length=16, choices=RoundType)
    scoring_mode = models.CharField(max_length=16, choices=ScoringMode, default=ScoringMode.AVERAGE)
    name = models.CharField(max_length=100, blank=True)
    advance_count = models.IntegerField(default=0)
    status = models.CharField(max_length=10, choices=Status, default=Status.DRAFT)
    is_locked = models.BooleanField(default=False)

    class Meta:
        unique_together = [("activity", "round_type")]

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
        return super().delete(*args, **kwargs)


class RoundSnapshotQuerySet(models.QuerySet):
    related_field = ""
    related_model = None

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
        raise ValidationError("Snapshot relations must be updated with a model instance or primary key.")

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
            if self.exclude(**{f"{self.related_field}__activity_id": contest_round.activity_id}).exists():
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
