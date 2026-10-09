from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import unquote, urlsplit

from accounts.services import require_current_admin, require_current_staff
from common.authority import TICKET_SESSION_STATE, TICKET_STATE, authority_write
from common.heartbeat import HEARTBEAT_INTERVAL
from common.models import AuditLog
from core.models import Activity
from core.policies import ActivityAction
from core.services import lock_activity_for_action
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import DatabaseError, transaction
from django.utils import timezone

from .models import Ticket, TicketAccessSession

TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
INVALID_TICKET_MESSAGE = "票据无效。"
_CREDENTIAL_PREFIX = "AF1.T"
_CURRENT_CREDENTIAL_VERSION = 2
_PUBLIC_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


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


def _new_public_code() -> str:
    while True:
        candidate = "".join(secrets.choice(_PUBLIC_CODE_ALPHABET) for _ in range(10))
        if not Ticket._base_manager.filter(public_code=candidate).exists():
            return candidate


def _credential_signature(public_code: str, version: int) -> str:
    message = f"{_CREDENTIAL_PREFIX}.{public_code}.{version}".encode("ascii")
    return hmac.new(settings.QR_SIGNING_KEY.encode("utf-8"), message, hashlib.sha256).hexdigest()[
        :32
    ]


def ticket_credential(ticket: Ticket) -> str:
    if not ticket.public_code:
        raise ValidationError(INVALID_TICKET_MESSAGE)
    signature = _credential_signature(ticket.public_code, ticket.credential_version)
    return f"{_CREDENTIAL_PREFIX}.{ticket.public_code}.{ticket.credential_version}.{signature}"


def _ticket_for_credential(raw_credential: Any) -> Ticket | None:
    if isinstance(raw_credential, str) and "://" in raw_credential:
        parsed = urlsplit(raw_credential)
        raw_credential = unquote(parsed.fragment or parsed.path.rsplit("/", 1)[-1])
    if isinstance(raw_credential, str) and raw_credential.startswith(f"{_CREDENTIAL_PREFIX}."):
        parts = raw_credential.split(".")
        if len(parts) != 5 or parts[0] != "AF1" or parts[1] != "T":
            return None
        _, _, public_code, version_text, signature = parts
        if not public_code.isalnum() or not version_text.isdigit() or len(signature) != 32:
            return None
        version = int(version_text)
        expected = _credential_signature(public_code, version)
        if not hmac.compare_digest(signature, expected):
            return None
        return (
            Ticket.objects.select_related("activity")
            .filter(public_code=public_code, credential_version=version)
            .first()
        )
    # Once a ticket has a versioned public credential, a rotated legacy secret
    # must never become a back door to the supposedly invalidated QR code.
    # `isascii` is part of the guard, not an optimisation: `_token_digest` hashes the
    # ASCII encoding, so an operator typing non-ASCII text into the manual check-in box
    # used to raise UnicodeEncodeError here — before `_validate_raw_token` could turn it
    # into the ordinary "invalid ticket" answer — and the server-rendered check-in page
    # does not catch ValueError, so the page returned 500 instead of rejecting the code.
    if (
        isinstance(raw_credential, str)
        and raw_credential
        and raw_credential.isascii()
        and Ticket.objects.filter(
            secret_digest=_token_digest(raw_credential),
            public_code__isnull=False,
            credential_version__gt=1,
        ).exists()
    ):
        return None
    try:
        raw_secret = _validate_raw_token(raw_credential)
    except ValidationError:
        return None
    return (
        Ticket.objects.select_related("activity")
        .filter(secret_digest=_token_digest(raw_secret))
        .first()
    )


