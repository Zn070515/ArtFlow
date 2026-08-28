from django.conf import settings
from django.db import models

ARTICLE_TEMPLATE_BODY_HELP_TEXT = (
    "正文，用 {title}, {subtitle}, {date}, {time}, {venue}, {content}, {sign_off} " + "等占位符"
)


class ExportTask(models.Model):
    class ExportType(models.TextChoices):
        REGISTRATION_LIST = "registration_list", "报名名单"
        CONTACT_LIST = "contact_list", "联系方式表"
        MATERIAL_CHECKLIST = "material_checklist", "材料清单"
        PROGRAM_LIST = "program_list", "节目单"
        SCORE_TEMPLATE = "score_template", "评分表模板"
        PRELIMINARY_RESULT = "preliminary_result", "初赛成绩"
        SEMI_FINAL_RESULT = "semi_final_result", "复赛成绩"
        FINAL_RANKING = "final_ranking", "最终排名"
        ADVANCEMENT_LIST = "advancement_list", "晋级名单"
        VOTE_RESULT = "vote_result", "投票结果"
        AWARD_LIST = "award_list", "获奖名单"
        INCIDENT_LIST = "incident_list", "异常记录"

    class Format(models.TextChoices):
        XLSX = "xlsx", "Excel"
        DOCX = "docx", "Word"

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="export_tasks"
    )
    export_type = models.CharField(max_length=22, choices=ExportType)
    format = models.CharField(max_length=4, choices=Format, default=Format.XLSX)
    file = models.FileField(upload_to="exports/", blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="export_tasks"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.get_export_type_display()} ({self.get_format_display()})"


class ArticleTemplate(models.Model):
    class TemplateType(models.TextChoices):
        SINGER_REGISTRATION = "singer_registration", "歌手比赛报名开启"
        PRELIMINARY_NOTICE = "preliminary_notice", "初赛通知"
        SEMI_FINAL_NOTICE = "semi_final_notice", "复赛通知"
        AWARD_RESULT = "award_result", "获奖名单公示"
        VOTE_GUIDE = "vote_guide", "观众投票说明"
        PROGRAM_COLLECTION = "program_collection", "毕晚节目征集"
        PROGRAM_LIST_PUBLISH = "program_list_publish", "毕晚节目单发布"
        FAREWELL_REVIEW = "farewell_review", "毕晚活动回顾"
        REHEARSAL_NOTICE = "rehearsal_notice", "彩排通知"

    name = models.CharField(max_length=200)
    template_type = models.CharField(max_length=22, choices=TemplateType, unique=True)
    body = models.TextField(help_text=ARTICLE_TEMPLATE_BODY_HELP_TEXT)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name


class GeneratedDocument(models.Model):
    template = models.ForeignKey(
        ArticleTemplate, on_delete=models.SET_NULL, null=True, related_name="documents"
    )
    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="generated_docs"
    )
    title = models.CharField(max_length=200, blank=True)
    file = models.FileField(upload_to="generated/")
    is_test_data = models.BooleanField(default=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="generated_docs",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.title or f"Document {self.pk}"
