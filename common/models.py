from django.conf import settings
from django.contrib.contenttypes.models import ContentType
from django.db import models


class AuditLog(models.Model):
    class ActionType(models.TextChoices):
        LOGIN = "login", "用户登录"
        UPDATE_REGISTRATION = "update_registration", "修改报名"
        UPDATE_STATUS = "update_status", "修改状态"
        REVIEW_MATERIAL = "review_material", "审核材料"
        UPLOAD_FILE = "upload_file", "上传文件"
        DELETE_FILE = "delete_file", "删除文件"
        ENTER_SCORE = "enter_score", "录入/修改分数"
        EXPORT = "export", "导出文件"
        VOTE_MANAGE = "vote_manage", "创建/修改投票"
        PUBLISH_POST = "publish_post", "发布/隐藏公开内容"
        UNLOCK_RESULT = "unlock_result", "解锁结果"
        RELOCK_RESULT = "relock_result", "重新锁定结果"
        PHASE_TRANSITION = "phase_transition", "阶段变更"
        FINALIZE_ADVANCEMENT = "finalize_advancement", "核定晋级名单"
        UPDATE_PERMISSION = "update_permission", "修改用户权限"
        ARCHIVE_ACTIVITY = "archive_activity", "归档活动"
        OTHER = "other", "其他"

    operator = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="audit_logs"
    )
    action_type = models.CharField(max_length=22, choices=ActionType, default=ActionType.OTHER)
    target = models.CharField(max_length=200, blank=True, help_text="操作对象描述")
    old_value = models.TextField(blank=True)
    new_value = models.TextField(blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    note = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return (
            f"{self.operator} {self.get_action_type_display()} {self.target} "
            f"({self.created_at:%Y-%m-%d %H:%M})"
        )


class SeedRecord(models.Model):
    key = models.CharField(max_length=100, unique=True)
    content_type = models.ForeignKey(
        ContentType,
        on_delete=models.PROTECT,
        related_name="seed_records",
    )
    object_id = models.PositiveBigIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["content_type", "object_id"],
                name="common_seedrecord_unique_owned_object",
            )
        ]

    def __str__(self) -> str:
        return self.key
