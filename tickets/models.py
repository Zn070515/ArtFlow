from __future__ import annotations

from typing import TYPE_CHECKING, Any

from common.authority import (
    TEST_DATA_CLEANUP,
    TICKET_SESSION_STATE,
    TICKET_STATE,
    AuthorityQuerySetMixin,
    authority_authorized,
    parse_bulk_create_options,
)
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q

if TYPE_CHECKING:
    from voting.models import VoteBallot


TICKET_DIGEST_LENGTH = 64


def _stored_values(instance: models.Model, fields: tuple[str, ...]) -> dict[str, Any] | None:
    if instance._state.adding or not instance.pk:
        return None
    return type(instance)._base_manager.filter(pk=instance.pk).values(*fields).first()


def _changed_fields(
    instance: models.Model,
    stored: dict[str, Any] | None,
    fields: set[str],
    relation_fields: set[str],
) -> set[str]:
    if stored is None:
        return set(fields)
    changed = set()
    for field in fields:
        stored_name = f"{field}_id" if field in relation_fields else field
        if stored[stored_name] != getattr(instance, stored_name):
            changed.add(field)
    return changed


def _require_authority(scope: str, message: str) -> None:
    if not authority_authorized(scope):
        raise ValidationError(message)


class TicketQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    protected_fields = frozenset(
        {
            "activity",
            "activity_id",
            "batch_reference",
            "serial_number",
            "secret_digest",
            "state",
            "issued_at",
            "issued_by",
            "issued_by_id",
            "checked_in_at",
            "checked_in_by",
            "checked_in_by_id",
            "revoked_at",
            "revoked_by",
            "revoked_by_id",
            "voided_at",
            "voided_by",
            "voided_by_id",
            "is_test_data",
        }
    )

    def _ensure_write_authorized(self, fields: set[str]) -> None:
        if self.protected_fields.intersection(fields):
            _require_authority(TICKET_STATE, "票据只能通过票据服务变更。")

    def update(self, **kwargs: Any) -> int:
        self._ensure_write_authorized(set(kwargs))
        return super().update(**kwargs)

    def bulk_update(self, objs: Any, fields: Any, *args: Any, **kwargs: Any) -> int:
        fields = list(fields)
        self._ensure_write_authorized(set(fields))
        return super().bulk_update(objs, fields, *args, **kwargs)

    def bulk_create(self, objs: Any, *args: Any, **kwargs: Any) -> Any:
        objs = list(objs)
        options = parse_bulk_create_options(args, kwargs)
        if options.update_conflicts:
            raise ValidationError("票据不支持 bulk_create 冲突更新；请使用票据生命周期服务。")
        self._ensure_write_authorized(
            {field for obj in objs for field in obj.__dict__ if not field.startswith("_")}
        )
        for ticket in objs:
            ticket.full_clean()
        return super().bulk_create(objs, *args, **kwargs)

    def delete(self) -> Any:
        for ticket in self:
            getattr(ticket, "_ensure_deletion_authorized")()
        return super().delete()


TicketManager = models.Manager.from_queryset(TicketQuerySet)


class Ticket(models.Model):
    class State(models.TextChoices):
        CREATED = "created", "已创建"
        ISSUED = "issued", "已签发"
        CHECKED_IN = "checked_in", "已检票"
        VOID = "void", "已作废"
        REVOKED = "revoked", "已撤销"

    activity = models.ForeignKey("core.Activity", on_delete=models.PROTECT, related_name="tickets")
    batch_reference = models.CharField(max_length=100, null=True, blank=True)
    serial_number = models.CharField(max_length=100, null=True, blank=True)
    secret_digest = models.CharField(
        max_length=TICKET_DIGEST_LENGTH,
        unique=True,
        null=True,
        blank=True,
        editable=False,
    )
    state = models.CharField(max_length=16, choices=State.choices, default=State.CREATED)
    issued_at = models.DateTimeField(null=True, blank=True)
    issued_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="issued_tickets",
    )
    checked_in_at = models.DateTimeField(null=True, blank=True)
    checked_in_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="checked_in_tickets",
    )
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="revoked_tickets",
    )
    voided_at = models.DateTimeField(null=True, blank=True)
    voided_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="voided_tickets",
    )
    is_test_data = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = TicketManager()

    if TYPE_CHECKING:
        ballots: models.Manager[VoteBallot]

    class Meta:
        base_manager_name = "objects"
        ordering = ["activity_id", "batch_reference", "serial_number", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["activity", "batch_reference", "serial_number"],
                condition=Q(batch_reference__isnull=False, serial_number__isnull=False),
                name="tickets_unique_activity_inventory",
            ),
        ]
        indexes = [models.Index(fields=["activity", "state"], name="tickets_activity_state_idx")]

    def __str__(self) -> str:
        return f"Ticket:{self.pk} ({self.get_state_display()})"

    def clean(self) -> None:
        super().clean()
        if self.state == self.State.CREATED and self.secret_digest is not None:
            raise ValidationError("已创建票据不能携带可兑换密钥摘要。")
        if self.state != self.State.CREATED and not self.secret_digest:
            raise ValidationError("已签发票据必须携带密钥摘要。")
        if self.secret_digest and len(self.secret_digest) != TICKET_DIGEST_LENGTH:
            raise ValidationError("票据密钥摘要格式无效。")

    def _ensure_initial_state_authorized(self) -> None:
        _require_authority(TICKET_STATE, "票据只能通过票据服务创建。")

    def _ensure_deletion_authorized(self) -> None:
        if not authority_authorized(TEST_DATA_CLEANUP):
            raise ValidationError("票据删除需要显式测试数据清理权限。")
        if not self.is_test_data or not self.activity.is_test_mode:
            raise ValidationError("正式票据不可删除。")
        if hasattr(self, "ballots") and self.ballots.exists():
            raise ValidationError("已有投票事实的票据不可删除。")

    def save(self, *args: Any, **kwargs: Any) -> None:
        if self._state.adding:
            self._ensure_initial_state_authorized()
        else:
            update_fields = kwargs.get("update_fields")
            fields = (
                set(update_fields)
                if update_fields is not None
                else set(TicketQuerySet.protected_fields)
            )
            stored = _stored_values(
                self,
                (
                    "activity_id",
                    "batch_reference",
                    "serial_number",
                    "secret_digest",
                    "state",
                    "issued_at",
                    "issued_by_id",
                    "checked_in_at",
                    "checked_in_by_id",
                    "revoked_at",
                    "revoked_by_id",
                    "voided_at",
                    "voided_by_id",
                    "is_test_data",
                ),
            )
            changed = _changed_fields(
                self,
                stored,
                fields & TicketQuerySet.protected_fields,
                {"activity", "issued_by", "checked_in_by", "revoked_by", "voided_by"},
            )
            if changed:
                _require_authority(TICKET_STATE, "票据只能通过票据服务变更。")
        self.full_clean()
        super().save(*args, **kwargs)

    def delete(self, *args: Any, **kwargs: Any) -> Any:
        self._ensure_deletion_authorized()
        return super().delete(*args, **kwargs)


