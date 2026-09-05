from common.authority import ACCOUNT_AUTHORITY, authority_authorized, authority_write
from django.contrib.auth.models import AbstractUser, UserManager
from django.core.exceptions import ValidationError
from django.db import models


class UserAuthorityQuerySet(models.QuerySet):
    """Prevent ORM bypasses around account-bearing authority fields."""

    protected_fields = frozenset({"role", "is_active", "is_superuser", "is_staff"})

    def _ensure_authorized(self, fields) -> None:
        if self.protected_fields.intersection(fields) and not authority_authorized(ACCOUNT_AUTHORITY):
            raise ValidationError("账户权限只能通过授权账户服务修改。")

    def _ensure_initial_authority_authorized(self, users) -> None:
        if authority_authorized(ACCOUNT_AUTHORITY):
            return
        for user in users:
            if (
                user.role != self.model.Role.PARTICIPANT
                or not user.is_active
                or user.is_superuser
                or user.is_staff
            ):
                raise ValidationError("账户权限只能通过授权账户服务修改。")

    def update(self, **kwargs):
        self._ensure_authorized(kwargs)
        return super().update(**kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_authorized(fields)
        return super().bulk_update(objs, fields, *args, **kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        objs = list(objs)
        self._ensure_initial_authority_authorized(objs)
        if kwargs.get("update_conflicts"):
            self._ensure_authorized(kwargs.get("update_fields", ()))
        for user in objs:
            user.is_staff = user.is_superuser or user.role in (
                self.model.Role.STAFF,
                self.model.Role.ADMIN,
            )
        return super().bulk_create(objs, *args, **kwargs)


class UserAuthorityManager(UserManager.from_queryset(UserAuthorityQuerySet)):
    def create_superuser(self, username, email=None, password=None, **extra_fields):
        """Keep Django's technical superuser bootstrap on the explicit authority path."""
        with authority_write(ACCOUNT_AUTHORITY):
            return super().create_superuser(username, email, password, **extra_fields)


class User(AbstractUser):
    class Role(models.TextChoices):
        ADMIN = "admin", "管理员"
        STAFF = "staff", "工作人员"
        PARTICIPANT = "participant", "选手"

    role = models.CharField(max_length=16, choices=Role, default=Role.PARTICIPANT)
    objects = UserAuthorityManager()

    class Meta:
        base_manager_name = "objects"

    @property
    def is_admin(self):
        return self.role == self.Role.ADMIN or self.is_superuser

    @property
    def is_staff_or_admin(self):
        return self.role in (self.Role.STAFF, self.Role.ADMIN) or self.is_superuser

    def _ensure_protected_values_authorized(self) -> None:
        if authority_authorized(ACCOUNT_AUTHORITY):
            return
        if self._state.adding or not self.pk:
            if (
                self.role != self.Role.PARTICIPANT
                or not self.is_active
                or self.is_superuser
                or self.is_staff
            ):
                raise ValidationError("账户权限只能通过授权账户服务修改。")
            return
        stored = (
            type(self)
            ._base_manager.filter(pk=self.pk)
            .values("role", "is_active", "is_superuser")
            .first()
        )
        if stored and any(stored[field] != getattr(self, field) for field in stored):
            raise ValidationError("账户权限只能通过授权账户服务修改。")

    def save(self, *args, **kwargs):
        self._ensure_protected_values_authorized()
        self.is_staff = self.is_superuser or self.role in (self.Role.STAFF, self.Role.ADMIN)
        update_fields = kwargs.get("update_fields")
        if update_fields and {"role", "is_superuser"}.intersection(update_fields):
            kwargs["update_fields"] = set(update_fields) | {"is_staff"}
        super().save(*args, **kwargs)
