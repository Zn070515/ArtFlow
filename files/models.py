from django.conf import settings
from django.db import models


class SubmissionFile(models.Model):
    class Purpose(models.TextChoices):
        ACCOMPANIMENT = "accompaniment", "伴奏"
        BACKGROUND_VIDEO = "background_video", "背景视频"
        PERFORMANCE_VIDEO = "performance_video", "演唱视频"
        PROGRAM_IMAGE = "program_image", "节目图片"
        LYRICS_SCRIPT = "lyrics_script", "歌词/台词"
        HOST_MATERIAL = "host_material", "主持稿素材"
        PUBLIC_IMAGE = "public_image", "公开首页图片"
        SHOWCASE_IMAGE = "showcase_image", "往届风采图片"
        OTHER = "other", "其他附件"

    singer_registration = models.ForeignKey(
        "singer_contest.SingerRegistration",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="files",
    )
    program = models.ForeignKey(
        "farewell_show.Program",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="files",
    )
    file = models.FileField(upload_to="submissions/%Y/%m/")
    original_name = models.CharField(max_length=255)
    file_size = models.IntegerField()
    file_purpose = models.CharField(max_length=24, choices=Purpose, default=Purpose.OTHER)
    is_public = models.BooleanField(default=False)
    is_test_data = models.BooleanField(default=False)
    is_current = models.BooleanField(default=True)
    version = models.PositiveIntegerField(default=1)
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="uploaded_files",
    )
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["singer_registration", "file_purpose"],
                condition=models.Q(is_current=True, singer_registration__isnull=False),
                name="files_one_current_singer_purpose",
            ),
            models.UniqueConstraint(
                fields=["program", "file_purpose"],
                condition=models.Q(is_current=True, program__isnull=False),
                name="files_one_current_program_purpose",
            ),
        ]

    def __str__(self):
        return self.original_name


class MaterialRequirement(models.Model):
    class AppliesTo(models.TextChoices):
        SINGER = "singer", "歌手比赛报名"
        PROGRAM = "program", "毕晚节目"

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="material_requirements"
    )
    applies_to = models.CharField(max_length=12, choices=AppliesTo.choices)
    item_name = models.CharField(max_length=100)
    file_purpose = models.CharField(
        max_length=24, choices=SubmissionFile.Purpose.choices, blank=True
    )
    is_required = models.BooleanField(default=True)
    sort_order = models.IntegerField(default=0)

    class Meta:
        ordering = ["sort_order", "pk"]
        unique_together = [("activity", "applies_to", "item_name")]

    def __str__(self):
        return self.item_name


class StaffNote(models.Model):
    singer_registration = models.ForeignKey(
        "singer_contest.SingerRegistration",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="staff_notes",
    )
    program = models.ForeignKey(
        "farewell_show.Program",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="staff_notes",
    )
    content = models.TextField()
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="staff_notes"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.created_by}: {self.content[:50]}"


class MaterialCheck(models.Model):
    class Status(models.TextChoices):
        MISSING = "missing", "未上传"
        UPLOADED = "uploaded", "已上传"
        REVIEWED = "reviewed", "已审核"

    singer_registration = models.ForeignKey(
        "singer_contest.SingerRegistration",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="material_checks",
    )
    program = models.ForeignKey(
        "farewell_show.Program",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="material_checks",
    )
    item_name = models.CharField(max_length=100)
    status = models.CharField(max_length=12, choices=Status, default=Status.MISSING)
    sort_order = models.IntegerField(default=0)

    class Meta:
        ordering = ["sort_order"]

    def __str__(self):
        return f"{self.item_name} — {self.get_status_display()}"
