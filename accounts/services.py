from __future__ import annotations

from datetime import datetime
from datetime import timezone as dt_timezone

from common.authority import ACCOUNT_AUTHORITY, authority_write
from common.models import AuditLog
from django.conf import settings
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import Q, QuerySet
from django.utils import timezone

from .models import InstallationState, User


def _current_user(actor) -> User:
    actor_pk = getattr(actor, "pk", None)
    if not actor_pk:
        raise PermissionDenied("当前操作者无有效账户。")
    try:
        return User.objects.get(pk=actor_pk)
    except User.DoesNotExist:
        raise PermissionDenied("当前操作者账户不存在。") from None


def require_current_admin(actor) -> User:
    """Re-read and authorize an active admin for a terminal operation."""
    current = _current_user(actor)
    if not current.is_active or not current.is_admin:
        raise PermissionDenied("只有当前有效管理员可以执行该终局操作。")
    return current


def require_current_staff(actor) -> User:
    """Re-read and authorize an active staff/admin for operational work."""
    current = _current_user(actor)
    if not current.is_active or not current.is_staff_or_admin:
        raise PermissionDenied("只有当前有效工作人员可以执行该操作。")
    return current


def _verification_ttl_seconds() -> int:
    return int(settings.ADMIN_VERIFICATION_TTL_SECONDS)


def mark_admin_verified(session) -> None:
    """Record an admin's elevated second-factor verification on the session."""
    session["artflow_admin_verified"] = True
    session["artflow_admin_verified_at"] = timezone.now().isoformat()


def admin_verification_is_valid(session) -> bool:
    """Whether the session still holds an unexpired elevated verification.

    The marker is valid only if it exists AND its timestamp is within the
    configured TTL window (honoring the server clock, not the session age).
    """
    if not session.get("artflow_admin_verified"):
        return False
    marker = session.get("artflow_admin_verified_at")
    if not marker:
        return False
    try:
        verified_at = datetime.fromisoformat(marker)
    except (TypeError, ValueError):
        return False
    if timezone.is_naive(verified_at):
        verified_at = timezone.make_aware(verified_at, dt_timezone.utc)
    elapsed = (timezone.now() - verified_at).total_seconds()
    return elapsed <= _verification_ttl_seconds()


def expire_admin_verification(session) -> None:
    """Drop the elevated marker so the admin must re-authenticate."""
    session.pop("artflow_admin_verified", None)
    session.pop("artflow_admin_verified_at", None)


def _is_effective_admin(user: User) -> bool:
    return user.is_active and (user.role == User.Role.ADMIN or user.is_superuser)


def _effective_admin_queryset() -> QuerySet[User]:
    return User.objects.filter(is_active=True).filter(
        Q(role=User.Role.ADMIN) | Q(is_superuser=True)
    )


def installation_provisioning_status() -> str:
    """Return a non-secret status for the first-admin provisioning boundary."""
    state = InstallationState.objects.filter(pk=InstallationState.SINGLETON_PK).first()
    if state is None:
        return "unavailable"
    has_effective_admin = _effective_admin_queryset().exists()
    if state.initialized_at and has_effective_admin:
        return "complete"
    if not state.initialized_at and not has_effective_admin:
        return "required"
    return "inconsistent"


@transaction.atomic
def provision_first_admin(*, username: str, password: str) -> User:
    """Create the first role-based admin exactly once.

    This is the commercial/bootstrap authority boundary. It deliberately has
    no reset or force mode and never creates a superuser.
    """
    state = InstallationState.objects.select_for_update().get(pk=InstallationState.SINGLETON_PK)
    if state.initialized_at:
        raise ValidationError("首次管理员 provisioning 已完成，不能重置或重复创建。")
    if _effective_admin_queryset().exists():
        raise ValidationError("已有有效管理员，不能执行首次管理员 provisioning。")

    normalized_username = username.strip()
    if not normalized_username:
        raise ValidationError("用户名不能为空。")
    if not password:
        raise ValidationError("密码不能为空。")
    if User.objects.filter(username=normalized_username).exists():
        raise ValidationError("用户名已存在。")

    candidate = User(username=normalized_username, role=User.Role.ADMIN, is_active=True)
    candidate.set_password(password)
    candidate.full_clean()
    validate_password(password, user=candidate)

    with authority_write(ACCOUNT_AUTHORITY):
        candidate.save(force_insert=True)
        state.initialized_at = timezone.now()
        state.save(update_fields=["initialized_at"])

    AuditLog.objects.create(
        operator=None,
        action_type=AuditLog.ActionType.INITIAL_ADMIN_PROVISION,
        target=f"User:{candidate.pk}",
        new_value=f"username={candidate.username}",
        note="bootstrap_first_admin",
    )
    return candidate


