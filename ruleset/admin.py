from django.contrib import admin

from .models import ContestRuleset, RulesetTemplate, RulesetVersion


@admin.register(RulesetTemplate)
class RulesetTemplateAdmin(admin.ModelAdmin):
    list_display = ("name", "schema_version", "status", "content_hash", "frozen_at")
    list_filter = ("status",)
    search_fields = ("name",)


@admin.register(ContestRuleset)
class ContestRulesetAdmin(admin.ModelAdmin):
    list_display = ("name", "activity", "source_template", "is_test_data")
    list_filter = ("is_test_data",)
    search_fields = ("name",)


@admin.register(RulesetVersion)
class RulesetVersionAdmin(admin.ModelAdmin):
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
