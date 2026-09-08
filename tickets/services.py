from __future__ import annotations

import hashlib
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from accounts.services import require_current_admin, require_current_staff
from common.authority import TICKET_SESSION_STATE, TICKET_STATE, authority_write
from common.models import AuditLog
from core.models import Activity
from core.policies import ActivityAction
from core.services import lock_activity_for_action
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from .models import Ticket, TicketAccessSession

TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
INVALID_TICKET_MESSAGE = "票据无效。"


@dataclass(frozen=True)
class TicketRequestMeta:
    ip_address: str | None = None


@dataclass(frozen=True)
class IssuedTicket:
    ticket: Ticket
    secret: str


@dataclass(frozen=True)
class RedeemedTicketSession:
    session: TicketAccessSession
    token: str


def _token_digest(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("ascii")).hexdigest()


def _validate_raw_token(raw_token: Any) -> str:
    if not isinstance(raw_token, str) or not TOKEN_PATTERN.fullmatch(raw_token):
        raise ValidationError(INVALID_TICKET_MESSAGE)
    return raw_token


def _activity_for_ticket(ticket_id: int) -> Activity:
    activity_id = (
        Ticket._base_manager.filter(pk=ticket_id).values_list("activity_id", flat=True).first()
    )
    if activity_id is None:
        raise ValidationError(INVALID_TICKET_MESSAGE)
    return Activity.objects.get(pk=activity_id)


def _audit_ticket(
    *,
    operator: Any,
    action_type: str,
    ticket: Ticket,
    old_state: str = "",
    new_state: str = "",
    note: str = "",
    ip_address: str | None = None,
) -> AuditLog:
    return AuditLog.objects.create(
        operator=operator,
        action_type=action_type,
        target=f"Ticket:{ticket.pk}",
        old_value=f"state={old_state}" if old_state else "",
        new_value=f"state={new_state}" if new_state else "",
        note=note,
        ip_address=ip_address,
    )


def create_ticket(
    activity: Activity,
    *,
    actor: Any,
    batch_reference: str | None = None,
    serial_number: str | None = None,
) -> Ticket:
    require_current_staff(actor)
    with transaction.atomic():
        locked_activity = lock_activity_for_action(activity, ActivityAction.MANAGE_TICKETS)
        ticket = Ticket(
            activity=locked_activity,
            batch_reference=(batch_reference or "").strip() or None,
            serial_number=(serial_number or "").strip() or None,
            state=Ticket.State.CREATED,
            is_test_data=locked_activity.is_test_mode,
        )
        with authority_write(TICKET_STATE):
            ticket.save()
        return ticket


def issue_ticket(ticket: Ticket, *, actor: Any) -> IssuedTicket:
    current_actor = require_current_staff(actor)
    with transaction.atomic():
        activity = _activity_for_ticket(ticket.pk)
        locked_activity = lock_activity_for_action(activity, ActivityAction.MANAGE_TICKETS)
        locked_ticket = Ticket.objects.select_for_update().get(pk=ticket.pk)
        if locked_ticket.activity_id != locked_activity.pk:
            raise ValidationError(INVALID_TICKET_MESSAGE)
        if locked_ticket.state != Ticket.State.CREATED:
            raise ValidationError("票据已签发或不可签发。")
        raw_secret = secrets.token_urlsafe(32)
        now = timezone.now()
        old_state = locked_ticket.state
        locked_ticket.secret_digest = _token_digest(raw_secret)
        locked_ticket.state = Ticket.State.ISSUED
        locked_ticket.issued_at = now
        locked_ticket.issued_by = current_actor
        locked_ticket.is_test_data = locked_activity.is_test_mode
        with authority_write(TICKET_STATE):
            locked_ticket.save(
                update_fields=[
                    "secret_digest",
                    "state",
                    "issued_at",
                    "issued_by",
                    "is_test_data",
                    "updated_at",
                ]
            )
        _audit_ticket(
            operator=current_actor,
            action_type=AuditLog.ActionType.TICKET_ISSUE,
            ticket=locked_ticket,
            old_state=old_state,
            new_state=locked_ticket.state,
        )
        return IssuedTicket(ticket=locked_ticket, secret=raw_secret)