def _lock_admin_authority_line(*extra_pks: int) -> None:
    """Serialize every effective-admin mutation by locking the whole line.

    Only call inside transaction.atomic. Locks all current effective admins plus
    the caller-provided rows deterministically by pk, so two concurrent admin
    mutations (e.g. mutual demotion or deactivation) never both read a stale
    snapshot where each still sees a surviving admin. Without this, the
    "another admin exists" check can pass for both sides and leave zero admins.
    """
    pks = set(_effective_admin_queryset().values_list("pk", flat=True))
    pks.update(extra_pks)
    list(
        User.objects.select_for_update()
        .filter(pk__in=sorted(pks))
        .order_by("pk")
        .values_list("pk", flat=True)
    )


def _ensure_another_effective_admin(excluding_pk: int) -> None:
    if _effective_admin_queryset().exclude(pk=excluding_pk).exists():
        return
    raise ValidationError("不能移除最后一个有效管理员。")


@transaction.atomic
def change_user_role(*, target: User, new_role: str, actor: User) -> User:
    """Change a user's ArtFlow role. Admin-only, audited domain entry point."""
    if new_role not in User.Role.values:
        raise ValidationError("无效的角色。")
    _lock_admin_authority_line(actor.pk, target.pk)
    current_actor = User.objects.get(pk=actor.pk)
    if not current_actor.is_active or not current_actor.is_admin:
        raise PermissionDenied("只有管理员可以修改用户角色。")
    locked = User.objects.get(pk=target.pk)
    if locked.role == new_role:
        return locked
    if _is_effective_admin(locked) and not (new_role == User.Role.ADMIN or locked.is_superuser):
        # Demoting a real admin to a non-admin role removes it from the
        # effective-admin set; refuse if that would leave no effective admin.
        _ensure_another_effective_admin(locked.pk)
    old_role = locked.role
    locked.role = new_role
    with authority_write(ACCOUNT_AUTHORITY):
        locked.save()  # Model.save() keeps is_staff in sync with the new role.
    AuditLog.objects.create(
        operator=current_actor,
        action_type=AuditLog.ActionType.UPDATE_PERMISSION,
        target=f"User:{locked.pk}",
        old_value=old_role,
        new_value=new_role,
    )
    return locked


@transaction.atomic
def set_user_active(*, target: User, is_active: bool, actor: User) -> User:
    """Enable or disable a user account. Admin-only, audited domain entry point."""
    _lock_admin_authority_line(actor.pk, target.pk)
    current_actor = User.objects.get(pk=actor.pk)
    if not current_actor.is_active or not current_actor.is_admin:
        raise PermissionDenied("只有管理员可以修改用户状态。")
    locked = User.objects.get(pk=target.pk)
    if locked.is_active == is_active:
        return locked
    if _is_effective_admin(locked) and not is_active:
        _ensure_another_effective_admin(locked.pk)
    was_active = locked.is_active
    locked.is_active = is_active
    with authority_write(ACCOUNT_AUTHORITY):
        locked.save()
    AuditLog.objects.create(
        operator=current_actor,
        action_type=AuditLog.ActionType.UPDATE_PERMISSION,
        target=f"User:{locked.pk}",
        old_value=f"active={was_active}",
        new_value=f"active={is_active}",
    )
    return locked
