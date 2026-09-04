from common.authority import TEST_DATA_CLEANUP, VOTE_SESSION_STATE, authority_authorized
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import F, Q


def _ensure_vote_session_mutable(vote_session_id: int | None) -> None:
    if (
        vote_session_id
        and VoteSession._base_manager.filter(pk=vote_session_id, is_locked=True).exists()
    ):
        raise ValidationError("已锁定投票的原始记录不可直接写入。")


def _stored_relation_id(instance, field: str) -> int | None:
    if instance._state.adding or not instance.pk:
        return None
    return (
        type(instance)
        ._base_manager.filter(pk=instance.pk)
        .values_list(f"{field}_id", flat=True)
        .first()
    )


def _relation_pk(value):
    return getattr(value, "pk", value)


def _ensure_vote_session_origins(*session_ids: int | None) -> None:
    for session_id in dict.fromkeys(session_id for session_id in session_ids if session_id):
        _ensure_vote_session_mutable(session_id)


def _session_id_for(model, pk: int | None) -> int | None:
    if not pk:
        return None
    return model._base_manager.filter(pk=pk).values_list("vote_session_id", flat=True).first()


def _vote_record_session_origins(record) -> tuple[int | None, ...]:
    stored = None
    if not record._state.adding and record.pk:
        stored = (
            type(record)
            ._base_manager.filter(pk=record.pk)
            .values("vote_session_id", "ballot_id", "vote_option_id")
            .first()
        )
    return (
        stored["vote_session_id"] if stored else None,
        _session_id_for(VoteBallot, stored["ballot_id"]) if stored else None,
        _session_id_for(VoteOption, stored["vote_option_id"]) if stored else None,
        record.vote_session_id,
        _session_id_for(VoteBallot, record.ballot_id),
        _session_id_for(VoteOption, record.vote_option_id),
    )


