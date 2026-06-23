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
