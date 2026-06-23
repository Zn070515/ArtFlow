from django.contrib import admin

from .models import Activity


@admin.register(Activity)
class ActivityAdmin(admin.ModelAdmin):
    list_display = ["title", "activity_type", "phase", "is_test_mode", "is_locked", "created_at"]
    list_filter = ["activity_type", "phase", "is_test_mode"]
    search_fields = ["title"]
