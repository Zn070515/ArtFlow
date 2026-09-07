import hashlib
import secrets
from dataclasses import dataclass
from datetime import timedelta

from accounts.services import require_current_staff
from common.authority import (
    ACCESS_GRANT_STATE,
    ENTRY_POINT_CONFIG,
    EPHEMERAL_SESSION_STATE,
    authority_write,
)
from common.models import AuditLog
from core.models import Activity
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone
from singer_contest.models import ContestRound

from .models import AccessGrant, EntryPoint, EphemeralSession

MAX_GRANT_TTL = timedelta(minutes=30)
MAX_SESSION_TTL = timedelta(minutes=15)


@dataclass(frozen=True)
class AccessRequestMeta:
    ip_address: str | None = None


@dataclass(frozen=True)
class IssuedAccessGrant:
    grant: AccessGrant
    token: str


@dataclass(frozen=True)
class RedeemedEphemeralSession:
    session: EphemeralSession
    token: str


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def create_entry_point(activity, *, kind, label, actor):
    current_actor = require_current_staff(actor)
    normalized_label = (label or "").strip()
    if not normalized_label:
        raise ValidationError("入口名称不能为空。")
    if kind not in EntryPoint.Kind.values:
        raise ValidationError("入口类型无效。")

    with transaction.atomic():
        locked_activity = Activity.objects.select_for_update().get(pk=activity.pk)
        entry_point = EntryPoint(
            activity=locked_activity,
            kind=kind,
            label=normalized_label,
            created_by=current_actor,
        )
        with authority_write(ENTRY_POINT_CONFIG):
            entry_point.save()
        return entry_point


def deactivate_entry_point(entry_point, *, actor):
    require_current_staff(actor)
    with transaction.atomic():
        locked = EntryPoint.objects.select_for_update().get(pk=entry_point.pk)
        if not locked.is_active:
            return locked
        locked.is_active = False
        with authority_write(ENTRY_POINT_CONFIG):
            locked.save(update_fields=["is_active"])
        return locked


def issue_access_grant(entry_point, *, actor, ttl, round=None):
    current_actor = require_current_staff(actor)
    if not isinstance(ttl, timedelta) or ttl <= timedelta(0) or ttl > MAX_GRANT_TTL:
        raise ValidationError("临时访问授权有效期必须大于 0 且不超过 30 分钟。")

    with transaction.atomic():
        locked_entry_point = (
            EntryPoint.objects.select_for_update().select_related("activity").get(pk=entry_point.pk)
        )
        if not locked_entry_point.is_active:
            raise ValidationError("入口已停用，不能签发临时访问授权。")
        round_id = getattr(round, "pk", round) if round is not None else None
        locked_round = None
        if round_id is not None:
            locked_round = ContestRound.objects.get(pk=round_id)
            if locked_round.activity_id != locked_entry_point.activity_id:
                raise ValidationError("临时访问授权轮次不属于入口活动。")

        raw_token = secrets.token_urlsafe(32)
        grant = AccessGrant(
            entry_point=locked_entry_point,
            kind=locked_entry_point.kind,
            activity=locked_entry_point.activity,
            round=locked_round,
            token_digest=_token_digest(raw_token),
            expires_at=timezone.now() + ttl,
            issued_by=current_actor,
        )
        with authority_write(ACCESS_GRANT_STATE):
            grant.save()
        AuditLog.objects.create(
            operator=current_actor,
            action_type=AuditLog.ActionType.ACCESS_GRANT_ISSUE,
            target=f"AccessGrant:{grant.pk}",
            new_value=(
                f"kind={grant.kind};activity={grant.activity_id};"
                f"round={grant.round_id or ''};expires_at={grant.expires_at.isoformat()}"
            ),
            note=f"entry_point={grant.entry_point_id}",
        )
        return IssuedAccessGrant(grant=grant, token=raw_token)


def redeem_access_grant(raw_token, *, request_meta=None):
    if not isinstance(raw_token, str) or not raw_token or len(raw_token) > 128:
        raise ValidationError("临时访问授权无效。")
    request_meta = request_meta or AccessRequestMeta()
    digest = _token_digest(raw_token)
    now = timezone.now()

    with transaction.atomic():
        grant = (
            AccessGrant.objects.select_for_update()
            .select_related("entry_point", "activity", "round")
            .filter(token_digest=digest)
            .first()
        )
        if (
            grant is None
            or grant.redeemed_at is not None
            or grant.revoked_at is not None
            or grant.expires_at <= now
        ):
            raise ValidationError("临时访问授权无效。")

        session_token = secrets.token_urlsafe(32)
        session = EphemeralSession(
            grant=grant,
            kind=grant.kind,
            activity=grant.activity,
            round=grant.round,
            token_digest=_token_digest(session_token),
            expires_at=min(now + MAX_SESSION_TTL, grant.expires_at),
        )
        with authority_write(EPHEMERAL_SESSION_STATE):
            session.save()
        grant.redeemed_at = now
        with authority_write(ACCESS_GRANT_STATE):
            grant.save(update_fields=["redeemed_at"])
        AuditLog.objects.create(
            operator=None,
            action_type=AuditLog.ActionType.ACCESS_GRANT_REDEEM,
            target=f"AccessGrant:{grant.pk}",
            new_value=f"session={session.pk};kind={session.kind};activity={session.activity_id}",
            ip_address=request_meta.ip_address,
        )
        return RedeemedEphemeralSession(session=session, token=session_token)


def authenticate_ephemeral_session(raw_token, *, expected_kind, activity, round=None):
    if not isinstance(raw_token, str) or not raw_token or len(raw_token) > 128:
        raise ValidationError("临时访问会话无效。")
    activity_id = getattr(activity, "pk", activity)
    round_id = getattr(round, "pk", round) if round is not None else None
    now = timezone.now()

    with transaction.atomic():
        session = (
            EphemeralSession.objects.select_for_update()
            .select_related("grant")
            .filter(token_digest=_token_digest(raw_token))
            .first()
        )
        if (
            session is None
            or session.revoked_at is not None
            or session.expires_at <= now
            or session.kind != expected_kind
            or session.activity_id != activity_id
            or session.round_id != round_id
        ):
            raise ValidationError("临时访问会话无效。")
        session.last_seen_at = now
        with authority_write(EPHEMERAL_SESSION_STATE):
            session.save(update_fields=["last_seen_at"])
        return session
