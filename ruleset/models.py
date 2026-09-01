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
    announcement_blocks_by_checkpoint = models.JSONField(
        default=dict,
        blank=True,
        help_text=(
            "Checkpoint-specific handcard blocks: {checkpoint_key: [{label, "
            "outcome_codes}, ...]}. Overrides announcement_blocks for that stage."
        ),
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
        constraints = [
            # M1-R9-Final: an activity owns exactly one ContestRuleset authority (versions
            # hold the history). The DB unique is the backstop behind the service reuse.
            models.UniqueConstraint(fields=["activity"], name="contest_ruleset_unique_activity"),
        ]

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

    def _forbid_terminal_transition(self, **kwargs):
        """A DRAFT->FROZEN/current ORM transition is service-only (freeze_ruleset_version)."""
        if kwargs.get("status") == RulesetVersion.Status.FROZEN or kwargs.get("is_current") is True:
            raise ValidationError("只有冻结服务可以产生已冻结/当前赛制版本。")

    def create(self, **kwargs):
        allow_freeze = kwargs.pop("_allow_freeze", False)
        obj = self.model(**kwargs)
        obj.save(force_insert=True, using=self.db, _allow_freeze=allow_freeze)
        return obj

    def update(self, **kwargs):
        allow_freeze = kwargs.pop("_allow_freeze", False)
        self._ensure_mutable()
        if not allow_freeze:
            self._forbid_terminal_transition(**kwargs)
        return super().update(**kwargs)

    def delete(self):
        self._ensure_mutable()
        return super().delete()

    def bulk_update(self, objs, fields, *args, **kwargs):
        self._ensure_mutable()
        if "status" in fields or "is_current" in fields:
            raise ValidationError("赛制版本最终状态跃迁是 service-only。")
        return super().bulk_update(objs, fields, *args, **kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        if any(o.status == RulesetVersion.Status.FROZEN or o.is_current for o in objs):
            raise ValidationError("只有冻结服务可以产生已冻结/当前赛制版本。")
        return super().bulk_create(objs, *args, **kwargs)


RulesetVersionManager = models.Manager.from_queryset(RulesetVersionQuerySet)


class RulesetVersion(models.Model):
    """A versioned, frozen snapshot of a ruleset definition (§8.2)."""

    class Status(models.TextChoices):
        DRAFT = "draft", "草稿"
        FROZEN = "frozen", "已冻结"

    immutable_fields = (
        "ruleset_id",
        "version",
        "schema_version",
        "definition",
        "content_hash",
        "authority_hash",
        "binding",
        "execution_plan",
        "status",
        "is_current",
        "created_by_id",
        "frozen_by_id",
        "frozen_at",
    )

    ruleset = models.ForeignKey(ContestRuleset, on_delete=models.CASCADE, related_name="versions")
    version = models.PositiveIntegerField(default=1, help_text="Ruleset instance version counter")
    schema_version = models.PositiveIntegerField(
        default=1, help_text="Definition schema/ABI version"
    )
    definition = models.TextField(help_text="JSON ruleset definition (typed node graph).")
    content_hash = models.CharField(max_length=64, blank=True)
    authority_hash = models.CharField(
        max_length=64,
        blank=True,
        help_text="sha256 of definition + frozen binding + plan version; the authority digest.",
    )
    binding = models.JSONField(
        default=dict,
        blank=True,
        help_text="Freeze-time binding snapshot: {stage_key, round_keys, announcement_blocks}.",
    )
    execution_plan = models.TextField(
        blank=True, editable=False, help_text="Canonical JSON ExecutionPlan persisted at freeze."
    )
    status = models.CharField(max_length=12, choices=Status, default=Status.DRAFT)
    # M1-R9 (§四): ``is_current`` means *current official FROZEN authority*. A fresh
    # version is a DRAFT draft, so it must be non-current until frozen — the old
    # default=True silently made a bare ``create()`` a "Draft official authority" that
    # could shadow the next real freeze's partial-unique and inject a false authority.
    is_current = models.BooleanField(default=False)
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
            # M1-R9 (§四): a DB invariant — only a FROZEN version may be marked
            # current. A DRAFT ``is_current=True`` row (from the historical
            # ``default=True``) is invalid authority and must be demoted at migration.
            models.CheckConstraint(
                condition=Q(is_current=False) | Q(status="frozen"),
                name="rulesetversion_current_implies_frozen",
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
        allow_freeze = kwargs.pop("_allow_freeze", False)
        self.clean()
        stored = self._stored(["status"])
        if self._state.adding:
            if not allow_freeze and (self.status == self.Status.FROZEN or self.is_current):
                raise ValidationError("只在冻结服务中产生已冻结/当前赛制版本。")
        elif (
            not allow_freeze
            and stored
            and stored["status"] != self.Status.FROZEN
            and (self.status == self.Status.FROZEN or self.is_current)
        ):
            raise ValidationError("只能通过冻结服务将赛制版本置为已冻结/当前。")
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
