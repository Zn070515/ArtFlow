from typing import Any

from common.authority import (
    ACCESS_GRANT_STATE,
    AuthorityQuerySetMixin,
    ENTRY_POINT_CONFIG,
    EPHEMERAL_SESSION_STATE,
    authority_authorized,
    parse_bulk_create_options,
)
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models


def _require_authority(scope: str, message: str) -> None:
    if not authority_authorized(scope):
        raise ValidationError(message)


def _reject_conflict_upsert(args, kwargs, model_name: str) -> None:
    if parse_bulk_create_options(args, kwargs).update_conflicts:
        raise ValidationError(
            f"{model_name} does not support bulk_create(update_conflicts=True); "
            "use the audited authority service or ordinary bulk_create()."
        )


class EntryPointQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    mutable_fields = {"is_active"}

    def update(self, **kwargs):
        fields = set(kwargs)
        if fields - self.mutable_fields:
            raise ValidationError("入口身份配置创建后不可直接修改。")
        _require_authority(ENTRY_POINT_CONFIG, "入口状态只能通过入口服务变更。")
        return super().update(**kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        _require_authority(ENTRY_POINT_CONFIG, "入口只能通过入口服务创建。")
        objs = list(objs)
        for obj in objs:
            obj.full_clean()
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        fields = set(fields)
        if fields - self.mutable_fields:
            raise ValidationError("入口身份配置创建后不可直接修改。")
        _require_authority(ENTRY_POINT_CONFIG, "入口状态只能通过入口服务变更。")
        return super().bulk_update(objs, list(fields), *args, **kwargs)

    def delete(self):
        raise ValidationError("入口删除需要显式生命周期服务。")


class AccessGrantQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    lifecycle_fields = {"redeemed_at", "revoked_at"}

    def _ensure_update_fields(self, fields):
        fields = set(fields)
        if fields - self.lifecycle_fields:
            raise ValidationError("临时访问授权创建后不可直接修改范围或身份。")
        _require_authority(ACCESS_GRANT_STATE, "临时访问授权只能通过授权服务变更。")

    def update(self, **kwargs):
        self._ensure_update_fields(kwargs)
        return super().update(**kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        _require_authority(ACCESS_GRANT_STATE, "临时访问授权只能通过授权服务变更。")
        objs = list(objs)
        for obj in objs:
            obj.full_clean()
            obj._ensure_initial_state()
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_update_fields(fields)
        return super().bulk_update(objs, list(fields), *args, **kwargs)

    def delete(self):
        raise ValidationError("临时访问授权删除需要显式生命周期服务。")


class EphemeralSessionQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    lifecycle_fields = {"last_seen_at", "revoked_at"}

    def _ensure_update_fields(self, fields):
        fields = set(fields)
        if fields - self.lifecycle_fields:
            raise ValidationError("临时访问会话创建后不可直接修改范围或身份。")
        _require_authority(EPHEMERAL_SESSION_STATE, "临时访问会话只能通过授权服务变更。")

    def update(self, **kwargs):
        self._ensure_update_fields(kwargs)
        return super().update(**kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        _reject_conflict_upsert(args, kwargs, self.model.__name__)
        _require_authority(EPHEMERAL_SESSION_STATE, "临时访问会话只能通过授权服务变更。")
        objs = list(objs)
        for obj in objs:
            obj.full_clean()
            obj._ensure_initial_state()
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_update_fields(fields)
        return super().bulk_update(objs, list(fields), *args, **kwargs)

    def delete(self):
        raise ValidationError("临时访问会话删除需要显式生命周期服务。")


class EntryPoint(models.Model):
    class Kind(models.TextChoices):
        JUDGE = "judge", "Judge"
        SCANNER = "scanner", "Scanner"
        OPERATIONAL = "operational", "Operational"

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.PROTECT, related_name="entry_points"
    )
    kind = models.CharField(max_length=16, choices=Kind.choices)
    label = models.CharField(max_length=100)
    is_active = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_entry_points",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = EntryPointQuerySet.as_manager()

    class Meta:
        base_manager_name = "objects"
        ordering = ["activity_id", "kind", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["activity", "kind", "label"],
                name="entry_access_unique_entry_point_label",
            ),
        ]

    def save(self, *args: Any, **kwargs: Any) -> None:
        if self._state.adding:
            _require_authority(ENTRY_POINT_CONFIG, "入口只能通过入口服务创建。")
        else:
            update_fields = kwargs.get("update_fields")
            fields = (
                set(update_fields)
                if update_fields is not None
                else {
                    "activity",
                    "kind",
                    "label",
                    "is_active",
                    "created_by",
                }
            )
            immutable_fields = (
                fields
                - EntryPointQuerySet.mutable_fields
                - {
                    "updated_at",
                    "created_at",
                }
            )
            if immutable_fields:
                stored = (
                    type(self)
                    ._base_manager.filter(pk=self.pk)
                    .values("activity_id", "kind", "label", "created_by_id")
                    .first()
                )
                stored_fields = {"activity": "activity_id", "created_by": "created_by_id"}
                if stored and any(
                    stored[stored_fields.get(field, field)]  # type: ignore[literal-required]
                    != getattr(self, f"{field}_id" if field in stored_fields else field)
                    for field in immutable_fields
                    if field in {"activity", "kind", "label", "created_by"}
                ):
                    raise ValidationError("入口身份配置创建后不可直接修改。")
            if fields & EntryPointQuerySet.mutable_fields:
                _require_authority(ENTRY_POINT_CONFIG, "入口状态只能通过入口服务变更。")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("入口删除需要显式生命周期服务。")


class AccessGrant(models.Model):
    entry_point = models.ForeignKey(EntryPoint, on_delete=models.PROTECT, related_name="grants")
    kind = models.CharField(max_length=16, choices=EntryPoint.Kind.choices)
    activity = models.ForeignKey(
        "core.Activity", on_delete=models.PROTECT, related_name="access_grants"
    )
    round = models.ForeignKey(
        "singer_contest.ContestRound",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="access_grants",
    )
    token_digest = models.CharField(max_length=64, unique=True, editable=False)
    expires_at = models.DateTimeField()
    redeemed_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    issued_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="issued_access_grants",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    objects = AccessGrantQuerySet.as_manager()

    class Meta:
        base_manager_name = "objects"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["expires_at", "redeemed_at", "revoked_at"])]

    def _ensure_initial_state(self):
        if self.redeemed_at is not None or self.revoked_at is not None:
            raise ValidationError("临时访问授权必须以未兑换且未撤销状态创建。")

    def clean(self):
        super().clean()
        if getattr(self, "entry_point_id", None) and getattr(self, "activity_id", None):
            entry_point = self.entry_point
            if (
                getattr(entry_point, "activity_id", None) != getattr(self, "activity_id", None)
                or entry_point.kind != self.kind
            ):
                raise ValidationError("访问授权范围与入口不一致。")
        if (
            getattr(self, "round_id", None)
            and getattr(self, "activity_id", None)
            and getattr(self.round, "activity_id", None) != getattr(self, "activity_id", None)
        ):
            raise ValidationError("访问授权轮次不属于当前活动。")

    def save(self, *args: Any, **kwargs: Any) -> None:
        if self._state.adding:
            _require_authority(ACCESS_GRANT_STATE, "临时访问授权只能通过授权服务变更。")
            self._ensure_initial_state()
        else:
            update_fields = kwargs.get("update_fields")
            fields = (
                set(update_fields)
                if update_fields is not None
                else {
                    "entry_point",
                    "kind",
                    "activity",
                    "round",
                    "token_digest",
                    "expires_at",
                    "redeemed_at",
                    "revoked_at",
                    "issued_by",
                }
            )
            immutable_fields = fields - AccessGrantQuerySet.lifecycle_fields
            if immutable_fields:
                stored = (
                    type(self)
                    ._base_manager.filter(pk=self.pk)
                    .values(
                        "entry_point_id",
                        "kind",
                        "activity_id",
                        "round_id",
                        "token_digest",
                        "expires_at",
                        "issued_by_id",
                    )
                    .first()
                )
                stored_fields = {
                    "entry_point": "entry_point_id",
                    "activity": "activity_id",
                    "round": "round_id",
                    "issued_by": "issued_by_id",
                }
                relation_fields = set(stored_fields)
                if stored and any(
                    stored[stored_fields.get(field, field)]  # type: ignore[literal-required]
                    != getattr(self, f"{field}_id" if field in relation_fields else field)
                    for field in immutable_fields
                    if field in relation_fields | {"kind", "token_digest", "expires_at"}
                ):
                    raise ValidationError("临时访问授权创建后不可直接修改范围或身份。")
            if fields & AccessGrantQuerySet.lifecycle_fields:
                _require_authority(ACCESS_GRANT_STATE, "临时访问授权只能通过授权服务变更。")
        self.full_clean()
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("临时访问授权删除需要显式生命周期服务。")


