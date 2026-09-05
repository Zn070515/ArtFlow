from django.contrib import admin

from .models import ContestRuleset, RulesetTemplate, RulesetVersion


class ObservationOnlyAdmin(admin.ModelAdmin):
    """Expose frozen rules authority without allowing direct mutation."""

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


class MaintenanceMetadataAdmin(admin.ModelAdmin):
    """Allow descriptive maintenance while keeping authority fields service-owned."""

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(RulesetTemplate)
class RulesetTemplateAdmin(MaintenanceMetadataAdmin):
    list_display = (
        "name",
        "schema_version",
        "status",
        "capability_status",
        "is_available",
        "content_hash",
        "frozen_at",
    )
    list_filter = ("status", "capability_status", "is_available")
    search_fields = ("name",)
    readonly_fields = (
        "schema_version",
        "definition",
        "status",
        "builtin_key",
        "capability_status",
        "content_hash",
        "created_by",
        "frozen_by",
        "frozen_at",
        "created_at",
        "updated_at",
    )


@admin.register(ContestRuleset)
class ContestRulesetAdmin(MaintenanceMetadataAdmin):
    list_display = ("name", "activity", "source_template", "is_test_data")
    list_filter = ("is_test_data",)
    search_fields = ("name",)
    readonly_fields = (
        "activity",
        "source_template",
        "is_test_data",
        "stage_key",
        "round_keys",
        "announcement_blocks",
        "announcement_blocks_by_checkpoint",
        "vote_keys",
        "group_keys",
        "audience_keys",
        "created_by",
        "created_at",
        "updated_at",
    )


@admin.register(RulesetVersion)
class RulesetVersionAdmin(ObservationOnlyAdmin):
    list_display = (
        "ruleset",
        "version",
        "schema_version",
        "status",
        "is_current",
        "content_hash",
        "frozen_at",
    )
    list_filter = ("status", "is_current")
    readonly_fields = ("execution_plan",)
