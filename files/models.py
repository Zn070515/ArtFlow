from typing import TYPE_CHECKING

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q


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
    group = models.ForeignKey(
        "singer_contest.Group",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="files",
    )

    if TYPE_CHECKING:
        group_id: int | None
        # Django creates this attname at runtime; pyright cannot see it.
        singer_registration_id: int | None

        def get_file_purpose_display(self) -> str: ...

    file = models.FileField(upload_to="submissions/%Y/%m/")
    # The metadata-free rendition of an image upload (GOAL §19.3). ``file`` stays private;
    # a caller whose only claim is ``is_public`` is served this instead. Empty for audio,
    # video, documents and anything Pillow could not decode.
    derivative = models.FileField(upload_to="derivatives/%Y/%m/", blank=True)
    original_name = models.CharField(max_length=255)
    file_size = models.IntegerField()
    file_purpose = models.CharField(max_length=24, choices=Purpose, default=Purpose.OTHER)
    is_public = models.BooleanField(default=False)
    # Questionnaire identity (§P5). A legacy upload has an empty ``question_key`` and is
    # still identified by its purpose; a questionnaire upload is identified by the question
    # it answers — which is what lets R1/R2/R3/R4 accompaniments exist at once, and why a
    # replacement demotes only its own question's previous file.
    question_key = models.CharField(max_length=100, blank=True, default="")
    source_ruleset_version = models.ForeignKey(
        "ruleset.RulesetVersion",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="submission_files",
    )
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
        # `common.views.controlled_media` resolves every `/media/...` request by looking the
        # stored path up exactly (`Q(file=path) | Q(derivative=path)`), and both columns are
        # plain FileFields: without these the one query every media byte goes through was a
        # full scan of the submissions table.
        indexes = [
            models.Index(fields=["file"], name="submissionfile_file_idx"),
            models.Index(fields=["derivative"], name="submissionfile_derivative_idx"),
        ]
        constraints = [
            # Two slots, not one: a legacy upload is unique per purpose, a questionnaire
            # upload is unique per question. Keeping them separate is what stops a second
            # accompaniment from replacing the first.
            models.UniqueConstraint(
                fields=["singer_registration", "file_purpose"],
                condition=models.Q(
                    is_current=True, singer_registration__isnull=False, question_key=""
                ),
                name="files_one_current_singer_purpose",
            ),
            models.UniqueConstraint(
                fields=["singer_registration", "question_key"],
                condition=models.Q(is_current=True, singer_registration__isnull=False)
                & ~models.Q(question_key=""),
                name="files_one_current_singer_question",
            ),
            models.UniqueConstraint(
                fields=["program", "file_purpose"],
                condition=models.Q(is_current=True, program__isnull=False),
                name="files_one_current_program_purpose",
            ),
            models.UniqueConstraint(
                fields=["group", "file_purpose"],
                condition=models.Q(is_current=True, group__isnull=False, question_key=""),
                name="files_one_current_group_purpose",
            ),
            models.UniqueConstraint(
                fields=["group", "question_key"],
                condition=models.Q(is_current=True, group__isnull=False)
                & ~models.Q(question_key=""),
                name="files_one_current_group_question",
            ),
            models.CheckConstraint(
                condition=(
                    (
                        Q(singer_registration__isnull=False)
                        & Q(program__isnull=True)
                        & Q(group__isnull=True)
                    )
                    | (
                        Q(singer_registration__isnull=True)
                        & Q(program__isnull=False)
                        & Q(group__isnull=True)
                    )
                    | (
                        Q(singer_registration__isnull=True)
                        & Q(program__isnull=True)
                        & Q(group__isnull=False)
                    )
                ),
                name="files_owner_subject_xor",
            ),
        ]

    def __str__(self):
        return self.original_name


class MaterialRequirement(models.Model):
    class AppliesTo(models.TextChoices):
        SINGER = "singer", "歌手比赛报名"
        PROGRAM = "program", "毕晚节目"
        GROUP = "group", "分组合唱组"

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
        constraints = [
            models.CheckConstraint(
                condition=(
                    (Q(singer_registration__isnull=False) & Q(program__isnull=True))
                    | (Q(singer_registration__isnull=True) & Q(program__isnull=False))
                ),
                name="staffnote_owner_singer_program_xor",
            ),
        ]

    def __str__(self):
        return f"{self.created_by}: {self.content[:50]}"


