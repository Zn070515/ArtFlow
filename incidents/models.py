from typing import TYPE_CHECKING

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models


class IncidentRecord(models.Model):
    class EventType(models.TextChoices):
        SCORE_DISPUTE = "score_dispute", "分数争议"
        VOTE_ANOMALY = "vote_anomaly", "投票异常"
        WITHDRAWAL = "withdrawal", "临时弃赛"
        EQUIPMENT_ISSUE = "equipment_issue", "设备问题"
        INFO_ERROR = "info_error", "信息填写错误"
        OTHER = "other", "其他"

    class AuthorityState(models.TextChoices):
        """The activity authority state the incident happened under (GOAL §16).

        Unrecorded is the explicit default rather than a guess: an incident filed after
        the fact must not invent the state it occurred in.
        """

        UNRECORDED = "", "未记录"
        ACTIVE = "active", "进行中（ACTIVE）"
        HOLD = "hold", "已暂停（HOLD）"
        LOCKED = "locked", "已锁定（LOCKED）"
        UNLOCKED = "unlocked", "已解锁（UNLOCKED）"

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="incidents"
    )
    occurred_at = models.DateTimeField()
    event_type = models.CharField(max_length=20, choices=EventType, default=EventType.OTHER)
    round = models.ForeignKey(
        "singer_contest.ContestRound",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="incidents",
    )
    authority_state = models.CharField(
        max_length=16,
        choices=AuthorityState.choices,
        default=AuthorityState.UNRECORDED,
        blank=True,
    )
    needs_review = models.BooleanField(default=False)
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

    if TYPE_CHECKING:
        # Django creates the ``<fk>_id`` shadow attributes at runtime; declare them so
        # Pylance can see them (see AGENTS.md, Pylance & Pyright Type Checking).
        activity_id: int
        singer_id: int | None
        program_id: int | None
        round_id: int | None

        def get_event_type_display(self) -> str: ...

        def get_authority_state_display(self) -> str: ...

    def clean(self):
        singer = self.singer if self.singer_id else None
        program = self.program if self.program_id else None
        contest_round = self.round if self.round_id else None
        if singer and singer.activity_id != self.activity_id:
            raise ValidationError("Incident singer must belong to the incident activity.")
        if program and program.activity_id != self.activity_id:
            raise ValidationError("Incident program must belong to the incident activity.")
        if contest_round and contest_round.activity_id != self.activity_id:
            raise ValidationError("Incident round must belong to the incident activity.")

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.get_event_type_display()} — {self.occurred_at:%Y-%m-%d %H:%M}"