class TicketAccessSessionQuerySet(AuthorityQuerySetMixin, models.QuerySet):
    protected_fields = frozenset(
        {
            "ticket",
            "ticket_id",
            "token_digest",
            "expires_at",
            "last_seen_at",
            "revoked_at",
            "is_test_data",
        }
    )

    def _ensure_write_authorized(self, fields: set[str]) -> None:
        if self.protected_fields.intersection(fields):
            _require_authority(TICKET_SESSION_STATE, "票据会话只能通过会话服务变更。")

    def update(self, **kwargs: Any) -> int:
        self._ensure_write_authorized(set(kwargs))
        return super().update(**kwargs)

    def bulk_update(self, objs: Any, fields: Any, *args: Any, **kwargs: Any) -> int:
        fields = list(fields)
        self._ensure_write_authorized(set(fields))
        return super().bulk_update(objs, fields, *args, **kwargs)

    def bulk_create(self, objs: Any, *args: Any, **kwargs: Any) -> Any:
        objs = list(objs)
        options = parse_bulk_create_options(args, kwargs)
        if options.update_conflicts:
            raise ValidationError("票据会话不支持 bulk_create 冲突更新。")
        self._ensure_write_authorized(
            {field for obj in objs for field in obj.__dict__ if not field.startswith("_")}
        )
        for session in objs:
            session.full_clean()
        return super().bulk_create(objs, *args, **kwargs)

    def delete(self) -> Any:
        raise ValidationError("票据会话删除需要显式过期清理服务。")


class TicketAccessSession(models.Model):
    ticket = models.ForeignKey(Ticket, on_delete=models.PROTECT, related_name="access_sessions")
    token_digest = models.CharField(max_length=64, unique=True, editable=False)
    expires_at = models.DateTimeField()
    last_seen_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    is_test_data = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = models.Manager.from_queryset(TicketAccessSessionQuerySet)()

    class Meta:
        base_manager_name = "objects"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["expires_at", "revoked_at"], name="tickets_session_expiry_idx")
        ]

    def __str__(self) -> str:
        return f"TicketAccessSession:{self.pk}"

    def clean(self) -> None:
        super().clean()
        if len(self.token_digest) != TICKET_DIGEST_LENGTH:
            raise ValidationError("票据会话摘要格式无效。")
        if self.ticket_id and self.ticket.is_test_data != self.is_test_data:
            raise ValidationError("票据会话测试标记必须与票据一致。")

    def save(self, *args: Any, **kwargs: Any) -> None:
        if self._state.adding:
            _require_authority(TICKET_SESSION_STATE, "票据会话只能通过会话服务创建。")
        else:
            update_fields = kwargs.get("update_fields")
            fields = (
                set(update_fields)
                if update_fields is not None
                else set(TicketAccessSessionQuerySet.protected_fields)
            )
            stored = _stored_values(
                self,
                (
                    "ticket_id",
                    "token_digest",
                    "expires_at",
                    "last_seen_at",
                    "revoked_at",
                    "is_test_data",
                ),
            )
            changed = _changed_fields(
                self,
                stored,
                fields & TicketAccessSessionQuerySet.protected_fields,
                {"ticket"},
            )
            if changed:
                _require_authority(TICKET_SESSION_STATE, "票据会话只能通过会话服务变更。")
        self.full_clean()
        super().save(*args, **kwargs)

    def delete(self, *args: Any, **kwargs: Any) -> Any:
        raise ValidationError("票据会话删除需要显式过期清理服务。")
