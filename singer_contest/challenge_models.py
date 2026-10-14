"""Persistent authority records for the live challenge stage.

The challenge stage is deliberately separate from ``DuelDecision``.  A duel decision
is an input to a frozen ruleset; these rows are the chronological, auditable facts of a
real event and are therefore protected by their own write authority.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from common.authority import (
    LIVE_CHALLENGE_STATE,
    AuthorityQuerySetMixin,
    authority_authorized,
    parse_bulk_create_options,
)
from common.lifecycle import runtime_is_test
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import F, Q

from .models import ContestRound, SingerRegistration


class ChallengeAuthorityQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    def _ensure_authority(self) -> None:
        if not authority_authorized(LIVE_CHALLENGE_STATE):
            raise ValidationError(f"{self.model.__name__} 只能通过踢馆 authority service 修改。")

    def update(self, **kwargs):
        self._ensure_authority()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_authority()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        self._ensure_authority()
        options = parse_bulk_create_options(args, kwargs)
        if options.update_conflicts:
            raise ValidationError("踢馆事实不允许使用 bulk upsert。")
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


ChallengeAuthorityManager = models.Manager.from_queryset(ChallengeAuthorityQuerySet)


class ChallengeSession(models.Model):
    class State(models.TextChoices):
        ACTIVE = "active", "进行中"
        HOLD = "hold", "已暂停"
        READY_TO_CONFIRM = "ready_to_confirm", "待确认最终十强"
        CONFIRMED = "confirmed", "已确认最终十强"
        REVOKED = "revoked", "已撤销"

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.PROTECT, related_name="challenge_sessions"
    )
    source_round = models.ForeignKey(
        ContestRound, on_delete=models.PROTECT, related_name="challenge_sessions"
    )
    ruleset_version = models.ForeignKey(
        "ruleset.RulesetVersion", on_delete=models.PROTECT, related_name="challenge_sessions"
    )
    state = models.CharField(max_length=24, choices=State.choices, default=State.ACTIVE)
    source_score_version = models.PositiveIntegerField()
    source_roster_fingerprint = models.CharField(max_length=64)
    ruleset_hash = models.CharField(max_length=64)
    input_fingerprint = models.CharField(max_length=64)
    first_round_weight = models.DecimalField(max_digits=5, decimal_places=4, default="0.5000")
    challenge_round_weight = models.DecimalField(max_digits=5, decimal_places=4, default="0.5000")
    revision = models.PositiveIntegerField(default=1)
    current_turn_number = models.PositiveIntegerField(default=1)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_challenge_sessions",
    )
    confirmed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="confirmed_challenge_sessions",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    confirmed_at = models.DateTimeField(null=True, blank=True)
    is_test_data = models.BooleanField(default=False)

    objects = ChallengeAuthorityManager()

    if TYPE_CHECKING:
        activity_id: int
        source_round_id: int
        ruleset_version_id: int
        created_by_id: int | None
        confirmed_by_id: int | None
        turns: models.Manager["ChallengeTurn"]
        seats: models.Manager["ChallengeSeat"]
        matches: models.Manager["ChallengeMatch"]

    class Meta:
        base_manager_name = "objects"
        constraints = [
            models.UniqueConstraint(
                fields=["activity", "source_round", "input_fingerprint"],
                name="challenge_session_unique_input",
            ),
            models.CheckConstraint(
                condition=Q(revision__gte=1), name="challenge_revision_positive"
            ),
            models.CheckConstraint(
                condition=Q(current_turn_number__gte=1), name="challenge_current_turn_positive"
            ),
        ]
        indexes = [
            models.Index(fields=["activity", "state"], name="challenge_session_state_idx"),
        ]

    def clean(self):
        if self.activity_id and self.source_round_id:
            if self.source_round.activity_id != self.activity_id:
                raise ValidationError("踢馆会话来源轮次必须属于同一活动。")
        if self.ruleset_version_id and self.ruleset_version.ruleset.activity_id != self.activity_id:
            raise ValidationError("踢馆会话赛制版本必须属于同一活动。")
        if self.first_round_weight + self.challenge_round_weight != 1:
            raise ValidationError("第一轮与踢馆成绩权重必须合计 100%。")
        if self.first_round_weight <= 0 or self.challenge_round_weight <= 0:
            raise ValidationError("第一轮与踢馆成绩权重必须大于 0。")
        if self.state == self.State.CONFIRMED and (
            not self.confirmed_by_id or not self.confirmed_at
        ):
            raise ValidationError("已确认踢馆会话必须保留确认人和确认时间。")
        if self.state != self.State.CONFIRMED and (self.confirmed_by_id or self.confirmed_at):
            raise ValidationError("未确认踢馆会话不能带有最终确认痕迹。")
        if self.is_test_data != runtime_is_test(self.activity):
            raise ValidationError("踢馆会话的测试标记必须与活动生命周期一致。")

    def save(self, *args, **kwargs):
        if not authority_authorized(LIVE_CHALLENGE_STATE):
            raise ValidationError("踢馆会话只能通过正式 authority service 写入。")
        self.clean()
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not authority_authorized(LIVE_CHALLENGE_STATE):
            raise ValidationError("踢馆会话删除需要踢馆 authority service。")
        return super().delete(*args, **kwargs)


class ChallengeSeat(models.Model):
    session = models.ForeignKey(ChallengeSession, on_delete=models.PROTECT, related_name="seats")
    position = models.PositiveIntegerField(help_text="初始十佳席位编号。")
    initial_holder = models.ForeignKey(
        SingerRegistration, on_delete=models.PROTECT, related_name="initial_challenge_seats"
    )
    current_holder = models.ForeignKey(
        SingerRegistration, on_delete=models.PROTECT, related_name="current_challenge_seats"
    )
    third_round_position = models.PositiveIntegerField()
    is_challenged = models.BooleanField(default=False)
    challenged_at = models.DateTimeField(null=True, blank=True)
    revision = models.PositiveIntegerField(default=1)
    is_test_data = models.BooleanField(default=False)

    objects = ChallengeAuthorityManager()

    if TYPE_CHECKING:
        session_id: int
        initial_holder_id: int
        current_holder_id: int

    class Meta:
        base_manager_name = "objects"
        ordering = ["third_round_position", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["session", "position"], name="challenge_seat_unique_position"
            ),
            models.UniqueConstraint(
                fields=["session", "third_round_position"],
                name="challenge_seat_unique_third_position",
            ),
            models.UniqueConstraint(
                fields=["session", "current_holder"], name="challenge_seat_unique_holder"
            ),
            models.CheckConstraint(
                condition=Q(position__gte=1) & Q(position__lte=10),
                name="challenge_seat_position_range",
            ),
        ]

    def clean(self):
        if self.session_id:
            session = self.session
            if self.initial_holder.activity_id != session.activity_id:
                raise ValidationError("席位初始持有人必须属于会话活动。")
            if self.current_holder.activity_id != session.activity_id:
                raise ValidationError("席位当前持有人必须属于会话活动。")
            if self.is_challenged and self.challenged_at is None:
                raise ValidationError("已挑战席位必须记录挑战时间。")
            if not self.is_challenged and self.challenged_at is not None:
                raise ValidationError("未挑战席位不能记录挑战时间。")
            if self.is_test_data != session.is_test_data:
                raise ValidationError("席位测试标记必须与会话一致。")

    def save(self, *args, **kwargs):
        if not authority_authorized(LIVE_CHALLENGE_STATE):
            raise ValidationError("踢馆席位只能通过正式 authority service 写入。")
        self.clean()
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not authority_authorized(LIVE_CHALLENGE_STATE):
            raise ValidationError("踢馆席位删除需要踢馆 authority service。")
        return super().delete(*args, **kwargs)


class ChallengeTurn(models.Model):
    class State(models.TextChoices):
        PENDING = "pending", "待开始"
        SELECTING = "selecting", "选择对手"
        TARGET_SELECTED = "target_selected", "已选择对手"
        MATCHED = "matched", "已确认配对"
        WAIVED = "waived", "已放弃"
        CONFIRMED = "confirmed", "本场已确认"

    session = models.ForeignKey(ChallengeSession, on_delete=models.PROTECT, related_name="turns")
    sequence = models.PositiveIntegerField()
    challenger = models.ForeignKey(
        SingerRegistration, on_delete=models.PROTECT, related_name="challenge_turns"
    )
    state = models.CharField(max_length=24, choices=State.choices, default=State.PENDING)
    target_seat = models.ForeignKey(
        ChallengeSeat,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="targeted_turns",
    )
    waive_reason = models.CharField(max_length=240, blank=True)
    revision = models.PositiveIntegerField(default=1)
    acted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="acted_challenge_turns",
    )
    acted_at = models.DateTimeField(null=True, blank=True)
    is_test_data = models.BooleanField(default=False)

    objects = ChallengeAuthorityManager()

    if TYPE_CHECKING:
        session_id: int
        challenger_id: int
        target_seat_id: int | None
        match: "ChallengeMatch"

    class Meta:
        base_manager_name = "objects"
        ordering = ["sequence", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["session", "sequence"], name="challenge_turn_unique_sequence"
            ),
            models.UniqueConstraint(
                fields=["session", "challenger"], name="challenge_turn_unique_challenger"
            ),
            models.CheckConstraint(
                condition=Q(sequence__gte=1) & Q(sequence__lte=5),
                name="challenge_turn_sequence_range",
            ),
        ]

    def clean(self):
        if self.session_id:
            if self.challenger.activity_id != self.session.activity_id:
                raise ValidationError("挑战者必须属于会话活动。")
            target_seat = self.target_seat
            if self.target_seat_id and (
                target_seat is None or target_seat.session_id != self.session_id
            ):
                raise ValidationError("挑战目标席位必须属于当前会话。")
            if self.state == self.State.WAIVED and self.target_seat_id:
                raise ValidationError("放弃挑战不能保留目标席位。")
            if self.state == self.State.WAIVED and not self.waive_reason.strip():
                raise ValidationError("放弃挑战必须填写原因。")
            if self.state != self.State.WAIVED and self.waive_reason:
                raise ValidationError("未放弃的挑战机会不能保留放弃原因。")
            if self.is_test_data != self.session.is_test_data:
                raise ValidationError("挑战机会测试标记必须与会话一致。")

    def save(self, *args, **kwargs):
        if not authority_authorized(LIVE_CHALLENGE_STATE):
            raise ValidationError("挑战机会只能通过正式 authority service 写入。")
        self.clean()
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not authority_authorized(LIVE_CHALLENGE_STATE):
            raise ValidationError("挑战机会删除需要踢馆 authority service。")
        return super().delete(*args, **kwargs)


class ChallengeMatch(models.Model):
    class Status(models.TextChoices):
        READY_FOR_SCORING = "ready_for_scoring", "待评分"
        SCORING = "scoring", "评分中"
        AWAITING_RESULT = "awaiting_result", "待确认胜负"
        CONFIRMED = "confirmed", "已确认"
        REVOKED = "revoked", "已撤销"

    session = models.ForeignKey(ChallengeSession, on_delete=models.PROTECT, related_name="matches")
    turn = models.OneToOneField(ChallengeTurn, on_delete=models.PROTECT, related_name="match")
    seat = models.ForeignKey(ChallengeSeat, on_delete=models.PROTECT, related_name="matches")
    challenger = models.ForeignKey(
        SingerRegistration, on_delete=models.PROTECT, related_name="challenge_matches_as_challenger"
    )
    defender = models.ForeignKey(
        SingerRegistration, on_delete=models.PROTECT, related_name="challenge_matches_as_defender"
    )
    status = models.CharField(
        max_length=24, choices=Status.choices, default=Status.READY_FOR_SCORING
    )
    winner = models.ForeignKey(
        SingerRegistration,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="won_challenge_matches",
    )
    score_round = models.ForeignKey(
        ContestRound,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="challenge_matches",
    )
    result_fingerprint = models.CharField(max_length=64, blank=True)
    challenger_first_score = models.DecimalField(
        max_digits=6, decimal_places=2, null=True, blank=True
    )
    defender_first_score = models.DecimalField(
        max_digits=6, decimal_places=2, null=True, blank=True
    )
    challenger_second_score = models.DecimalField(
        max_digits=6, decimal_places=2, null=True, blank=True
    )
    defender_second_score = models.DecimalField(
        max_digits=6, decimal_places=2, null=True, blank=True
    )
    challenger_combined_score = models.DecimalField(
        max_digits=6, decimal_places=2, null=True, blank=True
    )
    defender_combined_score = models.DecimalField(
        max_digits=6, decimal_places=2, null=True, blank=True
    )
    revision = models.PositiveIntegerField(default=1)
    confirmed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="confirmed_challenge_matches",
    )
    confirmed_at = models.DateTimeField(null=True, blank=True)
    is_test_data = models.BooleanField(default=False)

    objects = ChallengeAuthorityManager()

    if TYPE_CHECKING:
        session_id: int
        turn_id: int
        seat_id: int
        challenger_id: int
        defender_id: int
        winner_id: int | None
        score_round_id: int | None
        confirmed_by_id: int | None

    class Meta:
        base_manager_name = "objects"
        constraints = [
            models.UniqueConstraint(fields=["session", "seat"], name="challenge_match_unique_seat"),
            models.CheckConstraint(
                condition=~Q(challenger=F("defender")),
                name="challenge_match_distinct_contestants",
            ),
        ]

    def clean(self):
        if not self.session_id:
            return
        if self.turn.session_id != self.session_id or self.seat.session_id != self.session_id:
            raise ValidationError("踢馆比赛的会话关系不一致。")
        if self.challenger.activity_id != self.session.activity_id:
            raise ValidationError("挑战者必须属于会话活动。")
        if self.defender.activity_id != self.session.activity_id:
            raise ValidationError("守擂者必须属于会话活动。")
        if self.winner_id and self.winner_id not in {self.challenger_id, self.defender_id}:
            raise ValidationError("胜者必须是挑战者或守擂者。")
        if self.status == self.Status.CONFIRMED and (
            not self.winner_id or not self.confirmed_by_id or not self.confirmed_at
        ):
            raise ValidationError("已确认比赛必须保留胜者和确认痕迹。")
        if self.status != self.Status.CONFIRMED and (self.confirmed_by_id or self.confirmed_at):
            raise ValidationError("未确认比赛不能带有确认痕迹。")
        if self.is_test_data != self.session.is_test_data:
            raise ValidationError("比赛测试标记必须与会话一致。")

    def save(self, *args, **kwargs):
        if not authority_authorized(LIVE_CHALLENGE_STATE):
            raise ValidationError("踢馆比赛只能通过正式 authority service 写入。")
        self.clean()
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not authority_authorized(LIVE_CHALLENGE_STATE):
            raise ValidationError("踢馆比赛删除需要踢馆 authority service。")
        return super().delete(*args, **kwargs)


class ChallengeCommand(models.Model):
    """Idempotency ledger for every staff command in the live challenge stage."""

    session = models.ForeignKey(ChallengeSession, on_delete=models.PROTECT, related_name="commands")
    command_id = models.CharField(max_length=64, unique=True)
    operation = models.CharField(max_length=48)
    payload_hash = models.CharField(max_length=64)
    result_type = models.CharField(max_length=48, blank=True)
    result_id = models.PositiveIntegerField(null=True, blank=True)
    result_payload = models.JSONField(default=dict, blank=True)
    operator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="challenge_commands",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    objects = ChallengeAuthorityManager()

    if TYPE_CHECKING:
        session_id: int
        operator_id: int

    class Meta:
        base_manager_name = "objects"

    def save(self, *args, **kwargs):
        if not authority_authorized(LIVE_CHALLENGE_STATE):
            raise ValidationError("踢馆命令只能通过正式 authority service 写入。")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if not authority_authorized(LIVE_CHALLENGE_STATE):
            raise ValidationError("踢馆命令删除需要踢馆 authority service。")
        return super().delete(*args, **kwargs)