class EphemeralSession(models.Model):
    grant = models.OneToOneField(AccessGrant, on_delete=models.PROTECT, related_name="session")
    kind = models.CharField(max_length=16, choices=EntryPoint.Kind.choices)
    activity = models.ForeignKey(
        "core.Activity", on_delete=models.PROTECT, related_name="ephemeral_sessions"
    )
    round = models.ForeignKey(
        "singer_contest.ContestRound",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="ephemeral_sessions",
    )
    token_digest = models.CharField(max_length=64, unique=True, editable=False)
    expires_at = models.DateTimeField()
    last_seen_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = EphemeralSessionQuerySet.as_manager()

    class Meta:
        base_manager_name = "objects"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["expires_at", "revoked_at"])]

    def _ensure_initial_state(self):
        if self.last_seen_at is not None or self.revoked_at is not None:
            raise ValidationError("临时访问会话必须以未使用且未撤销状态创建。")

    def clean(self):
        super().clean()
        if getattr(self, "grant_id", None):
            grant = self.grant
            if (
                grant.kind != self.kind
                or getattr(grant, "activity_id", None) != getattr(self, "activity_id", None)
                or getattr(grant, "round_id", None) != getattr(self, "round_id", None)
            ):
                raise ValidationError("临时会话范围与授权不一致。")
            if self.expires_at and grant.expires_at and self.expires_at > grant.expires_at:
                raise ValidationError("临时会话不能超过授权有效期。")

    def save(self, *args: Any, **kwargs: Any) -> None:
        if self._state.adding:
            _require_authority(EPHEMERAL_SESSION_STATE, "临时访问会话只能通过授权服务变更。")
            self._ensure_initial_state()
        else:
            update_fields = kwargs.get("update_fields")
            fields = (
                set(update_fields)
                if update_fields is not None
                else {
                    "grant",
                    "kind",
                    "activity",
                    "round",
                    "token_digest",
                    "expires_at",
                    "last_seen_at",
                    "revoked_at",
                }
            )
            if fields - EphemeralSessionQuerySet.lifecycle_fields:
                raise ValidationError("临时访问会话创建后不可直接修改范围或身份。")
            if fields & EphemeralSessionQuerySet.lifecycle_fields:
                _require_authority(EPHEMERAL_SESSION_STATE, "临时访问会话只能通过授权服务变更。")
        self.full_clean()
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("临时访问会话删除需要显式生命周期服务。")
