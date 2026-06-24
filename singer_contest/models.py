from django.conf import settings
from django.db import models


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

    activity = models.ForeignKey("core.Activity", on_delete=models.CASCADE, related_name="singer_registrations")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="singer_registrations")

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
    live_status = models.CharField(max_length=20, choices=LiveStatus, default=LiveStatus.NOT_CHECKED_IN)
    is_test_data = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.name} — {self.song_name}"


class ContestRound(models.Model):
    class RoundType(models.TextChoices):
        PRELIMINARY = "preliminary", "初赛"
        SEMI_FINAL = "semi_final", "复赛"

    class ScoringMode(models.TextChoices):
        AVERAGE = "average", "平均分"
        DROP_HIGH_LOW = "drop_high_low", "去最高最低后平均"

    activity = models.ForeignKey("core.Activity", on_delete=models.CASCADE, related_name="rounds")
    round_type = models.CharField(max_length=16, choices=RoundType)
    scoring_mode = models.CharField(max_length=16, choices=ScoringMode, default=ScoringMode.AVERAGE)
    name = models.CharField(max_length=100, blank=True)
    advance_count = models.IntegerField(default=0)
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


class ScoreRecord(models.Model):
    round = models.ForeignKey(ContestRound, on_delete=models.CASCADE, related_name="scores")
    singer = models.ForeignKey(SingerRegistration, on_delete=models.CASCADE, related_name="scores")
    judge = models.ForeignKey(Judge, on_delete=models.CASCADE, related_name="scores")
    score = models.DecimalField(max_digits=5, decimal_places=2)
    notes = models.CharField(max_length=200, blank=True)
    is_test_data = models.BooleanField(default=False)

    class Meta:
        unique_together = [("round", "singer", "judge")]

    def __str__(self):
        return f"{self.singer.name} — {self.judge.name}: {self.score}"


class ScoreSummary(models.Model):
    round = models.ForeignKey(ContestRound, on_delete=models.CASCADE, related_name="summaries")
    singer = models.ForeignKey(SingerRegistration, on_delete=models.CASCADE, related_name="summaries")
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

    class Meta:
        ordering = ["pk"]

    def __str__(self):
        return f"{self.singer.name}: {self.name}"
