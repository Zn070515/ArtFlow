from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import F, Q


def _ensure_vote_session_mutable(vote_session_id: int | None) -> None:
    if (
        vote_session_id
        and VoteSession._base_manager.filter(pk=vote_session_id, is_locked=True).exists()
    ):
        raise ValidationError("已锁定投票的原始记录不可直接写入。")


class VoteSession(models.Model):
    class Purpose(models.TextChoices):
        SELECTION = "selection", "晋级/选择"
        POPULARITY = "popularity", "人气奖"
        REPECHAGE = "repechage", "复活"

    class SelectionType(models.TextChoices):
        SINGLE = "single", "单选"
        MULTI = "multi", "多选"

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="vote_sessions"
    )
    name = models.CharField(max_length=100)
    passcode = models.CharField(max_length=20)
    start_time = models.DateTimeField()
    end_time = models.DateTimeField()
    is_open = models.BooleanField(default=False)
    is_locked = models.BooleanField(default=False)
    is_test_data = models.BooleanField(default=False)
    selection_type = models.CharField(
        max_length=8, choices=SelectionType, default=SelectionType.SINGLE
    )
    max_selections = models.IntegerField(default=1)
    purpose = models.CharField(max_length=16, choices=Purpose, default=Purpose.SELECTION)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=~Q(is_locked=True, is_open=True),
                name="vote_locked_must_be_closed",
            ),
            models.CheckConstraint(
                condition=Q(max_selections__gte=1),
                name="vote_max_selections_positive",
            ),
            models.CheckConstraint(
                condition=Q(end_time__gt=F("start_time")),
                name="vote_end_after_start",
            ),
        ]

    def __str__(self):
        return self.name


class VoteBallotQuerySet(models.QuerySet):
    def _ensure_mutable(self):
        if self.filter(vote_session__is_locked=True).exists():
            raise ValidationError("已锁定投票的原始记录不可直接修改。")

    def update(self, **kwargs):
        self._ensure_mutable()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        objs = list(objs)
        for obj in objs:
            _ensure_vote_session_mutable(obj.vote_session_id)
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        for obj in objs:
            _ensure_vote_session_mutable(obj.vote_session_id)
        return super().bulk_update(objs, fields, *args, **kwargs)


VoteBallotManager = models.Manager.from_queryset(VoteBallotQuerySet)


class VoteBallot(models.Model):
    vote_session = models.ForeignKey(VoteSession, on_delete=models.CASCADE, related_name="ballots")
    browser_session_key = models.CharField(max_length=64)
    ip_address = models.GenericIPAddressField()
    is_test_data = models.BooleanField(default=False)
    submitted_at = models.DateTimeField(auto_now_add=True)

    objects = VoteBallotManager()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["vote_session", "browser_session_key"],
                name="voting_one_ballot_per_browser_session",
            )
        ]

    def save(self, *args, **kwargs):
        _ensure_vote_session_mutable(self.vote_session_id)
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        _ensure_vote_session_mutable(self.vote_session_id)
        return super().delete(*args, **kwargs)


class VoteOption(models.Model):
    vote_session = models.ForeignKey(VoteSession, on_delete=models.CASCADE, related_name="options")
    singer = models.ForeignKey(
        "singer_contest.SingerRegistration", on_delete=models.CASCADE, related_name="vote_options"
    )
    sort_order = models.IntegerField(default=0)
    is_test_data = models.BooleanField(default=False)

    class Meta:
        unique_together = [("vote_session", "singer")]
        ordering = ["sort_order", "pk"]

    def clean(self):
        if self.vote_session_id and self.singer_id:
            if self.singer.activity_id != self.vote_session.activity_id:
                raise ValidationError("Vote option singer must belong to the vote activity.")

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.vote_session.name} — {self.singer.name}"


class VoteRecordQuerySet(models.QuerySet):
    def _ensure_mutable(self):
        if self.filter(vote_session__is_locked=True).exists():
            raise ValidationError("已锁定投票的原始记录不可直接修改。")

    def update(self, **kwargs):
        self._ensure_mutable()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        objs = list(objs)
        for obj in objs:
            obj.clean()
        if any(
            VoteSession._base_manager.filter(pk=obj.vote_session_id, is_locked=True).exists()
            for obj in objs
        ):
            raise ValidationError("已锁定投票的原始记录不可直接写入。")
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        objs = list(objs)
        for obj in objs:
            obj.clean()
            _ensure_vote_session_mutable(obj.vote_session_id)
        return super().bulk_update(objs, fields, *args, **kwargs)


VoteRecordManager = models.Manager.from_queryset(VoteRecordQuerySet)


class VoteRecord(models.Model):
    ballot = models.ForeignKey(
        VoteBallot,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="choices",
    )
    vote_session = models.ForeignKey(VoteSession, on_delete=models.CASCADE, related_name="records")
    vote_option = models.ForeignKey(VoteOption, on_delete=models.CASCADE, related_name="records")
    browser_session_key = models.CharField(max_length=64)
    ip_address = models.GenericIPAddressField()
    is_test_data = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = VoteRecordManager()

    class Meta:
        unique_together = [("vote_session", "browser_session_key", "vote_option")]
        constraints = [
            models.UniqueConstraint(
                fields=["ballot", "vote_option"],
                condition=models.Q(ballot__isnull=False),
                name="voting_one_choice_per_ballot_option",
            )
        ]

    def clean(self):
        ballot = self.ballot if self.ballot_id else None
        option = self.vote_option if self.vote_option_id else None
        if ballot and ballot.vote_session_id != self.vote_session_id:
            raise ValidationError("Vote record ballot must belong to the vote session.")
        if option and option.vote_session_id != self.vote_session_id:
            raise ValidationError("Vote record option must belong to the vote session.")

    def save(self, *args, **kwargs):
        self.clean()
        _ensure_vote_session_mutable(self.vote_session_id)
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        _ensure_vote_session_mutable(self.vote_session_id)
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.browser_session_key} → {self.vote_option.singer.name}"