def issue_ticket_batch(
    activity: Activity,
    *,
    actor: Any,
    quantity: object,
    batch_reference: str | None = None,
    serial_prefix: str | None = None,
) -> list[IssuedTicket]:
    current_actor = require_current_staff(actor)
    if isinstance(quantity, bool) or not isinstance(quantity, int) or not 1 <= quantity <= 100:
        raise ValidationError("批量签发数量必须是 1 到 100 之间的整数。")

    normalized_batch = (batch_reference or "").strip() or None
    normalized_prefix = (serial_prefix or "").strip() or None
    if quantity > 1 and normalized_prefix is None:
        raise ValidationError("批量签发需要填写编号前缀。")

    serial_numbers = [
        f"{normalized_prefix}-{index:03d}" if normalized_prefix else None
        for index in range(1, quantity + 1)
    ]
    with transaction.atomic():
        locked_activity = lock_activity_for_action(activity, ActivityAction.MANAGE_TICKETS)
        if normalized_batch is not None:
            if Ticket._base_manager.filter(
                activity=locked_activity,
                batch_reference=normalized_batch,
                serial_number__in=[serial for serial in serial_numbers if serial is not None],
            ).exists():
                raise ValidationError("批次中已有相同票据编号。")

        created_tickets = []
        with authority_write(TICKET_STATE):
            for serial_number in serial_numbers:
                ticket = Ticket(
                    activity=locked_activity,
                    batch_reference=normalized_batch,
                    serial_number=serial_number,
                    state=Ticket.State.CREATED,
                    is_test_data=locked_activity.is_test_mode,
                )
                ticket.save()
                created_tickets.append(ticket)

        return [issue_ticket(ticket, actor=current_actor) for ticket in created_tickets]


def check_in_ticket(
    raw_secret: str,
    *,
    actor: Any,
    request_meta: TicketRequestMeta | None = None,
) -> Ticket:
    current_actor = require_current_staff(actor)
    raw_secret = _validate_raw_token(raw_secret)
    digest = _token_digest(raw_secret)
    with transaction.atomic():
        candidate = Ticket.objects.select_related("activity").filter(secret_digest=digest).first()
        if candidate is None:
            raise ValidationError(INVALID_TICKET_MESSAGE)
        lock_activity_for_action(candidate.activity, ActivityAction.CHECK_IN)
        locked_ticket = Ticket.objects.select_for_update().get(pk=candidate.pk)
        if locked_ticket.state == Ticket.State.CHECKED_IN:
            return locked_ticket
        if locked_ticket.state != Ticket.State.ISSUED:
            raise ValidationError(INVALID_TICKET_MESSAGE)
        old_state = locked_ticket.state
        locked_ticket.state = Ticket.State.CHECKED_IN
        locked_ticket.checked_in_at = timezone.now()
        locked_ticket.checked_in_by = current_actor
        with authority_write(TICKET_STATE):
            locked_ticket.save(
                update_fields=["state", "checked_in_at", "checked_in_by", "updated_at"]
            )
        _audit_ticket(
            operator=current_actor,
            action_type=AuditLog.ActionType.TICKET_CHECK_IN,
            ticket=locked_ticket,
            old_state=old_state,
            new_state=locked_ticket.state,
            ip_address=(request_meta.ip_address if request_meta else None),
        )
        return locked_ticket


def void_ticket(ticket: Ticket, *, actor: Any, note: str = "") -> Ticket:
    current_actor = require_current_admin(actor)
    with transaction.atomic():
        lock_activity_for_action(_activity_for_ticket(ticket.pk), ActivityAction.MANAGE_TICKETS)
        locked_ticket = Ticket.objects.select_for_update().get(pk=ticket.pk)
        if locked_ticket.state == Ticket.State.VOID:
            return locked_ticket
        if locked_ticket.state not in {Ticket.State.CREATED, Ticket.State.ISSUED}:
            raise ValidationError("已检票或已撤销票据不能作废。")
        old_state = locked_ticket.state
        locked_ticket.state = Ticket.State.VOID
        locked_ticket.voided_at = timezone.now()
        locked_ticket.voided_by = current_actor
        with authority_write(TICKET_STATE):
            locked_ticket.save(update_fields=["state", "voided_at", "voided_by", "updated_at"])
        _audit_ticket(
            operator=current_actor,
            action_type=AuditLog.ActionType.TICKET_VOID,
            ticket=locked_ticket,
            old_state=old_state,
            new_state=locked_ticket.state,
            note=note[:1000],
        )
        return locked_ticket


