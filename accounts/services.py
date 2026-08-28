from common.models import AuditLog
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction

from .models import User


def _ensure_another_active_admin(target: User) -> None:
    """Raise if demoting/deactivating ``target`` would strip the last active admin."""
    other_active_admin = (
        User.objects.filter(role=User.Role.ADMIN, is_active=True).exclude(pk=target.pk).exists()
    )
    if not other_active_admin:
        raise ValidationError("不能移除最后一个有效管理员。")


@transaction.atomic
def change_user_role(*, target: User, new_role: str, actor: User) -> User:
    """Change a user's ArtFlow role. Admin-only, audited domain entry point."""
    if not actor.is_admin:
        raise PermissionDenied("只有管理员可以修改用户角色。")
    if new_role not in User.Role.values:
        raise ValidationError("无效的角色。")
    locked = User.objects.select_for_update().get(pk=target.pk)
    if locked.role == new_role:
        return locked
    if locked.role == User.Role.ADMIN:
        # Demoting any real admin must not remove the last active one.
        _ensure_another_active_admin(locked)
    old_role = locked.role
    locked.role = new_role
    locked.save()  # Model.save() keeps is_staff in sync with the new role.
    AuditLog.objects.create(
        operator=actor,
        action_type=AuditLog.ActionType.UPDATE_PERMISSION,
        target=f"User:{locked.pk}",
        old_value=old_role,
        new_value=new_role,
    )
    return locked


@transaction.atomic
def set_user_active(*, target: User, is_active: bool, actor: User) -> User:
    """Enable or disable a user account. Admin-only, audited domain entry point."""
    if not actor.is_admin:
        raise PermissionDenied("只有管理员可以修改用户状态。")
    locked = User.objects.select_for_update().get(pk=target.pk)
    if locked.is_active == is_active:
        return locked
    if not is_active and locked.role == User.Role.ADMIN:
        _ensure_another_active_admin(locked)
    was_active = locked.is_active
    locked.is_active = is_active
    locked.save()
    AuditLog.objects.create(
        operator=actor,
        action_type=AuditLog.ActionType.UPDATE_PERMISSION,
        target=f"User:{locked.pk}",
        old_value=f"active={was_active}",
        new_value=f"active={is_active}",
    )
    return locked
