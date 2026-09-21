from django.contrib import admin

from .models import Activity


@admin.register(Activity)
class ActivityAdmin(admin.ModelAdmin):
    list_display = [
        "title",
        "activity_type",
        "phase",
        "data_lifecycle",
        "is_test_mode",
        "is_locked",
        "created_at",
    ]
    list_filter = ["activity_type", "phase", "data_lifecycle", "is_test_mode"]
    search_fields = ["title"]
    readonly_fields = [
        "activity_type",
        "phase",
        "is_test_mode",
        "data_lifecycle",
        "is_locked",
        "locked_at",
        "locked_by",
    ]

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
