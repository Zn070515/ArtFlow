from __future__ import annotations

from common.models import AuditLog
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import Q, QuerySet

from .models import User


def _is_effective_admin(user: User) -> bool:
    return user.is_active and (user.role == User.Role.ADMIN or user.is_superuser)


def _effective_admin_queryset() -> QuerySet[User]:
    return User.objects.filter(is_active=True).filter(
        Q(role=User.Role.ADMIN) | Q(is_superuser=True)
    )


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
    locked.save()
    AuditLog.objects.create(
        operator=current_actor,
        action_type=AuditLog.ActionType.UPDATE_PERMISSION,
        target=f"User:{locked.pk}",
        old_value=f"active={was_active}",
        new_value=f"active={is_active}",
    )
    return locked
