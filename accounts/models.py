from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    class Role(models.TextChoices):
        ADMIN = "admin", "管理员"
        STAFF = "staff", "工作人员"
        PARTICIPANT = "participant", "选手"

    role = models.CharField(max_length=16, choices=Role, default=Role.PARTICIPANT)

    @property
    def is_admin(self):
        return self.role == self.Role.ADMIN or self.is_superuser

    @property
    def is_staff_or_admin(self):
        return self.role in (self.Role.STAFF, self.Role.ADMIN) or self.is_superuser

    def save(self, *args, **kwargs):
        self.is_staff = self.is_superuser or self.role in (self.Role.STAFF, self.Role.ADMIN)
        super().save(*args, **kwargs)
