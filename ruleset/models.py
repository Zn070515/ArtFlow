from common.lifecycle import runtime_is_test
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q

from .schema import content_hash, parse_definition


class RulesetTemplate(models.Model):
    """Reusable blueprint for a contest ruleset (global, not activity-scoped)."""

    class Status(models.TextChoices):
        DRAFT = "draft", "草稿"
        FROZEN = "frozen", "已冻结"

    name = models.CharField(max_length=100)
    schema_version = models.PositiveIntegerField(default=1)
    definition = models.TextField(help_text="JSON ruleset definition (typed node graph).")
    description = models.TextField(blank=True)
    status = models.CharField(max_length=12, choices=Status, default=Status.DRAFT)
    content_hash = models.CharField(max_length=64, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="ruleset_templates",
    )
    frozen_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="frozen_ruleset_templates",
    )
    frozen_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def clean(self):
        parse_definition(self.definition)
        self.content_hash = content_hash(self.definition)

    def save(self, *args, **kwargs):
        self.clean()
        update_fields = kwargs.get("update_fields")
        if update_fields is not None and "content_hash" not in update_fields:
            kwargs["update_fields"] = [*update_fields, "content_hash"]
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.name} (v{self.schema_version})"


class ContestRuleset(models.Model):
    """An activity's actual rules, derived independently from a template (§8.7)."""

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="contest_rulesets"
    )
    name = models.CharField(max_length=100)
    source_template = models.ForeignKey(
        RulesetTemplate,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="derived_rulesets",
    )
    is_test_data = models.BooleanField(default=False)
    stage_key = models.CharField(
        max_length=100,
        blank=True,
        help_text="Bindable stage identifier, e.g. '院十佳'; drives auto re-resolve.",
    )
    round_keys = models.JSONField(
        default=dict,
        blank=True,
        help_text="Maps a ruleset round key to a ContestRound pk, e.g. {'r1': 3, 'r2': 5}.",
    )
    announcement_blocks = models.JSONField(
        default=list,
        blank=True,
        help_text="Handcard blocks: list of {label, outcome_codes} for the result board.",
    )
    vote_keys = models.JSONField(
        default=dict,
        blank=True,
        help_text="Maps a ruleset vote_source key to a VoteSession pk, e.g. {'audience1': 7}.",
    )
    group_keys = models.JSONField(
        default=dict,
        blank=True,
        help_text="Maps a group 'by' key to a ContestRound pk, e.g. {'initial_group': 3}.",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="contest_rulesets",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def clean(self):
        if self.activity_id:
            from core.models import Activity

            if self.activity.activity_type != Activity.Type.SINGER_CONTEST:
                raise ValidationError("赛制只能绑定歌手比赛活动。")
            if bool(self.is_test_data) != runtime_is_test(self.activity):
                raise ValidationError(
                    "A contest ruleset's test marker must match its activity lifecycle."
                )

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.name} — {self.activity.title}"


class RulesetVersionQuerySet(models.QuerySet):
    def _ensure_mutable(self):
        if self.filter(status=RulesetVersion.Status.FROZEN).exists():
            raise ValidationError("Frozen ruleset versions are immutable.")

    def update(self, **kwargs):
        self._ensure_mutable()
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        return super().bulk_update(objs, fields, *args, **kwargs)


RulesetVersionManager = models.Manager.from_queryset(RulesetVersionQuerySet)


class RulesetVersion(models.Model):
    """A versioned, frozen snapshot of a ruleset definition (§8.2)."""

    class Status(models.TextChoices):
        DRAFT = "draft", "草稿"
        FROZEN = "frozen", "已冻结"

    immutable_fields = (
        "definition",
        "schema_version",
        "content_hash",
        "status",
        "is_current",
        "binding",
    )

    ruleset = models.ForeignKey(ContestRuleset, on_delete=models.CASCADE, related_name="versions")
    version = models.PositiveIntegerField(default=1, help_text="Ruleset instance version counter")
    schema_version = models.PositiveIntegerField(
        default=1, help_text="Definition schema/ABI version"
    )
    definition = models.TextField(help_text="JSON ruleset definition (typed node graph).")
    content_hash = models.CharField(max_length=64, blank=True)
    binding = models.JSONField(
        default=dict,
        blank=True,
        help_text="Freeze-time binding snapshot: {stage_key, round_keys, announcement_blocks}.",
    )
    execution_plan = models.TextField(
        blank=True, editable=False, help_text="Canonical JSON ExecutionPlan persisted at freeze."
    )
    status = models.CharField(max_length=12, choices=Status, default=Status.DRAFT)
    is_current = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_ruleset_versions",
    )
    frozen_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="frozen_ruleset_versions",
    )
    frozen_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = RulesetVersionManager()

    class Meta:
        ordering = ["-version", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["ruleset", "version"],
                name="rulesetversion_unique_version_per_ruleset",
            ),
            models.UniqueConstraint(
                fields=["ruleset"],
                condition=Q(is_current=True),
                name="rulesetversion_one_current_per_ruleset",
            ),
        ]

    def _stored(self, fields):
        if self._state.adding or not self.pk:
            return None
        return type(self).objects.filter(pk=self.pk).values(*fields).first()

    def clean(self):
        stored = self._stored(self.immutable_fields)
        if stored and stored["status"] == self.Status.FROZEN:
            modified = [
                field for field in self.immutable_fields if getattr(self, field) != stored[field]
            ]
            if modified:
                raise ValidationError(
                    f"A frozen ruleset version is immutable (cannot change {modified})."
                )
        parse_definition(self.definition)
        self.content_hash = content_hash(self.definition)

    def save(self, *args, **kwargs):
        self.clean()
        update_fields = kwargs.get("update_fields")
        if update_fields is not None and "content_hash" not in update_fields:
            kwargs["update_fields"] = [*update_fields, "content_hash"]
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        stored_status = self._stored(["status"])
        if stored_status and stored_status["status"] == self.Status.FROZEN:
            raise ValidationError("A frozen ruleset version is immutable.")
        return super().delete(*args, **kwargs)

    def __str__(self):
        return f"{self.ruleset.name} — v{self.version}"