class VoteSessionQuerySet(models.QuerySet):
    state_fields = {"is_open", "is_locked"}
    configuration_fields = {
        "activity",
        "activity_id",
        "name",
        "passcode",
        "start_time",
        "end_time",
        "is_test_data",
        "selection_type",
        "max_selections",
        "purpose",
    }

    def _ensure_state_authorized(self, fields):
        if self.state_fields.intersection(fields) and not authority_authorized(VOTE_SESSION_STATE):
            raise ValidationError("投票状态只能通过投票服务变更。")

    def _ensure_configuration_mutable(self, fields):
        if not self.configuration_fields.intersection(fields):
            return
        if self.filter(is_locked=True).exists():
            raise ValidationError("投票锁定后，投票配置不可直接修改。")

    def update(self, **kwargs):
        self._ensure_state_authorized(kwargs)
        self._ensure_configuration_mutable(kwargs)
        return super().update(**kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        objs = list(objs)
        self._ensure_state_authorized(fields)
        if self.configuration_fields.intersection(fields):
            for obj in objs:
                stored = type(obj)._base_manager.filter(pk=obj.pk).values("is_locked").first()
                if (stored and stored["is_locked"]) or obj.is_locked:
                    raise ValidationError("投票锁定后，投票配置不可直接修改。")
        return super().bulk_update(objs, fields, *args, **kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        objs = list(objs)
        if kwargs.get("update_conflicts"):
            update_fields = set(kwargs.get("update_fields", ()))
            self._ensure_state_authorized(update_fields)
            if self.configuration_fields.intersection(update_fields):
                for vote_session in objs:
                    lookup = {
                        field: getattr(vote_session, field)
                        for field in kwargs.get("unique_fields", ())
                    }
                    if self.model._base_manager.filter(**lookup, is_locked=True).exists():
                        raise ValidationError("投票锁定后，投票配置不可直接修改。")
        for vote_session in objs:
            vote_session._ensure_initial_state_authorized()
        return super().bulk_create(objs, *args, **kwargs)

    def delete(self):
        for vote_session in self:
            vote_session._ensure_deletion_authorized()
        return super().delete()


VoteSessionManager = models.Manager.from_queryset(VoteSessionQuerySet)


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

    objects = VoteSessionManager()

    state_fields = VoteSessionQuerySet.state_fields
    _configuration_fields = VoteSessionQuerySet.configuration_fields - {"activity"}

    class Meta:
        base_manager_name = "objects"
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

    def _ensure_initial_state_authorized(self):
        if authority_authorized(VOTE_SESSION_STATE):
            return
        if self.is_open or self.is_locked:
            raise ValidationError("投票必须以关闭且未锁定的初始状态创建。")

    def _ensure_deletion_authorized(self):
        if not authority_authorized(TEST_DATA_CLEANUP):
            raise ValidationError("投票删除需要显式测试数据清理权限。")
        if not self.is_test_data or not self.activity.is_test_mode or self.is_open or self.is_locked:
            raise ValidationError("只有关闭且未锁定的测试投票可以删除。")
        from singer_contest.services import ensure_vote_not_consumed_by_confirmed_stage

        ensure_vote_not_consumed_by_confirmed_stage(self)

    def save(self, *args, **kwargs):
        if self._state.adding:
            self._ensure_initial_state_authorized()
        elif self.pk:
            update_fields = kwargs.get("update_fields")
            compared_configuration_fields = (
                self._configuration_fields
                if update_fields is None
                else self._configuration_fields.intersection(
                    set(update_fields) | ({"activity_id"} if "activity" in update_fields else set())
                )
            )
            stored = (
                type(self)
                ._base_manager.filter(pk=self.pk)
                .values(
                    "is_open",
                    "is_locked",
                    *self._configuration_fields,
                )
                .first()
            )
            if stored and not authority_authorized(VOTE_SESSION_STATE):
                if any(stored[field] != getattr(self, field) for field in self.state_fields):
                    raise ValidationError("投票状态只能通过投票服务变更。")
            if (
                stored
                and (stored["is_locked"] or self.is_locked)
                and any(
                    stored[field] != getattr(self, field) for field in compared_configuration_fields
                )
            ):
                raise ValidationError("投票锁定后，投票配置不可直接修改。")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        self._ensure_deletion_authorized()
        return super().delete(*args, **kwargs)



class VoteBallotQuerySet(models.QuerySet):
    def _ensure_mutable(self):
        if self.filter(vote_session__is_locked=True).exists():
            raise ValidationError("已锁定投票的原始记录不可直接修改。")

    def update(self, **kwargs):
        self._ensure_mutable()
        if "vote_session" in kwargs or "vote_session_id" in kwargs:
            _ensure_vote_session_origins(
                *self.values_list("vote_session_id", flat=True),
                _relation_pk(kwargs.get("vote_session", kwargs.get("vote_session_id"))),
            )
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
        objs = list(objs)
        for obj in objs:
            _ensure_vote_session_origins(
                _stored_relation_id(obj, "vote_session"), obj.vote_session_id
            )
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
        base_manager_name = "objects"
        constraints = [
            models.UniqueConstraint(
                fields=["vote_session", "browser_session_key"],
                name="voting_one_ballot_per_browser_session",
            )
        ]

    def save(self, *args, **kwargs):
        _ensure_vote_session_origins(
            _stored_relation_id(self, "vote_session"), self.vote_session_id
        )
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        _ensure_vote_session_origins(
            _stored_relation_id(self, "vote_session"), self.vote_session_id
        )
        return super().delete(*args, **kwargs)


class VoteOptionQuerySet(models.QuerySet):
    def _ensure_mutable(self):
        for session_id in self.values_list("vote_session_id", flat=True).distinct():
            _ensure_vote_session_mutable(session_id)

    def update(self, **kwargs):
        self._ensure_mutable()
        if "vote_session" in kwargs or "vote_session_id" in kwargs:
            _ensure_vote_session_mutable(
                _relation_pk(kwargs.get("vote_session", kwargs.get("vote_session_id")))
            )
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        objs = list(objs)
        for obj in objs:
            obj.clean()
            _ensure_vote_session_mutable(obj.vote_session_id)
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        objs = list(objs)
        for obj in objs:
            _ensure_vote_session_origins(
                _stored_relation_id(obj, "vote_session"), obj.vote_session_id
            )
            obj.clean()
        return super().bulk_update(objs, fields, *args, **kwargs)


VoteOptionManager = models.Manager.from_queryset(VoteOptionQuerySet)


class VoteOption(models.Model):
    vote_session = models.ForeignKey(VoteSession, on_delete=models.CASCADE, related_name="options")
    singer = models.ForeignKey(
        "singer_contest.SingerRegistration", on_delete=models.CASCADE, related_name="vote_options"
    )
    sort_order = models.IntegerField(default=0)
    is_test_data = models.BooleanField(default=False)

    objects = VoteOptionManager()

    class Meta:
        base_manager_name = "objects"
        unique_together = [("vote_session", "singer")]
        ordering = ["sort_order", "pk"]

    def clean(self):
        if self.vote_session_id and self.singer_id:
            if self.singer.activity_id != self.vote_session.activity_id:
                raise ValidationError("Vote option singer must belong to the vote activity.")

    def save(self, *args, **kwargs):
        self.clean()
        _ensure_vote_session_origins(
            _stored_relation_id(self, "vote_session"), self.vote_session_id
        )
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        _ensure_vote_session_origins(
            _stored_relation_id(self, "vote_session"), self.vote_session_id
        )
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.vote_session.name} — {self.singer.name}"


class VoteRecordQuerySet(models.QuerySet):
    def _ensure_mutable(self):
        if self.filter(vote_session__is_locked=True).exists():
            raise ValidationError("已锁定投票的原始记录不可直接修改。")

    def update(self, **kwargs):
        self._ensure_mutable()
        if "vote_session" in kwargs or "vote_session_id" in kwargs:
            _ensure_vote_session_origins(
                *self.values_list("vote_session_id", flat=True),
                _relation_pk(kwargs.get("vote_session", kwargs.get("vote_session_id"))),
            )
        if "ballot" in kwargs or "ballot_id" in kwargs:
            _ensure_vote_session_mutable(
                _session_id_for(
                    VoteBallot, _relation_pk(kwargs.get("ballot", kwargs.get("ballot_id")))
                )
            )
        if "vote_option" in kwargs or "vote_option_id" in kwargs:
            _ensure_vote_session_mutable(
                _session_id_for(
                    VoteOption,
                    _relation_pk(kwargs.get("vote_option", kwargs.get("vote_option_id"))),
                )
            )
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
            _ensure_vote_session_origins(*_vote_record_session_origins(obj))
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
        base_manager_name = "objects"
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
        _ensure_vote_session_origins(*_vote_record_session_origins(self))
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        _ensure_vote_session_origins(*_vote_record_session_origins(self))
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.browser_session_key} → {self.vote_option.singer.name}"