def _credential_authorizes_ticket(raw_credential: Any, locked_ticket: Ticket) -> bool:
    """Whether ``raw_credential`` still authorises *this* ticket, judged after the lock.

    A credential has to be resolved before the row lock can be taken, and a rotation
    commits in the gap between the two: it bumps ``credential_version``, which is what
    makes the printed code dead. Checking only the locked row's ``state`` afterwards left
    that promise almost true — a check-in or a redemption that had already resolved the
    old code would still go through, and a redemption would even mint a fresh
    ``TicketAccessSession`` immediately after the rotation had revoked the old ones. The
    operator would see "reset, and the sessions are gone" while the database held a
    session created by the code they had just invalidated.

    Re-running the same resolution against the locked row is what makes the final
    authorization decision depend on the version the row holds *now*. ``state`` is
    re-checked separately by each caller, so revoke/void stay covered by their own
    guards.
    """
    resolved = _ticket_for_credential(raw_credential)
    return resolved is not None and resolved.pk == locked_ticket.pk


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
        if not locked_ticket.public_code:
            locked_ticket.public_code = _new_public_code()
        locked_ticket.credential_version = max(
            _CURRENT_CREDENTIAL_VERSION, locked_ticket.credential_version
        )
        locked_ticket.state = Ticket.State.ISSUED
        locked_ticket.issued_at = now
        locked_ticket.issued_by = current_actor
        locked_ticket.is_test_data = locked_activity.is_test_mode
        with authority_write(TICKET_STATE):
            locked_ticket.save(
                update_fields=[
                    "secret_digest",
                    "public_code",
                    "credential_version",
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
        return IssuedTicket(ticket=locked_ticket, secret=ticket_credential(locked_ticket))


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


@dataclass(frozen=True)
class CheckInOutcome:
    """What a check-in attempt actually did.

    GOAL §10.3 asks the door to show three states — 成功 / 已检票 / 无效 — and the caller
    cannot tell the first two apart from the ticket alone: an idempotent repeat returns the
    same ``CHECKED_IN`` row. ``already_checked_in`` is the missing bit, so the scanner can
    say "this one already went in at 19:04" instead of claiming a fresh success for a
    person walking past a second phone.
    """

    ticket: Ticket
    already_checked_in: bool


def check_in_ticket_outcome(
    raw_secret: str,
    *,
    actor: Any,
    request_meta: TicketRequestMeta | None = None,
) -> CheckInOutcome:
    current_actor = require_current_staff(actor)
    with transaction.atomic():
        candidate = _ticket_for_credential(raw_secret)
        if candidate is None:
            raise ValidationError(INVALID_TICKET_MESSAGE)
        lock_activity_for_action(candidate.activity, ActivityAction.CHECK_IN)
        locked_ticket = Ticket.objects.select_for_update().get(pk=candidate.pk)
        # Before the state, because a rotated credential is an invalid ticket even if the
        # row it used to point at has since been checked in by someone else.
        if not _credential_authorizes_ticket(raw_secret, locked_ticket):
            raise ValidationError(INVALID_TICKET_MESSAGE)
        if locked_ticket.state == Ticket.State.CHECKED_IN:
            return CheckInOutcome(ticket=locked_ticket, already_checked_in=True)
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
        return CheckInOutcome(ticket=locked_ticket, already_checked_in=False)


def check_in_ticket(
    raw_secret: str,
    *,
    actor: Any,
    request_meta: TicketRequestMeta | None = None,
) -> Ticket:
    """The ticket-only view of :func:`check_in_ticket_outcome`."""
    return check_in_ticket_outcome(raw_secret, actor=actor, request_meta=request_meta).ticket


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
            note=_with_ballot_invalidation(note, locked_ticket),
        )
        return locked_ticket


def _with_ballot_invalidation(note: str, ticket: Ticket) -> str:
    """Append the audience ballots this revocation takes out of the valid set.

    GOAL §9.1 makes a valid ticket the whole audience qualification and §9.3 divides by the
    session's *valid* ballot count, so revoking a ticket that already voted silently changes
    the published denominator. The ballot rows stay — they are the evidence of what happened
    at the door (§19.1) — which means the audit entry is the only place that records the
    change. Naming the sessions is what makes that change traceable afterwards.
    """
    from voting.models import VoteBallot

    session_ids = list(
        VoteBallot.objects.filter(ticket=ticket)
        .order_by("vote_session_id")
        .values_list("vote_session_id", flat=True)
        .distinct()
    )
    if not session_ids:
        return note[:1000]
    invalidated = "invalidated_ballots=" + ",".join(
        f"VoteSession:{session_id}" for session_id in session_ids
    )
    combined = f"{note}; {invalidated}" if note else invalidated
    return combined[:1000]


def redeem_ticket(
    raw_secret: str,
    *,
    request_meta: TicketRequestMeta | None = None,
) -> RedeemedTicketSession:
    now = timezone.now()
    with transaction.atomic():
        candidate = _ticket_for_credential(raw_secret)
        ticket = (
            Ticket.objects.select_for_update()
            .select_related("activity")
            .filter(pk=candidate.pk)
            .first()
            if candidate is not None
            else None
        )
        # The credential is re-resolved against the locked row, so a code rotated between
        # the two reads cannot produce a session — which is exactly what the rotation's
        # own comment promises when it revokes the sessions that code already produced.
        if (
            ticket is None
            or ticket.state not in {Ticket.State.ISSUED, Ticket.State.CHECKED_IN}
            or not _credential_authorizes_ticket(raw_secret, ticket)
        ):
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


def rotate_ticket_credential(ticket: Ticket, *, actor: Any) -> str:
    current_actor = require_current_staff(actor)
    with transaction.atomic():
        # Activity first, then the ticket row — the same order as `revoke_ticket` and
        # `revoke_ticket_session`. `submit_ballot` holds the activity lock and only then
        # locks the ticket, so taking the ticket first here (as this function used to)
        # formed an ABBA deadlock against a vote being cast at the same moment.
        lock_activity_for_action(_activity_for_ticket(ticket.pk), ActivityAction.MANAGE_TICKETS)
        locked = Ticket.objects.select_for_update().get(pk=ticket.pk)
        if locked.state not in {Ticket.State.ISSUED, Ticket.State.CHECKED_IN}:
            raise ValidationError("当前票据状态不能重置凭证。")
        if not locked.public_code:
            locked.public_code = _new_public_code()
        locked.credential_version += 1
        locked.secret_digest = None
        with authority_write(TICKET_STATE):
            locked.save(
                update_fields=["secret_digest", "public_code", "credential_version", "updated_at"]
            )
        # Rotating the credential invalidates the printed QR code, so it has to invalidate
        # the browser sessions that QR code already produced. Without this the reset only
        # stopped *future* redemptions: anyone who had already redeemed the leaked code
        # kept a working session for the rest of its TTL.
        now = timezone.now()
        live_sessions = list(
            TicketAccessSession.objects.select_for_update()
            .filter(ticket=locked, revoked_at__isnull=True, expires_at__gt=now)
            .order_by("pk")
        )
        for session in live_sessions:
            session.revoked_at = now
            with authority_write(TICKET_SESSION_STATE):
                session.save(update_fields=["revoked_at"])
            AuditLog.objects.create(
                operator=current_actor,
                action_type=AuditLog.ActionType.TICKET_SESSION_REVOKE,
                target=f"TicketAccessSession:{session.pk}",
                new_value=f"revoked_at={now.isoformat()}",
                note="credential rotated",
            )
        _audit_ticket(
            operator=current_actor,
            action_type=AuditLog.ActionType.TICKET_ISSUE,
            ticket=locked,
            note=(
                f"credential_version={locked.credential_version};"
                f"revoked_sessions={len(live_sessions)}"
            ),
        )
        return ticket_credential(locked)


def authenticate_ticket_session_for_mutation(
    raw_token: str,
    *,
    activity: Activity | int,
) -> TicketAccessSession:
    """Authoritative ticket-session check that holds the session row lock.

    Keep this for callers that must lock the session before their own write.
    Polling GETs must use :func:`authenticate_ticket_session_readonly` instead:
    this variant takes ``SELECT ... FOR UPDATE`` and writes ``last_seen_at``,
    which is wrong for a 2.5 s live poll.
    """
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


def authenticate_ticket_session_readonly(
    raw_token: str,
    *,
    activity: Activity | int,
) -> TicketAccessSession:
    """Read-only ticket-session authentication for polling GETs.

    One indexed SELECT with ``select_related("ticket")`` and the same validity
    rules as the mutation variant — token digest, revocation, expiry, activity
    scope and ticket state — but no ``select_for_update`` and no per-request
    ``last_seen_at`` write. Authoritative actions (``submit_ballot``, redeem,
    revoke) re-validate and re-lock inside their own transaction, so nothing here
    weakens them.
    """
    raw_token = _validate_raw_token(raw_token)
    activity_id = getattr(activity, "pk", activity)
    now = timezone.now()
    session = (
        TicketAccessSession.objects.select_related("ticket")
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
    _heartbeat_ticket_session(session, now=now)
    return session


def _heartbeat_ticket_session(session: TicketAccessSession, *, now: datetime) -> None:
    """Best-effort, throttled ``last_seen_at`` refresh for read-only polling."""
    last_seen = session.last_seen_at
    if last_seen is not None and now - last_seen < HEARTBEAT_INTERVAL:
        return
    try:
        with transaction.atomic(), authority_write(TICKET_SESSION_STATE):
            TicketAccessSession.objects.filter(pk=session.pk).update(last_seen_at=now)
    except DatabaseError:
        return
    session.last_seen_at = now


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