class MaterialCheck(models.Model):
    class Status(models.TextChoices):
        # "Not submitted" rather than "not uploaded": a check can now stand for a text
        # answer or a guest's name as easily as for a file, and the label is what the
        # participant reads. The stored value is unchanged.
        MISSING = "missing", "未提交"
        UPLOADED = "uploaded", "已提交，待审核"
        APPROVED = "approved", "已审核通过"
        NEEDS_SUPPLEMENT = "needs_supplement", "需补交"

    singer_registration = models.ForeignKey(
        "singer_contest.SingerRegistration",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="material_checks",
    )
    group = models.ForeignKey(
        "singer_contest.Group",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="material_checks",
    )

    if TYPE_CHECKING:
        group_id: int | None
    program = models.ForeignKey(
        "farewell_show.Program",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="material_checks",
    )
    item_name = models.CharField(max_length=100)
    # Questionnaire identity (§P5): the question this check is about, empty for a legacy
    # requirement-driven check. It exists from the moment questionnaire uploads do, because
    # a replacement has to reset the review of *its own* question — matching on purpose
    # alone would clear the review of all four rounds' accompaniments at once.
    question_key = models.CharField(max_length=100, blank=True, default="")
    source_ruleset_version = models.ForeignKey(
        "ruleset.RulesetVersion",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="material_checks",
    )
    file_purpose = models.CharField(
        max_length=24,
        choices=SubmissionFile.Purpose.choices,
        blank=True,
        default="",
        help_text=(
            "本检查项当前要求的文件用途快照（服务端维护）；非文件项为空。"
            "选手上传的用途以此为准，浏览器不得指定。"
        ),
    )
    # The purposes this check accepts, in preference order, for a question whose contract
    # is "audio OR video" (GOAL §6.7). `file_purpose` stays the first entry — the default a
    # single-purpose check has always had, and what a display shows — so this is empty for
    # every check that accepts exactly one kind of file.
    accepted_file_purposes = models.JSONField(default=list, blank=True)
    status = models.CharField(max_length=20, choices=Status, default=Status.MISSING)
    required = models.BooleanField(
        default=True,
        help_text="该检查项是否属于当前正式材料契约；可选问卷题不阻塞 Group READY。",
    )
    review_note = models.TextField(blank=True, default="")
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="reviewed_material_checks",
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    sort_order = models.IntegerField(default=0)

    class Meta:
        ordering = ["sort_order"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    (
                        Q(singer_registration__isnull=False)
                        & Q(program__isnull=True)
                        & Q(group__isnull=True)
                    )
                    | (
                        Q(singer_registration__isnull=True)
                        & Q(program__isnull=False)
                        & Q(group__isnull=True)
                    )
                    | (
                        Q(singer_registration__isnull=True)
                        & Q(program__isnull=True)
                        & Q(group__isnull=False)
                    )
                ),
                name="materialcheck_owner_subject_xor",
            ),
            # Two identities, like the files they track: a legacy requirement check is
            # unique per item name, a questionnaire check is unique per question. Without
            # the split, four rounds sharing one item name could not each hold a check.
            models.UniqueConstraint(
                fields=["singer_registration", "item_name"],
                condition=Q(singer_registration__isnull=False, question_key=""),
                name="materialcheck_unique_singer_item",
            ),
            models.UniqueConstraint(
                fields=["singer_registration", "question_key"],
                condition=Q(singer_registration__isnull=False) & ~Q(question_key=""),
                name="materialcheck_unique_singer_question",
            ),
            models.UniqueConstraint(
                fields=["program", "item_name"],
                condition=Q(program__isnull=False),
                name="materialcheck_unique_program_item",
            ),
            models.UniqueConstraint(
                fields=["group", "item_name"],
                condition=Q(group__isnull=False),
                name="materialcheck_unique_group_item",
            ),
        ]

    if TYPE_CHECKING:

        def get_status_display(self) -> str: ...

    def __str__(self):
        return f"{self.item_name} — {self.get_status_display()}"


class MaterialSlot(models.Model):
    class Category(models.TextChoices):
        ACCOMPANIMENT = "accompaniment", "伴奏"
        BACKGROUND_VIDEO = "background_video", "背景视频"
        PERFORMANCE_VIDEO = "performance_video", "演唱视频"
        PROGRAM_IMAGE = "program_image", "节目图片"
        LYRICS_SCRIPT = "lyrics_script", "歌词/台词"
        HOST_MATERIAL = "host_material", "主持稿素材"
        OTHER = "other", "其他附件"

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="material_slots"
    )
    round = models.ForeignKey(
        "singer_contest.ContestRound",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="material_slots",
    )
    singer_registration = models.ForeignKey(
        "singer_contest.SingerRegistration",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="material_slots",
    )
    program = models.ForeignKey(
        "farewell_show.Program",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="material_slots",
    )
    group = models.ForeignKey(
        "singer_contest.Group",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="material_slots",
    )
    category = models.CharField(max_length=24, choices=Category.choices)
    label = models.CharField(max_length=100)
    is_required = models.BooleanField(default=True)
    sequence = models.IntegerField(default=0)
    is_test_data = models.BooleanField(default=False)

    class Meta:
        ordering = ["sequence", "pk"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    (Q(singer_registration__isnull=True) & Q(program__isnull=True))
                    | (
                        Q(singer_registration__isnull=False)
                        & Q(program__isnull=True)
                        & Q(group__isnull=True)
                    )
                    | (
                        Q(singer_registration__isnull=True)
                        & Q(program__isnull=False)
                        & Q(group__isnull=True)
                    )
                    | (
                        Q(singer_registration__isnull=True)
                        & Q(program__isnull=True)
                        & Q(group__isnull=False)
                    )
                ),
                name="materialslot_owner_subject_xor",
            ),
        ]

    if TYPE_CHECKING:
        activity_id: int
        round_id: int | None
        singer_registration_id: int | None
        program_id: int | None
        group_id: int | None

    def clean(self):
        contest_round = self.round if self.round_id else None
        singer = self.singer_registration if self.singer_registration_id else None
        program = self.program if self.program_id else None
        group = self.group if self.group_id else None
        if self.activity_id and contest_round and contest_round.activity_id != self.activity_id:
            raise ValidationError("材料槽必须属于轮次所在活动。")
        if self.activity_id and singer and singer.activity_id != self.activity_id:
            raise ValidationError("材料槽所属报名必须属于同一活动。")
        if self.activity_id and program and program.activity_id != self.activity_id:
            raise ValidationError("材料槽所属节目必须属于同一活动。")
        if self.activity_id and group and group.stage.activity_id != self.activity_id:
            raise ValidationError("材料槽所属分组必须属于同一活动。")

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        target = self.singer_registration or self.program or self.group
        return f"{self.label} — {target or '通用槽位'}"
