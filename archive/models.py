from django.conf import settings
from django.db import models
from django.db.models import Q


class ArchivePackage(models.Model):
    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="archive_packages"
    )
    file = models.FileField(upload_to="archives/", blank=True)
    includes = models.TextField(blank=True, help_text="包内包含的文件清单")
    note = models.TextField(blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="archive_packages",
    )
    version = models.PositiveIntegerField(default=1, help_text="同一活动的归档包版本号")
    is_current = models.BooleanField(default=True, help_text="是否当前正式归档包")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["activity", "version"],
                name="archive_unique_version_per_activity",
            ),
            models.UniqueConstraint(
                fields=["activity"],
                condition=Q(is_current=True),
                name="archive_one_current_per_activity",
            ),
        ]

    def __str__(self):
        return f"{self.activity.title} — 归档包 ({self.created_at:%Y-%m-%d})"