def revoke_ticket(ticket: Ticket, *, actor: Any, note: str = "") -> Ticket:
    current_actor = require_current_admin(actor)
    with transaction.atomic():
        lock_activity_for_action(_activity_for_ticket(ticket.pk), ActivityAction.MANAGE_TICKETS)
        locked_ticket = Ticket.objects.select_for_update().get(pk=ticket.pk)
        if locked_ticket.state == Ticket.State.REVOKED:
            return locked_ticket
        if locked_ticket.state not in {Ticket.State.ISSUED, Ticket.State.CHECKED_IN}:
            raise ValidationError("当前票据状态不能撤销。")
        old_state = locked_ticket.state
        locked_ticket.state = Ticket.State.REVOKED
        locked_ticket.revoked_at = timezone.now()
        locked_ticket.revoked_by = current_actor
        with authority_write(TICKET_STATE):
            locked_ticket.save(update_fields=["state", "revoked_at", "revoked_by", "updated_at"])
        _audit_ticket(
            operator=current_actor,
            action_type=AuditLog.ActionType.TICKET_REVOKE,
            ticket=locked_ticket,
            old_state=old_state,
            new_state=locked_ticket.state,
            note=note[:1000],
        )
        return locked_ticket


def redeem_ticket(
    raw_secret: str,
    *,
    request_meta: TicketRequestMeta | None = None,
) -> RedeemedTicketSession:
    raw_secret = _validate_raw_token(raw_secret)
    digest = _token_digest(raw_secret)
    now = timezone.now()
    with transaction.atomic():
        ticket = (
            Ticket.objects.select_for_update()
            .select_related("activity")
            .filter(secret_digest=digest)
            .first()
        )
        if ticket is None or ticket.state not in {Ticket.State.ISSUED, Ticket.State.CHECKED_IN}:
            raise ValidationError(INVALID_TICKET_MESSAGE)
        raw_token = secrets.token_urlsafe(32)
        ttl_seconds = int(getattr(settings, "TICKET_ACCESS_SESSION_TTL_SECONDS", 30 * 60))
        session = TicketAccessSession(
            ticket=ticket,
            token_digest=_token_digest(raw_token),
            expires_at=now + timedelta(seconds=ttl_seconds),
            is_test_data=ticket.is_test_data,
        )
        with authority_write(TICKET_SESSION_STATE):
            session.save()
        AuditLog.objects.create(
            operator=None,
            action_type=AuditLog.ActionType.TICKET_REDEEM,
            target=f"Ticket:{ticket.pk}",
            new_value=f"session={session.pk};expires_at={session.expires_at.isoformat()}",
            ip_address=(request_meta.ip_address if request_meta else None),
        )
        return RedeemedTicketSession(session=session, token=raw_token)


def authenticate_ticket_session(
    raw_token: str,
    *,
    activity: Activity | int,
) -> TicketAccessSession:
    raw_token = _validate_raw_token(raw_token)
    activity_id = getattr(activity, "pk", activity)
    now = timezone.now()
    with transaction.atomic():
        session = (
            TicketAccessSession.objects.select_for_update()
            .select_related("ticket")
            .filter(token_digest=_token_digest(raw_token))
            .first()
        )
        if (
            session is None
            or session.revoked_at is not None
            or session.expires_at <= now
            or session.ticket.activity_id != activity_id
            or session.ticket.state not in {Ticket.State.ISSUED, Ticket.State.CHECKED_IN}
        ):
            raise ValidationError(INVALID_TICKET_MESSAGE)
        session.last_seen_at = now
        with authority_write(TICKET_SESSION_STATE):
            session.save(update_fields=["last_seen_at"])
        return session


def revoke_ticket_session(
    session: TicketAccessSession, *, actor: Any, note: str = ""
) -> TicketAccessSession:
    current_actor = require_current_staff(actor)
    with transaction.atomic():
        locked = TicketAccessSession.objects.select_for_update().get(pk=session.pk)
        if locked.revoked_at is not None:
            return locked
        locked.revoked_at = timezone.now()
        with authority_write(TICKET_SESSION_STATE):
            locked.save(update_fields=["revoked_at"])
        AuditLog.objects.create(
            operator=current_actor,
            action_type=AuditLog.ActionType.TICKET_SESSION_REVOKE,
            target=f"TicketAccessSession:{locked.pk}",
            new_value=f"revoked_at={locked.revoked_at.isoformat()}",
            note=note[:1000],
        )
        return locked


def purge_expired_ticket_sessions(*, now: datetime | None = None) -> int:
    cutoff = now or timezone.now()
    deleted = 0
    with transaction.atomic(), authority_write(TICKET_SESSION_STATE):
        sessions = (
            TicketAccessSession.objects.select_for_update()
            .filter(expires_at__lte=cutoff)
            .order_by("pk")
        )
        for session in sessions:
            session.delete()
            deleted += 1
    return deleted
