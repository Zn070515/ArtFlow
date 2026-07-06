from django.contrib import admin

from .models import Activity, ActivityPhase, QRCodeLink


@admin.register(Activity)
class ActivityAdmin(admin.ModelAdmin):
    list_display = ["title", "activity_type", "phase", "is_test_mode", "is_locked", "created_at"]
    list_filter = ["activity_type", "phase", "is_test_mode"]
    search_fields = ["title"]


@admin.register(ActivityPhase)
class ActivityPhaseAdmin(admin.ModelAdmin):
    list_display = ["activity", "phase", "name", "starts_at", "ends_at", "sort_order"]
    list_filter = ["phase"]
    search_fields = ["activity__title", "name"]


@admin.register(QRCodeLink)
class QRCodeLinkAdmin(admin.ModelAdmin):
    list_display = ["activity", "kind", "title", "target_url", "created_at"]
    list_filter = ["kind"]
    search_fields = ["activity__title", "title", "target_url"]
