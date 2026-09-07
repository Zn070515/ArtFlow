from typing import TYPE_CHECKING

from django.conf import settings
from django.db import models

if TYPE_CHECKING:
    from files.models import MaterialCheck, StaffNote, SubmissionFile


class Program(models.Model):
    class ProgramType(models.TextChoices):
        SONG = "song", "歌曲"
        DANCE = "dance", "舞蹈"
        INSTRUMENT = "instrument", "器乐"
        DRAMA = "drama", "戏剧/小品"
        RECITATION = "recitation", "朗诵"
        OTHER = "other", "其他"

    class Status(models.TextChoices):
        DRAFT = "draft", "草稿"
        SUBMITTED = "submitted", "已提交"
        APPROVED = "approved", "审核通过"
        REJECTED = "rejected", "审核未通过"
        WITHDRAWN = "withdrawn", "已撤回"

    activity = models.ForeignKey("core.Activity", on_delete=models.CASCADE, related_name="programs")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="programs"
    )

    name = models.CharField(max_length=200)
    program_type = models.CharField(max_length=20, choices=ProgramType)
    contact_name = models.CharField(max_length=100)
    contact_phone = models.CharField(max_length=20)
    class_name = models.CharField(max_length=100)
    performers = models.TextField(blank=True)
    estimated_duration = models.CharField(max_length=20, blank=True)
    description = models.TextField(blank=True)
    mic_requirements = models.TextField(blank=True)
    prop_requirements = models.TextField(blank=True)
    special_notes = models.TextField(blank=True)

    sort_order = models.IntegerField(default=0)
    status = models.CharField(max_length=20, choices=Status, default=Status.DRAFT)
    is_test_data = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    if TYPE_CHECKING:
        activity_id: int
        files: models.Manager[SubmissionFile]
        material_checks: models.Manager[MaterialCheck]
        staff_notes: models.Manager[StaffNote]

        def get_program_type_display(self) -> str: ...
        def get_status_display(self) -> str: ...

    class Meta:
        ordering = ["sort_order", "-created_at"]

    def __str__(self):
        return self.name
