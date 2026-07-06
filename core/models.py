from django.conf import settings
from django.db import models


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

    title = models.CharField(max_length=200)
    subtitle = models.CharField(max_length=400, blank=True)
    activity_type = models.CharField(max_length=20, choices=Type)
    phase = models.CharField(max_length=24, choices=Phase, default=Phase.DRAFT)
    description = models.TextField(blank=True)
    cover_image = models.ImageField(upload_to="activities/covers/", blank=True)
    is_test_mode = models.BooleanField(default=True)
    is_locked = models.BooleanField(default=False)
    locked_at = models.DateTimeField(null=True, blank=True)
    locked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name="locked_activities"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name_plural = "activities"
        ordering = ["-created_at"]

    def __str__(self):
        return self.title


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
