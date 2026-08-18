from django.conf import settings
from django.db import models


class IncidentRecord(models.Model):
    class EventType(models.TextChoices):
        SCORE_DISPUTE = "score_dispute", "分数争议"
        VOTE_ANOMALY = "vote_anomaly", "投票异常"
        WITHDRAWAL = "withdrawal", "临时弃赛"
        EQUIPMENT_ISSUE = "equipment_issue", "设备问题"
        INFO_ERROR = "info_error", "信息填写错误"
        OTHER = "other", "其他"

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="incidents"
    )
    occurred_at = models.DateTimeField()
    event_type = models.CharField(max_length=20, choices=EventType, default=EventType.OTHER)
    singer = models.ForeignKey(
        "singer_contest.SingerRegistration",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="incidents",
    )
    program = models.ForeignKey(
        "farewell_show.Program",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="incidents",
    )
    handled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="handled_incidents",
    )
    resolution = models.TextField(blank=True)
    remark = models.TextField(blank=True)
    is_test = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-occurred_at"]

    def __str__(self):
        return f"{self.get_event_type_display()} — {self.occurred_at:%Y-%m-%d %H:%M}"
